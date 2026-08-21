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

const MIN_DETECTION_CONFIDENCE = 0.7;
const MIN_TRACKING_CONFIDENCE = 0.6;
const MAX_NUM_HANDS = 1;

const PINCH_ENTER_THRESHOLD = 0.20;
const PINCH_EXIT_THRESHOLD = 0.35;
const PINCH_DEBOUNCE_FRAMES = 2;

const MIN_HAND_SIZE = 0.08;
const CONFIDENCE_THRESHOLD = 0.8;
const FREEZE_MS = 200;

const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 480;

// High alpha = Fast & Snappy movement (No lag)
const SMOOTHING_ALPHA = 0.45; 

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
  smoothedTarget: PxPoint;
  isPinching: boolean;
  lastGoodTime: number;
  pendingPinchCount: number;
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

    const mpCanvas = document.createElement('canvas');
    const mpCtx = mpCanvas.getContext('2d', { willReadFrequently: true });

    function useXRCameraSource() {
      return xrPoseEngine.isActive() && xrCameraSource.isSupported();
    }

    let handSlots: HandSlot[] = [];

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
        modelComplexity: 1,
        minDetectionConfidence: MIN_DETECTION_CONFIDENCE,
        minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
      });

      hands.onResults((results: any) => {
        if (cancelled) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const screenW = window.innerWidth;
        const screenH = window.innerHeight;

        canvas.width = screenW;
        canvas.height = screenH;
        ctx.clearRect(0, 0, screenW, screenH);

        const now = Date.now();
        const landmarkSets: Landmark[][] = results.multiHandLandmarks || [];
        const handednessSets: any[] = results.multiHandedness || [];
        const markers: PinchMarker[] = [];
        const pointMarkers: PinchMarker[] = [];

        type Detection = {
          originPx: PxPoint;
          targetPx: PxPoint;
          pinchRatio: number;
          confident: boolean;
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

          // 1. ORIGIN: Exact midpoint between thumb tip (4) and index tip (8)
          const originPx: PxPoint = {
            x: ((thumbTip.x + indexTip.x) / 2) * screenW,
            y: ((thumbTip.y + indexTip.y) / 2) * screenH,
          };

          // 2. DIRECTION: Wrist (0) to Middle MCP (9)
          const dx = (middleMcp.x - wrist.x) * screenW;
          const dy = (middleMcp.y - wrist.y) * screenH;

          const len = Math.hypot(dx, dy) || 1;
          const normX = dx / len;
          const normY = dy / len;

          const rayLength = Math.max(screenW, screenH) * 0.6; // Longer reach

          const targetPx: PxPoint = {
            x: originPx.x + normX * rayLength,
            y: originPx.y + normY * rayLength,
          };

          detections.push({
            originPx,
            targetPx,
            pinchRatio,
            confident: confidence >= CONFIDENCE_THRESHOLD,
          });
        }

        const unmatchedSlots = new Set(handSlots);
        const slotForDetection = new Map<Detection, HandSlot>();

        for (const detection of detections) {
          let best: HandSlot | null = null;
          let bestDist = Infinity;
          for (const slot of unmatchedSlots) {
            const d = pxDist(detection.targetPx, slot.smoothedTarget);
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
              smoothedTarget: { ...detection.targetPx },
              isPinching: startsPinching,
              lastGoodTime: now,
              pendingPinchCount: 0,
            };
            handSlots.push(slot);

            const activeTarget = slot.smoothedTarget;
            if (startsPinching) markers.push(activeTarget);
            else pointMarkers.push(activeTarget);
            continue;
          }

          if (!detection.confident) continue;

          slot.lastGoodTime = now;

          // FAST & RESPONSIVE SMOOTHING (No artificial lag)
          slot.smoothedOrigin.x += (detection.originPx.x - slot.smoothedOrigin.x) * SMOOTHING_ALPHA;
          slot.smoothedOrigin.y += (detection.originPx.y - slot.smoothedOrigin.y) * SMOOTHING_ALPHA;

          slot.smoothedTarget.x += (detection.targetPx.x - slot.smoothedTarget.x) * SMOOTHING_ALPHA;
          slot.smoothedTarget.y += (detection.targetPx.y - slot.smoothedTarget.y) * SMOOTHING_ALPHA;

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
          ctx.shadowBlur = 12;
          ctx.stroke();
          ctx.shadowBlur = 0;

          // Origin Dot (Knuckle base)
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
          ctx.shadowBlur = 16;
          ctx.fill();
          ctx.shadowBlur = 0;
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

      if (xrModeAtStart) {
        let isProcessing = false;

        const unsubscribe = xrCameraSource.subscribe(async (xrCanvas) => {
          if (cancelled || !xrCanvas || isProcessing) return;

          if (mpCtx) {
            if (mpCanvas.width !== xrCanvas.width || mpCanvas.height !== xrCanvas.height) {
              mpCanvas.width = xrCanvas.width;
              mpCanvas.height = xrCanvas.height;
            }
            mpCtx.clearRect(0, 0, mpCanvas.width, mpCanvas.height);
            mpCtx.drawImage(xrCanvas, 0, 0);
          }

          isProcessing = true;
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
            isProcessing = true;
            try {
              await hands.send({ image: video });
            } catch (err) {
              // ignore
            } finally {
              isProcessing = false;
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
          width: '100%',
          height: '100%',
          zIndex: 999998,
          pointerEvents: 'none',
        }}
      />
    </>
  );
            }
