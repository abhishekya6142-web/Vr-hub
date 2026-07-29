//hand tracking
import { useEffect, useRef, useState } from 'react';
import { xrPoseEngine } from './vr-hub/xr-pose-engine';
import { xrCameraSource } from './vr-hub/xr-camera-source';

declare global {
  interface Window {
    Hands: any;
    Camera: any;
  }
}

type Landmark = { x: number; y: number; z: number };

const PINCH_THRESHOLD = 0.45;
const MIN_HAND_SIZE = 0.08;

function dist(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const JUMP_REJECT_RATIO = 0.25;
const CONFIDENCE_THRESHOLD = 0.8;
const FREEZE_MS = 200;
const MATCH_DISTANCE_RATIO = 0.35;

const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 480;

type PxPoint = { x: number; y: number };

function pxDist(a: PxPoint, b: PxPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

type HandSlot = {
  smoothedThumb: PxPoint;
  smoothedIndex: PxPoint;
  pendingThumb: PxPoint | null;
  pendingIndex: PxPoint | null;
  isPinching: boolean;
  lastGoodTime: number;
};

function smoothPoint(
  slot: HandSlot,
  which: 'thumb' | 'index',
  raw: PxPoint,
  jumpThreshold: number,
): PxPoint {
  const current = which === 'thumb' ? slot.smoothedThumb : slot.smoothedIndex;
  const jump = pxDist(raw, current);

  if (jump > jumpThreshold * 1.5) {
    return current;
  }

  const baseAlpha = slot.isPinching ? 0.22 : 0.38;
  const velocityFactor = Math.min(jump / 120, 0.15);
  const finalAlpha = Math.min(baseAlpha + velocityFactor, 1);

  return {
    x: current.x * (1 - finalAlpha) + raw.x * finalAlpha,
    y: current.y * (1 - finalAlpha) + raw.y * finalAlpha,
  };
}

type PinchMarker = { x: number; y: number };

type HandTrackerProps = {
  onPinchMarkers?: (markers: PinchMarker[]) => void;
  onReady?: () => void;
};

export default function HandTracker({ onPinchMarkers, onReady }: HandTrackerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<string>('Requesting camera access...');

  const onPinchMarkersRef = useRef(onPinchMarkers);
  onPinchMarkersRef.current = onPinchMarkers;
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

    function toScreenCoords(
      nx: number,
      ny: number,
      sourceWidth: number,
      sourceHeight: number,
      canvas: HTMLCanvasElement,
    ) {
      const vw = sourceWidth || canvas.width;
      const vh = sourceHeight || canvas.height;
      const rect = canvas.getBoundingClientRect();
      const scale = Math.max(rect.width / vw, rect.height / vh);
      const offsetX = (vw * scale - rect.width) / 2;
      const offsetY = (vh * scale - rect.height) / 2;
      return {
        x: nx * vw * scale - offsetX + rect.left,
        y: ny * vh * scale - offsetY + rect.top,
      };
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
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

      hands.onResults((results: any) => {
        if (cancelled) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const xrCanvas = useXRCameraSource() ? xrCameraSource.getCanvas() : null;

        let sourceWidth = window.innerWidth;
        let sourceHeight = window.innerHeight;

        if (xrCanvas) {
          const angle = window.screen?.orientation?.angle || 0;
          const isPortrait = angle === 0 || angle === 180;
          sourceWidth = isPortrait ? xrCanvas.height : xrCanvas.width;
          sourceHeight = isPortrait ? xrCanvas.width : xrCanvas.height;
        } else if (video) {
          sourceWidth = video.videoWidth || window.innerWidth;
          sourceHeight = video.videoHeight || window.innerHeight;
        }

        canvas.width = sourceWidth;
        canvas.height = sourceHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // --- TEMPORARY DEBUG PIP ---
        if (xrCanvas) {
          try {
            ctx.save();
            const pipW = 200;
            const pipH = 150;
            const pipX = canvas.width - pipW - 20;
            const pipY = 20;
            ctx.drawImage(xrCanvas, pipX, pipY, pipW, pipH);
            ctx.strokeStyle = 'lime';
            ctx.lineWidth = 4;
            ctx.strokeRect(pipX, pipY, pipW, pipH);
            ctx.restore();
          } catch (e) {
            console.error('PIP draw failed', e);
          }
        }

        const now = Date.now();
        const jumpThreshold = JUMP_REJECT_RATIO * Math.max(canvas.width, canvas.height);
        const matchThreshold = MATCH_DISTANCE_RATIO * Math.max(canvas.width, canvas.height);

        const landmarkSets: Landmark[][] = results.multiHandLandmarks || [];
        const handednessSets: any[] = results.multiHandedness || [];
        const markers: PinchMarker[] = [];

        type Detection = { thumbPx: PxPoint; indexPx: PxPoint; isPinching: boolean; confident: boolean };
        const detections: Detection[] = [];

        for (let i = 0; i < landmarkSets.length; i++) {
          const landmarks = landmarkSets[i];
          const wrist = landmarks[0];
          const middleMcp = landmarks[9];
          const handSize = dist(wrist, middleMcp);

          if (handSize < MIN_HAND_SIZE) continue;

          const thumbTip = landmarks[4];
          const indexTip = landmarks[8];
          const pinchDistance = dist(thumbTip, indexTip);
          const isPinching = pinchDistance / handSize < PINCH_THRESHOLD;
          const confidence = handednessSets[i]?.score ?? 1;

          if (isPinching) {
            const screen = toScreenCoords(
              (thumbTip.x + indexTip.x) / 2,
              (thumbTip.y + indexTip.y) / 2,
              sourceWidth,
              sourceHeight,
              canvas,
            );
            markers.push({ x: screen.x, y: screen.y });
          }

          detections.push({
            thumbPx: { x: thumbTip.x * canvas.width, y: thumbTip.y * canvas.height },
            indexPx: { x: indexTip.x * canvas.width, y: indexTip.y * canvas.height },
            isPinching,
            confident: confidence >= CONFIDENCE_THRESHOLD,
          });
        }

        onPinchMarkersRef.current?.(markers);

        const unmatchedSlots = new Set(handSlots);
        const slotForDetection = new Map<Detection, HandSlot>();

        for (const detection of detections) {
          let best: HandSlot | null = null;
          let bestDist = Infinity;
          for (const slot of unmatchedSlots) {
            const d = pxDist(detection.indexPx, slot.smoothedIndex);
            if (d < bestDist) {
              bestDist = d;
              best = slot;
            }
          }
          if (best && bestDist <= matchThreshold) {
            slotForDetection.set(detection, best);
            unmatchedSlots.delete(best);
          }
        }

        for (const detection of detections) {
          let slot = slotForDetection.get(detection) ?? null;

          if (!slot) {
            if (!detection.confident) continue;
            slot = {
              smoothedThumb: { ...detection.thumbPx },
              smoothedIndex: { ...detection.indexPx },
              pendingThumb: null,
              pendingIndex: null,
              isPinching: detection.isPinching,
              lastGoodTime: now,
            };
            handSlots.push(slot);
            continue;
          }

          if (!detection.confident) continue;

          slot.isPinching = detection.isPinching;
          slot.lastGoodTime = now;
          slot.smoothedThumb = smoothPoint(slot, 'thumb', detection.thumbPx, jumpThreshold);
          slot.smoothedIndex = smoothPoint(slot, 'index', detection.indexPx, jumpThreshold);
        }

        handSlots = handSlots.filter((slot) => now - slot.lastGoodTime <= FREEZE_MS);

        for (const slot of handSlots) {
          const dotColor = slot.isPinching ? '#ff3b30' : '#4da3ff';
          const glowColor = slot.isPinching ? 'rgba(255, 59, 48, 0.3)' : 'rgba(77, 163, 255, 0.25)';
          for (const p of [slot.smoothedThumb, slot.smoothedIndex]) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 14, 0, 2 * Math.PI);
            ctx.fillStyle = glowColor;
            ctx.fill();

            ctx.beginPath();
            ctx.arc(p.x, p.y, 6, 0, 2 * Math.PI);
            ctx.fillStyle = dotColor;
            ctx.shadowColor = dotColor;
            ctx.shadowBlur = 12;
            ctx.fill();
            ctx.shadowBlur = 0;
          }
        }

        // --- TEMPORARY DEBUG TEXT ---
        ctx.save();
        ctx.font = 'bold 20px monospace';
        ctx.fillStyle = detections.length > 0 ? 'lime' : 'red';
        ctx.fillText(`hands: ${detections.length} | t: ${now % 100000}`, 20, canvas.height - 30);
        ctx.restore();
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
        console.log('[HandTracker] Entered Optimized XR Branch');
        let isProcessing = false;

        const unsubscribe = xrCameraSource.subscribe(async (xrCanvas) => {
          if (cancelled || !xrCanvas || isProcessing) return;

          if (mpCtx) {
            if (mpCanvas.width !== xrCanvas.width) {
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
            console.error('[HandTracker] XR send error:', err);
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

      console.log('[HandTracker] Entered Normal Camera Branch');
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

      {/* FIX: canvas ab createPortal(document.body) se render NAHI hota.
          WebXR ka DOM Overlay sirf domOverlay.root (XRHub.tsx ke
          overlayRef div) ke andar wale elements ko "allowed overlay
          content" maanta hai — document.body ke seedhe children (jo
          overlayRef tree se bahar hain) ko browser silently hide/ignore
          kar sakta hai security/isolation ke liye. Ye canvas ab normal
          render hota hai, isliye XRHub ke overlayRef ke andar hi rahega. */}
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
          objectFit: 'cover',
        }}
      />
    </>
  );
}
