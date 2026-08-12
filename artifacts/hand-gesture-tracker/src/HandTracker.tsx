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

// =====================================================================
// ⚙️  SETTINGS — YE SAB NUMBERS TUM KHUD BADAL SAKTE HO
// =====================================================================

const MIN_DETECTION_CONFIDENCE = 0.7;
const MIN_TRACKING_CONFIDENCE = 0.6;
const MAX_NUM_HANDS = 1;
const PINCH_ENTER_THRESHOLD = 0.45;
const PINCH_EXIT_THRESHOLD = 0.55;
const MAX_TIP_TO_WRIST_RATIO = 2.2;
const MIN_HAND_SIZE = 0.08;
const CONFIDENCE_THRESHOLD = 0.8;
const JUMP_REJECT_RATIO = 0.25;
const MATCH_DISTANCE_RATIO = 0.35;
const FREEZE_MS = 200;
const SNAP_JUMP_PX = 6;
const SNAP_ALPHA = 0.75;
const CALIBRATION_OFFSET_X = 15;
const CALIBRATION_OFFSET_Y = -20;
const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 480;

// --- NAYA: LASER POINTER MODE ---
// Chhote fingertip-dot ki jagah, ab hath se ek "laser beam" nikalta hai
// (wrist se lekar index fingertip tak ki direction ko lamba karke).
// Fayde: (1) demo mein professional/VR jaisa dikhta hai, (2) agar
// calibration thoda bhi off ho, user khud apni ankhon se laser dekh ke
// aim adjust kar sakta hai.
//
// FIX: origin WRIST (landmark 0) hai, index-finger-knuckle (landmark 5)
// nahi — index-knuckle finger ke bahut paas hota hai, isliye jab thumb
// pinch ke liye index ke paas aata hai, laser ka origin khud bhi thoda
// disturb ho jaata tha (pinch aur laser-movement ek dusre ko affect
// karte the). Wrist door hai fingers se, isliye pinch action se origin
// stable rehta hai — laser aur pinch dono independently kaam karte hain.
//
// LASER_LENGTH_MULTIPLIER: wrist→fingertip direction ko kitna
// "extend"/lamba karna hai screen tak pahunchne ke liye. BADHAOGE →
// laser lamba, thoda sa hand-angle-change se pointer bahut zyada move
// karega (sensitive/twitchy). GHATAOGE → laser chhota, kam sensitive
// lekin door tak point karna mushkil.
const LASER_LENGTH_MULTIPLIER = 3.5;

// =====================================================================
// ⚙️  SETTINGS KHATAM
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
  // NAYA: laser ka "origin" — index finger ke base knuckle ki
  // smoothed position (canvas px mein).
  smoothedOrigin: PxPoint;
  smoothedThumb: PxPoint;
  smoothedIndex: PxPoint;
  pendingThumb: PxPoint | null;
  pendingIndex: PxPoint | null;
  isPinching: boolean;
  lastGoodTime: number;
};

function smoothPoint(
  slot: HandSlot,
  which: 'origin' | 'thumb' | 'index',
  raw: PxPoint,
  jumpThreshold: number,
): PxPoint {
  const current = which === 'thumb' ? slot.smoothedThumb : which === 'index' ? slot.smoothedIndex : slot.smoothedOrigin;
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

        const xrCanvas = useXRCameraSource() ? xrCameraSource.getCanvas() : null;

        let sourceWidth = window.innerWidth;
        let sourceHeight = window.innerHeight;

        if (xrCanvas) {
          sourceWidth = xrCanvas.width;
          sourceHeight = xrCanvas.height;
        } else if (video) {
          sourceWidth = video.videoWidth || window.innerWidth;
          sourceHeight = video.videoHeight || window.innerHeight;
        }

        canvas.width = sourceWidth;
        canvas.height = sourceHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const rectDbg = canvas.getBoundingClientRect();
        (window as any).__handTrackerCoordDebug = {
          xrCanvasSize: xrCanvas ? `${xrCanvas.width}x${xrCanvas.height}` : 'null',
          sourceWH: `${sourceWidth}x${sourceHeight}`,
          canvasInternalWH: `${canvas.width}x${canvas.height}`,
          canvasCssRect: `${rectDbg.width.toFixed(0)}x${rectDbg.height.toFixed(0)} @ (${rectDbg.left.toFixed(0)},${rectDbg.top.toFixed(0)})`,
          firstLandmarkRaw:
            (results.multiHandLandmarks || [])[0]?.[8]
              ? `x=${results.multiHandLandmarks[0][8].x.toFixed(3)} y=${results.multiHandLandmarks[0][8].y.toFixed(3)}`
              : 'no hand',
          screenInnerWH: `${window.innerWidth}x${window.innerHeight}`,
          screenOrientationAngle: window.screen?.orientation?.angle ?? 'n/a',
        };

        const now = Date.now();
        const jumpThreshold = JUMP_REJECT_RATIO * Math.max(canvas.width, canvas.height);
        const matchThreshold = MATCH_DISTANCE_RATIO * Math.max(canvas.width, canvas.height);

        const canvasRectDbg = canvas.getBoundingClientRect();
        const canvasScaleX = canvas.width / (canvasRectDbg.width || canvas.width);
        const canvasScaleY = canvas.height / (canvasRectDbg.height || canvas.height);
        const CALIBRATION_OFFSET_CANVAS_X = CALIBRATION_OFFSET_X * canvasScaleX;
        const CALIBRATION_OFFSET_CANVAS_Y = CALIBRATION_OFFSET_Y * canvasScaleY;

        // Canvas-pixel position ko screen CSS-pixel position mein badalta
        // hai — canvas CSS se poori screen tak stretch hota hai, isliye
        // ye simple divide-by-scale se ho jaata hai.
        function canvasPxToScreen(px: number, py: number) {
          return {
            x: px / canvasScaleX + canvasRectDbg.left,
            y: py / canvasScaleY + canvasRectDbg.top,
          };
        }

        const landmarkSets: Landmark[][] = results.multiHandLandmarks || [];
        const handednessSets: any[] = results.multiHandedness || [];
        const markers: PinchMarker[] = [];
        const pointMarkers: PinchMarker[] = [];

        type Detection = {
          // NAYA: laser ka origin — index finger base knuckle (landmark 5).
          originPx: PxPoint;
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

          detections.push({
            originPx: { x: wrist.x * canvas.width + CALIBRATION_OFFSET_CANVAS_X, y: wrist.y * canvas.height + CALIBRATION_OFFSET_CANVAS_Y },
            thumbPx: { x: thumbTip.x * canvas.width + CALIBRATION_OFFSET_CANVAS_X, y: thumbTip.y * canvas.height + CALIBRATION_OFFSET_CANVAS_Y },
            indexPx: { x: indexTip.x * canvas.width + CALIBRATION_OFFSET_CANVAS_X, y: indexTip.y * canvas.height + CALIBRATION_OFFSET_CANVAS_Y },
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

        // NAYA: origin→index vector ko extend karke laser ka end-point
        // nikalta hai, aur usse screen-space marker mein convert karta
        // hai. Ye ab hamesha pointer/marker position ke liye use hota
        // hai (raw fingertip position ki jagah).
        function computeLaserEndpointScreen(slot: HandSlot) {
          const dx = slot.smoothedIndex.x - slot.smoothedOrigin.x;
          const dy = slot.smoothedIndex.y - slot.smoothedOrigin.y;
          const endCanvasX = slot.smoothedOrigin.x + dx * LASER_LENGTH_MULTIPLIER;
          const endCanvasY = slot.smoothedOrigin.y + dy * LASER_LENGTH_MULTIPLIER;
          return {
            canvasEnd: { x: endCanvasX, y: endCanvasY },
            screen: canvasPxToScreen(endCanvasX, endCanvasY),
          };
        }

        for (const detection of detections) {
          let slot = slotForDetection.get(detection) ?? null;

          if (!slot) {
            if (!detection.confident) continue;
            const startsPinching = detection.pinchRatio < PINCH_ENTER_THRESHOLD;
            slot = {
              smoothedOrigin: { ...detection.originPx },
              smoothedThumb: { ...detection.thumbPx },
              smoothedIndex: { ...detection.indexPx },
              pendingThumb: null,
              pendingIndex: null,
              isPinching: startsPinching,
              lastGoodTime: now,
            };
            handSlots.push(slot);
            const { screen } = computeLaserEndpointScreen(slot);
            if (startsPinching) {
              markers.push(screen);
            } else {
              pointMarkers.push(screen);
            }
            continue;
          }

          if (!detection.confident) continue;

          const wasPinching = slot.isPinching;
          const isPinchingNow = wasPinching
            ? detection.pinchRatio < PINCH_EXIT_THRESHOLD
            : detection.pinchRatio < PINCH_ENTER_THRESHOLD;

          slot.isPinching = isPinchingNow;
          slot.lastGoodTime = now;
          slot.smoothedOrigin = smoothPoint(slot, 'origin', detection.originPx, jumpThreshold);
          slot.smoothedThumb = smoothPoint(slot, 'thumb', detection.thumbPx, jumpThreshold);
          slot.smoothedIndex = smoothPoint(slot, 'index', detection.indexPx, jumpThreshold);

          const { screen } = computeLaserEndpointScreen(slot);
          if (isPinchingNow) {
            markers.push(screen);
          } else {
            pointMarkers.push(screen);
          }
        }

        onPinchMarkersRef.current?.(markers);
        onPointMarkersRef.current?.(pointMarkers);

        handSlots = handSlots.filter((slot) => now - slot.lastGoodTime <= FREEZE_MS);

        // NAYA: laser-beam rendering — origin se lekar extended
        // end-point tak ek glowing line, aur end-point pe ek reticle
        // (cursor) dot. Pinching = red, khula = cyan/blue.
        for (const slot of handSlots) {
          const { canvasEnd } = computeLaserEndpointScreen(slot);
          const color = slot.isPinching ? '#ff3b30' : '#22d3ee';
          const glowColor = slot.isPinching ? 'rgba(255, 59, 48, 0.5)' : 'rgba(34, 211, 238, 0.5)';

          // Beam line
          ctx.beginPath();
          ctx.moveTo(slot.smoothedOrigin.x, slot.smoothedOrigin.y);
          ctx.lineTo(canvasEnd.x, canvasEnd.y);
          ctx.strokeStyle = color;
          ctx.lineWidth = 3;
          ctx.shadowColor = glowColor;
          ctx.shadowBlur = 14;
          ctx.stroke();
          ctx.shadowBlur = 0;

          // Origin dot (chhota, hath ke paas)
          ctx.beginPath();
          ctx.arc(slot.smoothedOrigin.x, slot.smoothedOrigin.y, 5, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();

          // End-point reticle (bada, target/cursor)
          ctx.beginPath();
          ctx.arc(canvasEnd.x, canvasEnd.y, slot.isPinching ? 16 : 12, 0, 2 * Math.PI);
          ctx.fillStyle = glowColor;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(canvasEnd.x, canvasEnd.y, slot.isPinching ? 8 : 6, 0, 2 * Math.PI);
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
          objectFit: 'cover',
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
          <div>xrCanvas: {coordDebug.xrCanvasSize}</div>
          <div>source W x H: {coordDebug.sourceWH}</div>
          <div>canvas internal: {coordDebug.canvasInternalWH}</div>
          <div>canvas CSS rect: {coordDebug.canvasCssRect}</div>
          <div>screen inner: {coordDebug.screenInnerWH}</div>
          <div>orientation angle: {String(coordDebug.screenOrientationAngle)}</div>
          <div style={{ color: '#fbbf24' }}>landmark[8]: {coordDebug.firstLandmarkRaw}</div>
        </div>
      )}
    </>
  );
            }
