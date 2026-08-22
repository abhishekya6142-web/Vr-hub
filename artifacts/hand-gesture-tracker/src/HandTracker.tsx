// hand tracking - Fast, Smooth & Lag-Free Precision Laser
import { useEffect, useRef, useState } from 'react';
import { xrPoseEngine } from './vr-hub/xr-pose-engine';
import { xrCameraSource } from './vr-hub/xr-camera-source';

declare global {
  interface Window {
    Hands: any;
    Camera: any;
  }
}

// =====================================================================
// ⚙️ SETTINGS — OPTIMIZED FOR SPEED & SMOOTHNESS
// =====================================================================

const DEBUG_HAND_TRACKING = false;

const MIN_DETECTION_CONFIDENCE = 0.65;
const MIN_TRACKING_CONFIDENCE = 0.55;
const MAX_NUM_HANDS = 1;

const PINCH_ENTER_THRESHOLD = 0.20;
const PINCH_EXIT_THRESHOLD = 0.35;
const PINCH_DEBOUNCE_FRAMES = 2;

const MIN_HAND_SIZE = 0.08;
const CONFIDENCE_THRESHOLD = 0.8;
const FREEZE_MS = 200;

const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 480;

// Internal process downscale for ML speed
const MP_PROCESS_WIDTH = 640;
const MP_PROCESS_HEIGHT = 480;
const PROCESS_INTERVAL = 1000 / 30; // Max ~30 FPS for MediaPipe processing

// Higher alpha = Fast & Snappy movement with low lag
const SMOOTHING_ALPHA = 0.65; 

// =====================================================================

type Landmark = { x: number; y: number; z: number };

function dist(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

type PxPoint = { x: number; y: number };

function pxDist(a: PxPoint, b: PxPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

type HandSlot = {
  smoothedOrigin: PxPoint;
  smoothedDir: PxPoint;
  smoothedTarget: PxPoint;
  isPinching: boolean;
  lastGoodTime: number;
  pendingPinchCount: number;
  debugInfo?: {
    thumbTipSc: PxPoint;
    indexTipSc: PxPoint;
    wristSc: PxPoint;
    middleMcpSc: PxPoint;
  };
};

type PinchMarker = { x: number; y: number };

type HandTrackerProps = {
  onPinchMarkers?: (markers: PinchMarker[]) => void;
  onPointMarkers?: (markers: PinchMarker[]) => void;
  onReady?: () => void;
};

export default function HandTracker({ onPinchMarkers, onPointMarkers, onReady }: HandTrackerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [, setStatus] = useState<string>('Requesting camera access...');

  const onPinchMarkersRef = useRef(onPinchMarkers);
  onPinchMarkersRef.current = onPinchMarkers;
  const onPointMarkersRef = useRef(onPointMarkers);
  onPointMarkersRef.current = onPointMarkers;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    let camera: { stop: () => void } | undefined;
    let hands: any;
    let cancelled = false;

    // Fixed-size canvas strictly for downsampled ML processing
    const mpCanvas = document.createElement('canvas');
    mpCanvas.width = MP_PROCESS_WIDTH;
    mpCanvas.height = MP_PROCESS_HEIGHT;
    const mpCtx = mpCanvas.getContext('2d', { willReadFrequently: true });

    // Track original camera source dimensions for accurate screen mapping
    let currentSourceW = window.innerWidth;
    let currentSourceH = window.innerHeight;

    function useXRCameraSource() {
      return xrPoseEngine.isActive() && xrCameraSource.isSupported();
    }

    let handSlots: HandSlot[] = [];

    // Resize visually without triggering onResults allocations
    function resizeCanvas() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
    }

    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('orientationchange', resizeCanvas);
    resizeCanvas();

    async function start() {
      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (!canvas) return;

      if (typeof window.Hands === 'undefined') {
        if (!cancelled) setStatus('Failed to load MediaPipe Hands. Reload page.');
        return;
      }

      hands = new window.Hands({
        locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });

      hands.setOptions({
        maxNumHands: MAX_NUM_HANDS,
        modelComplexity: 0,
        minDetectionConfidence: MIN_DETECTION_CONFIDENCE,
        minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
      });

      hands.onResults((results: any) => {
        if (cancelled) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const screenW = window.innerWidth;
        const screenH = window.innerHeight;
        const dpr = window.devicePixelRatio || 1;

        // Clear cleanly using full physical pixels, then reset to logical scaling
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const now = Date.now();
        const landmarkSets: Landmark[][] = results.multiHandLandmarks || [];
        const handednessSets: any[] = results.multiHandedness || [];
        const markers: PinchMarker[] = [];
        const pointMarkers: PinchMarker[] = [];

        // 1. DYNAMIC COORDINATE MAPPING (Object-Cover scale preservation)
        const sourceW = currentSourceW;
        const sourceH = currentSourceH;
        
        const scale = Math.max(screenW / sourceW, screenH / sourceH);
        const offsetX = (screenW - sourceW * scale) / 2;
        const offsetY = (screenH - sourceH * scale) / 2;

        const toScreen = (lm: Landmark): PxPoint => ({
          x: lm.x * sourceW * scale + offsetX,
          y: lm.y * sourceH * scale + offsetY,
        });

        type Detection = {
          originPx: PxPoint;
          rawDir: PxPoint;
          rayLength: number;
          targetPx: PxPoint;
          pinchRatio: number;
          confident: boolean;
          debugInfo: { thumbTipSc: PxPoint; indexTipSc: PxPoint; wristSc: PxPoint; middleMcpSc: PxPoint; };
        };
        const detections: Detection[] = [];

        for (let i = 0; i < landmarkSets.length; i++) {
          const landmarks = landmarkSets[i];
          const wrist = landmarks[0];
          const thumbTip = landmarks[4];
          const indexTip = landmarks[8];
          const middleMcp = landmarks[9];

          const handSize = dist(wrist, middleMcp);
          if (handSize < MIN_HAND_SIZE) continue;

          const pinchDistance = dist(thumbTip, indexTip);
          const pinchRatio = pinchDistance / handSize;
          const confidence = handednessSets[i]?.score ?? 1;

          // Transform into unified screen-space FIRST to prevent aspect-ratio distortion
          const wristSc = toScreen(wrist);
          const thumbTipSc = toScreen(thumbTip);
          const indexTipSc = toScreen(indexTip);
          const middleMcpSc = toScreen(middleMcp);

          // ORIGIN: Space between thumb and index tip
          const originPx: PxPoint = {
            x: (thumbTipSc.x + indexTipSc.x) / 2,
            y: (thumbTipSc.y + indexTipSc.y) / 2,
          };

          // DIRECTION: Wrist (0) -> Middle MCP (9) 
          const dx = middleMcpSc.x - wristSc.x;
          const dy = middleMcpSc.y - wristSc.y;
          const len = Math.hypot(dx, dy) || 1;
          const rawDir: PxPoint = { x: dx / len, y: dy / len };

          // LASER LENGTH: ~50% of the smaller screen dimension
          const rayLength = Math.min(screenW, screenH) * 0.50; 

          const targetPx: PxPoint = {
            x: originPx.x + rawDir.x * rayLength,
            y: originPx.y + rawDir.y * rayLength,
          };

          detections.push({
            originPx,
            rawDir,
            rayLength,
            targetPx,
            pinchRatio,
            confident: confidence >= CONFIDENCE_THRESHOLD,
            debugInfo: { thumbTipSc, indexTipSc, wristSc, middleMcpSc }
          });
        }

        const unmatchedSlots = new Set(handSlots);
        const slotForDetection = new Map<Detection, HandSlot>();

        for (const detection of detections) {
          let best: HandSlot | null = null;
          let bestDist = Infinity;
          for (const slot of unmatchedSlots) {
            const d = pxDist(detection.originPx, slot.smoothedOrigin);
            if (d < bestDist) {
              bestDist = d;
              best = slot;
            }
          }
          if (best && bestDist <= screenW * 0.4) {
            slotForDetection.set(detection, best);
            unmatchedSlots.delete(best);
          }
        }

        for (const detection of detections) {
          let slot = slotForDetection.get(detection) ?? null;

          if (!slot) {
            if (!detection.confident) continue;
            const startsPinching = detection.pinchRatio < PINCH_ENTER_THRESHOLD;
            slot = {
              smoothedOrigin: { ...detection.originPx },
              smoothedDir: { ...detection.rawDir },
              smoothedTarget: { ...detection.targetPx },
              isPinching: startsPinching,
              lastGoodTime: now,
              pendingPinchCount: 0,
              debugInfo: detection.debugInfo
            };
            handSlots.push(slot);

            const activeTarget = slot.smoothedTarget;
            if (startsPinching) markers.push(activeTarget);
            else pointMarkers.push(activeTarget);
            continue;
          }

          if (!detection.confident) continue;

          slot.lastGoodTime = now;
          slot.debugInfo = detection.debugInfo;

          // SMOOTHING: Final screen-space origin
          slot.smoothedOrigin.x += (detection.originPx.x - slot.smoothedOrigin.x) * SMOOTHING_ALPHA;
          slot.smoothedOrigin.y += (detection.originPx.y - slot.smoothedOrigin.y) * SMOOTHING_ALPHA;

          // SMOOTHING: Interpolate direction, then re-normalize
          let sdX = slot.smoothedDir.x + (detection.rawDir.x - slot.smoothedDir.x) * SMOOTHING_ALPHA;
          let sdY = slot.smoothedDir.y + (detection.rawDir.y - slot.smoothedDir.y) * SMOOTHING_ALPHA;
          const sdLen = Math.hypot(sdX, sdY) || 1;
          slot.smoothedDir = { x: sdX / sdLen, y: sdY / sdLen };

          // Extend smoothed direction vector to find dynamic target
          slot.smoothedTarget = {
            x: slot.smoothedOrigin.x + slot.smoothedDir.x * detection.rayLength,
            y: slot.smoothedOrigin.y + slot.smoothedDir.y * detection.rayLength,
          };

          // LIVE PINCH - Controls state ONLY, never freezes position
          const rawWantsPinch = slot.isPinching
            ? detection.pinchRatio < PINCH_EXIT_THRESHOLD
            : detection.pinchRatio < PINCH_ENTER_THRESHOLD;

          if (rawWantsPinch === slot.isPinching) {
            slot.pendingPinchCount = 0;
          } else {
            slot.pendingPinchCount += 1;
            if (slot.pendingPinchCount >= PINCH_DEBOUNCE_FRAMES) {
              slot.isPinching = rawWantsPinch;
              slot.pendingPinchCount = 0;
            }
          }

          const activeTarget = slot.smoothedTarget;

          if (slot.isPinching) {
            markers.push(activeTarget);
          } else {
            pointMarkers.push(activeTarget);
          }
        }

        onPinchMarkersRef.current?.(markers);
        onPointMarkersRef.current?.(pointMarkers);

        handSlots = handSlots.filter((slot) => now - slot.lastGoodTime <= FREEZE_MS);

        // =================================================================
        // 🎨 VISUAL RENDERING
        // =================================================================
        for (const slot of handSlots) {
          const origin = slot.smoothedOrigin;
          const target = slot.smoothedTarget;

          const color = slot.isPinching ? '#ff3b30' : '#22d3ee';
          const glowColor = slot.isPinching ? 'rgba(255, 59, 48, 0.4)' : 'rgba(34, 211, 238, 0.4)';

          // Laser Line
          ctx.beginPath();
          ctx.moveTo(origin.x, origin.y);
          ctx.lineTo(target.x, target.y);
          ctx.strokeStyle = color;
          ctx.lineWidth = 3.5;
          ctx.shadowColor = color;
          ctx.shadowBlur = slot.isPinching ? 10 : 6;
          ctx.stroke();
          ctx.shadowBlur = 0;

          // Origin Dot
          ctx.beginPath();
          ctx.arc(origin.x, origin.y, 6, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();

          // Target Glow Ring
          ctx.beginPath();
          ctx.arc(target.x, target.y, slot.isPinching ? 18 : 14, 0, 2 * Math.PI);
          ctx.fillStyle = glowColor;
          ctx.fill();

          // Target Solid Center
          ctx.beginPath();
          ctx.arc(target.x, target.y, slot.isPinching ? 8 : 6, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.shadowColor = color;
          ctx.shadowBlur = slot.isPinching ? 12 : 8;
          ctx.fill();
          ctx.shadowBlur = 0;

          // 🐛 DEBUG RENDERING
          if (DEBUG_HAND_TRACKING && slot.debugInfo) {
            const { thumbTipSc, indexTipSc, wristSc, middleMcpSc } = slot.debugInfo;
            
            ctx.fillStyle = '#00ff00';
            [thumbTipSc, indexTipSc, wristSc, middleMcpSc, origin].forEach(pt => {
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, 4, 0, 2 * Math.PI);
              ctx.fill();
            });

            ctx.strokeStyle = '#00ff00';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(wristSc.x, wristSc.y);
            ctx.lineTo(middleMcpSc.x, middleMcpSc.y);
            ctx.stroke();
          }
        }
      });

      try {
        await hands.initialize();
      } catch (err) {
        console.error('[HandTracker] Failed to init MediaPipe:', err);
        return;
      }

      if (cancelled) return;

      let xrModeAtStart = useXRCameraSource();
      let pollAttempts = 0;

      while (!xrModeAtStart && xrPoseEngine.isActive() && pollAttempts < 40) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        xrModeAtStart = useXRCameraSource();
        pollAttempts++;
      }

      let lastProcessTime = 0;

      if (xrModeAtStart) {
        let isProcessing = false;

        const unsubscribe = xrCameraSource.subscribe(async (xrCanvas) => {
          if (cancelled || !xrCanvas || isProcessing) return;

          currentSourceW = xrCanvas.width;
          currentSourceH = xrCanvas.height;

          // Throttle FPS to avoid choking the ML pipeline
          const now = performance.now();
          if (now - lastProcessTime < PROCESS_INTERVAL) return;

          if (mpCtx) {
            // Draw high-res XR canvas into the low-res fixed processing canvas
            mpCtx.drawImage(
              xrCanvas, 
              0, 0, xrCanvas.width, xrCanvas.height, 
              0, 0, MP_PROCESS_WIDTH, MP_PROCESS_HEIGHT
            );
          }

          isProcessing = true;
          lastProcessTime = performance.now();
          try {
            await hands.send({ image: mpCanvas });
          } catch (err) {
            // silent catch
          } finally {
            isProcessing = false;
          }
        });

        camera = { stop: () => unsubscribe() };

        if (!cancelled) {
          setStatus('');
          onReadyRef.current?.();
        }
        return;
      }

      try {
        if (!video) return;

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: CAPTURE_WIDTH }, height: { ideal: CAPTURE_HEIGHT } },
        });

        video.srcObject = stream;
        await video.play();

        let isProcessing = false;
        let rafId = 0;

        const loop = async () => {
          if (cancelled) return;

          if (video.readyState >= 2 && !isProcessing) {
            currentSourceW = video.videoWidth || CAPTURE_WIDTH;
            currentSourceH = video.videoHeight || CAPTURE_HEIGHT;
            
            const now = performance.now();
            if (now - lastProcessTime >= PROCESS_INTERVAL) {
              isProcessing = true;
              lastProcessTime = performance.now();
              try {
                await hands.send({ image: video });
              } catch (err) {
                // ignore
              } finally {
                isProcessing = false;
              }
            }
          }
          rafId = requestAnimationFrame(loop);
        };
        rafId = requestAnimationFrame(loop);

        camera = {
          stop: () => {
            cancelAnimationFrame(rafId);
            stream.getTracks().forEach((t) => t.stop());
          },
        };

        if (!cancelled) {
          setStatus('');
          onReadyRef.current?.();
        }
      } catch (err) {
        if (!cancelled) setStatus('Camera access failed.');
      }
    }

    start();

    return () => {
      cancelled = true;
      camera?.stop();
      if (hands && typeof hands.close === 'function') hands.close();
      window.removeEventListener('resize', resizeCanvas);
      window.removeEventListener('orientationchange', resizeCanvas);
    };
  }, []);

  const xrMode = xrPoseEngine.isActive() && xrCameraSource.isSupported();

  return (
    <>
      <div className={`fixed inset-0 overflow-hidden ${xrMode ? '' : 'bg-black'}`}>
        {!xrMode && (
          <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" playsInline muted autoPlay />
        )}
      </div>

      <canvas
        ref={canvasRef}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          zIndex: 999998,
          pointerEvents: 'none',
        }}
      />
    </>
  );
          }
                                                     
