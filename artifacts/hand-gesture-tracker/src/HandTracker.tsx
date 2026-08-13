// hand tracking - Fixed Calibration, Thresholds & Laser
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
// ⚙️ SETTINGS — ACCURATE CALIBRATION & THRESHOLDS
// =====================================================================

const MIN_DETECTION_CONFIDENCE = 0.7;
const MIN_TRACKING_CONFIDENCE = 0.6;
const MAX_NUM_HANDS = 1;

// 🟢 FIX 1: Pinch thresholds tight kiye hain taaki door se accidental trigger na ho
const PINCH_ENTER_THRESHOLD = 0.20; // Ungliyan bilkul paas aane par hi pinch shuru hoga
const PINCH_EXIT_THRESHOLD = 0.32;  // Khulne par release hoga
const PINCH_DEBOUNCE_FRAMES = 2;

const MAX_TIP_TO_WRIST_RATIO = 2.2;
const MIN_HAND_SIZE = 0.08;
const CONFIDENCE_THRESHOLD = 0.8;
const JUMP_REJECT_RATIO = 0.25;
const MATCH_DISTANCE_RATIO = 0.35;
const FREEZE_MS = 200;
const SNAP_JUMP_PX = 6;
const SNAP_ALPHA = 0.75;

const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 480;

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
  smoothedThumb: PxPoint;
  smoothedIndex: PxPoint;
  isPinching: boolean;
  lastGoodTime: number;
  lockedIndex: PxPoint | null;
  pendingPinchCount: number;
};

// 🟢 FIX 2: Phone Orientation (0°, 90°, 180°, 270°) ke acc. landmarks rotate karega
function getOrientedLandmark(lm: Landmark, angle: number): PxPoint {
  if (angle === 90) {
    return { x: 1 - lm.y, y: lm.x };
  } else if (angle === 270) {
    return { x: lm.y, y: 1 - lm.x };
  } else if (angle === 180) {
    return { x: 1 - lm.x, y: 1 - lm.y };
  }
  return { x: lm.x, y: lm.y };
}

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

  if (jump < SNAP_JUMP_PX) {
    return {
      x: current.x * (1 - SNAP_ALPHA) + raw.x * SNAP_ALPHA,
      y: current.y * (1 - SNAP_ALPHA) + raw.y * SNAP_ALPHA,
    };
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

        const orientationAngle = window.screen?.orientation?.angle ?? 0;

        (window as any).__handTrackerCoordDebug = {
          screenInnerWH: `${screenW}x${screenH}`,
          screenOrientationAngle: orientationAngle,
          firstLandmarkRaw:
            (results.multiHandLandmarks || [])[0]?.[8]
              ? `x=${results.multiHandLandmarks[0][8].x.toFixed(3)} y=${results.multiHandLandmarks[0][8].y.toFixed(3)}`
              : 'no hand',
        };

        const now = Date.now();
        const jumpThreshold = JUMP_REJECT_RATIO * Math.max(screenW, screenH);
        const matchThreshold = MATCH_DISTANCE_RATIO * Math.max(screenW, screenH);

        const landmarkSets: Landmark[][] = results.multiHandLandmarks || [];
        const handednessSets: any[] = results.multiHandedness || [];
        const markers: PinchMarker[] = [];
        const pointMarkers: PinchMarker[] = [];

        type Detection = {
          thumbPx: PxPoint;
          indexPx: PxPoint;
          pinchRatio: number;
          confident: boolean;
        };
        const detections: Detection[] = [];

        for (let i = 0; i < landmarkSets.length; i++) {
          const landmarks = landmarkSets[i];
          const wrist = landmarks[0];
          const middleMcp = landmarks[9];
          const handSize = dist(wrist, middleMcp);

          if (handSize < MIN_HAND_SIZE) continue;

          const thumbTip = landmarks[4];
          const indexTip = landmarks[8];

          const thumbWristDist = dist(wrist, thumbTip);
          const indexWristDist = dist(wrist, indexTip);
          if (
            thumbWristDist / handSize > MAX_TIP_TO_WRIST_RATIO ||
            indexWristDist / handSize > MAX_TIP_TO_WRIST_RATIO
          ) {
            continue;
          }

          const pinchDistance = dist(thumbTip, indexTip);
          const pinchRatio = pinchDistance / handSize;
          const confidence = handednessSets[i]?.score ?? 1;

          // Orientation fix ke saath coordinates direct screen pixel mein map honge
          const orientedThumb = getOrientedLandmark(thumbTip, orientationAngle);
          const orientedIndex = getOrientedLandmark(indexTip, orientationAngle);

          detections.push({
            thumbPx: { x: orientedThumb.x * screenW, y: orientedThumb.y * screenH },
            indexPx: { x: orientedIndex.x * screenW, y: orientedIndex.y * screenH },
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
            const startsPinching = detection.pinchRatio < PINCH_ENTER_THRESHOLD;
            slot = {
              smoothedThumb: { ...detection.thumbPx },
              smoothedIndex: { ...detection.indexPx },
              isPinching: startsPinching,
              lastGoodTime: now,
              lockedIndex: startsPinching ? { ...detection.indexPx } : null,
              pendingPinchCount: 0,
            };
            handSlots.push(slot);

            const markerPos = startsPinching && slot.lockedIndex ? slot.lockedIndex : slot.smoothedIndex;
            if (startsPinching) {
              markers.push(markerPos);
            } else {
              pointMarkers.push(markerPos);
            }
            continue;
          }

          if (!detection.confident) continue;

          slot.lastGoodTime = now;
          slot.smoothedThumb = smoothPoint(slot, 'thumb', detection.thumbPx, jumpThreshold);
          slot.smoothedIndex = smoothPoint(slot, 'index', detection.indexPx, jumpThreshold);

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
              if (rawWantsPinch) {
                slot.lockedIndex = { ...slot.smoothedIndex };
              } else {
                slot.lockedIndex = null;
              }
            }
          }

          const markerPos = slot.isPinching && slot.lockedIndex ? slot.lockedIndex : slot.smoothedIndex;

          if (slot.isPinching) {
            markers.push(markerPos);
          } else {
            pointMarkers.push(markerPos);
          }
        }

        onPinchMarkersRef.current?.(markers);
        onPointMarkersRef.current?.(pointMarkers);

        handSlots = handSlots.filter((slot) => now - slot.lastGoodTime <= FREEZE_MS);

        // 🟢 FIX 3: Laser beam Origin = Thumb & Index ke BEECH (Midpoint)
        // Target = Exact calibrated Index Fingertip
        for (const slot of handSlots) {
          const originX = (slot.smoothedThumb.x + slot.smoothedIndex.x) / 2;
          const originY = (slot.smoothedThumb.y + slot.smoothedIndex.y) / 2;

          const targetPos = slot.isPinching && slot.lockedIndex ? slot.lockedIndex : slot.smoothedIndex;

          const color = slot.isPinching ? '#ff3b30' : '#22d3ee';
          const glowColor = slot.isPinching ? 'rgba(255, 59, 48, 0.5)' : 'rgba(34, 211, 238, 0.5)';

          // Laser line drawing (Midpoint se Point marker tak)
          ctx.beginPath();
          ctx.moveTo(originX, originY);
          ctx.lineTo(targetPos.x, targetPos.y);
          ctx.strokeStyle = color;
          ctx.lineWidth = 3;
          ctx.shadowColor = glowColor;
          ctx.shadowBlur = 14;
          ctx.stroke();
          ctx.shadowBlur = 0;

          // Origin glow point (Thumb aur index ke beech)
          ctx.beginPath();
          ctx.arc(originX, originY, 5, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();

          // Target marker dot (Target cursor at calibrated index tip)
          ctx.beginPath();
          ctx.arc(targetPos.x, targetPos.y, slot.isPinching ? 16 : 12, 0, 2 * Math.PI);
          ctx.fillStyle = glowColor;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(targetPos.x, targetPos.y, slot.isPinching ? 8 : 6, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.shadowColor = color;
          ctx.shadowBlur = 12;
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

  const [coordDebug, setCoordDebug] = useState<any>(null);
  useEffect(() => {
    const id = setInterval(() => {
      setCoordDebug((window as any).__handTrackerCoordDebug ?? null);
    }, 500);
    return () => clearInterval(id);
  }, []);

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

      {coordDebug && (
        <div
          style={{
            position: 'fixed',
            top: 16,
            right: 16,
            zIndex: 9999999,
            background: 'rgba(0,0,0,0.85)',
            color: '#93c5fd',
            fontSize: 11,
            fontWeight: 'bold',
            padding: '8px 10px',
            borderRadius: 8,
            maxWidth: '55vw',
            pointerEvents: 'none',
          }}
        >
          <div>screen inner: {coordDebug.screenInnerWH}</div>
          <div>orientation angle: {coordDebug.screenOrientationAngle}</div>
          <div>landmark[8]: {coordDebug.firstLandmarkRaw}</div>
        </div>
      )}
    </>
  );
            }
            
