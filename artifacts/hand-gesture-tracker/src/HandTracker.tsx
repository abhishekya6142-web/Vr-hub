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

// FIX: ek single loose threshold ki jagah ab 2 alag thresholds hain
// (hysteresis). Pinch SHURU karne ke liye tight/strict threshold
// chahiye (ENTER) — isse thoda sa bhi noise galti se pinch trigger
// nahi karega. Lekin ek baar pinch ho jaaye, to use CHALU rakhne ke
// liye thoda dheela threshold (EXIT) hai — isse asli pinch hold karte
// waqt beech-beech mein flicker nahi hota.
const PINCH_ENTER_THRESHOLD = 0.4;
const PINCH_EXIT_THRESHOLD = 0.55;
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

// FIX: dot ab fingertip ke bahut paas "snap" ho jaata hai jab hath
// steady/slow move kar raha ho (chhota frame-to-frame jump) — isse dot
// finger ke upar tightly chipka rehta hai instead of thoda peeche
// float karte rehna. Jab hath tez move kare (bada jump), purani
// jitter-reducing smoothing hi use hoti hai taaki dot kaanpe na.
const SNAP_JUMP_PX = 6;
const SNAP_ALPHA = 0.75;

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
  onReady?: () => void;
};

export default function HandTracker({ onPinchMarkers, onReady }: HandTrackerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [, setStatus] = useState<string>('Requesting camera access...');

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

    // Small manual calibration offset — compensates for the fixed,
    // consistent ~1cm gap between where dots render and the actual
    // finger tip (physical camera-lens parallax, confirmed to be present
    // even when the hand is held perfectly still). Positive X shifts
    // right, positive Y shifts down. Tweak these two numbers if the
    // offset direction/amount needs adjusting after testing.
    const CALIBRATION_OFFSET_X = 15;
    const CALIBRATION_OFFSET_Y = 15;

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
        x: nx * vw * scale - offsetX + rect.left + CALIBRATION_OFFSET_X,
        y: ny * vh * scale - offsetY + rect.top + CALIBRATION_OFFSET_Y,
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
          sourceWidth = xrCanvas.width;
          sourceHeight = xrCanvas.height;
        } else if (video) {
          sourceWidth = video.videoWidth || window.innerWidth;
          sourceHeight = video.videoHeight || window.innerHeight;
        }

        canvas.width = sourceWidth;
        canvas.height = sourceHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // TEMPORARY DEBUG: expose exact coordinate-space numbers so we can
        // pinpoint the dot-misalignment cause instead of guessing.
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

        const landmarkSets: Landmark[][] = results.multiHandLandmarks || [];
        const handednessSets: any[] = results.multiHandedness || [];
        const markers: PinchMarker[] = [];

        // FIX: ab yahan boolean isPinching store nahi karte — sirf
        // pinchRatio (raw closeness value) store karte hain. Actual
        // pinching-hai-ya-nahi ka decision baad mein, matched slot ki
        // purani state dekhkar (hysteresis) hota hai.
        type Detection = {
          thumbPx: PxPoint;
          indexPx: PxPoint;
          pinchMidNormX: number;
          pinchMidNormY: number;
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

          // FIX: agar thumb ya index tip ka MediaPipe-guessed position
          // wrist se apne hi hath ke size ke hisaab se anatomically
          // implausible door hai (jaise thumb camera se curled/chhupa
          // hone par galat guess), to poori detection is frame ke liye
          // skip kar do. Isse ek "bhatakta hua" dot kahin bhi door
          // (background object ke paas) dikhna band ho jaata hai — galat
          // jagah dot dikhane se behtar hai ek frame ke liye dot na
          // dikhana.
          const MAX_TIP_TO_WRIST_RATIO = 3;
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
            thumbPx: { x: thumbTip.x * canvas.width + CALIBRATION_OFFSET_CANVAS_X, y: thumbTip.y * canvas.height + CALIBRATION_OFFSET_CANVAS_Y },
            indexPx: { x: indexTip.x * canvas.width + CALIBRATION_OFFSET_CANVAS_X, y: indexTip.y * canvas.height + CALIBRATION_OFFSET_CANVAS_Y },
            pinchMidNormX: (thumbTip.x + indexTip.x) / 2,
            pinchMidNormY: (thumbTip.y + indexTip.y) / 2,
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
            // Naya haath: pinch state sirf tight ENTER threshold se
            // shuru hoti hai, taaki naya detected hand galti se
            // "pinching" state mein spawn na ho.
            const startsPinching = detection.pinchRatio < PINCH_ENTER_THRESHOLD;
            slot = {
              smoothedThumb: { ...detection.thumbPx },
              smoothedIndex: { ...detection.indexPx },
              pendingThumb: null,
              pendingIndex: null,
              isPinching: startsPinching,
              lastGoodTime: now,
            };
            handSlots.push(slot);
            if (startsPinching) {
              const screen = toScreenCoords(
                detection.pinchMidNormX,
                detection.pinchMidNormY,
                sourceWidth,
                sourceHeight,
                canvas,
              );
              markers.push({ x: screen.x, y: screen.y });
            }
            continue;
          }

          if (!detection.confident) continue;

          // FIX (core bug fix): hysteresis. Agar pehle se pinching thi,
          // to thodi dheeli EXIT threshold tak pinching maani jaati hai
          // (flicker rokne ke liye). Agar pinching nahi thi, to sirf
          // tight ENTER threshold cross karne par hi pinching maani
          // jaati hai (galat/noise-trigger rokne ke liye).
          const wasPinching = slot.isPinching;
          const isPinchingNow = wasPinching
            ? detection.pinchRatio < PINCH_EXIT_THRESHOLD
            : detection.pinchRatio < PINCH_ENTER_THRESHOLD;

          slot.isPinching = isPinchingNow;
          slot.lastGoodTime = now;
          slot.smoothedThumb = smoothPoint(slot, 'thumb', detection.thumbPx, jumpThreshold);
          slot.smoothedIndex = smoothPoint(slot, 'index', detection.indexPx, jumpThreshold);

          if (isPinchingNow) {
            const screen = toScreenCoords(
              detection.pinchMidNormX,
              detection.pinchMidNormY,
              sourceWidth,
              sourceHeight,
              canvas,
            );
            markers.push({ x: screen.x, y: screen.y });
          }
        }

        onPinchMarkersRef.current?.(markers);

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

      {/* TEMPORARY DEBUG BADGE — coordinate-space mismatch diagnosis */}
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
              
