// hand tracking - MINIMAL, VERIFIABLE VERSION
// MIGRATED to @mediapipe/tasks-vision (new Hand Landmarker) from the
// legacy @mediapipe/hands package.
//
// FIX (shared WASM runtime): now uses getSharedVisionFileset() instead
// of calling FilesetResolver.forVisionTasks() itself. Running two
// independent MediaPipe Tasks WASM instances at once (this one +
// AccessibilityApp's ObjectDetector) crashed with "Aborted
// (Module.noExitRuntime ...)". See mediapipe-vision-resolver.ts for
// full explanation. HandLandmarker.createFromOptions() and
// ObjectDetector.createFromOptions() can both safely share the same
// fileset — only having two separate filesets/runtimes was unsafe.
//
// FIX (laser direction — missing depth axis): pehle laser ki direction
// sirf 2D screen vector se aati thi: normalize(middleMcp - wrist) sirf
// X/Y mein. Jab haath upar se neeche (ya neeche se upar) swing hota hai
// to ungliyan camera ki taraf / camera se door jaati hain, aur ye 2D
// vector chhota hote-hote zero se guzarta hai aur flip ho jaata hai —
// normalize karne par noise amplify hota hai aur laser "ek axis miss"
// karta hua lagta hai. Ab direction 3D mein (X/Y/Z landmarks) nikalte
// hain, palm frame se orthogonalize karte hain, 3D vector ko hi smooth
// karte hain, aur sirf last step mein screen par project karte hain.
// Origin (thumb/index midpoint), pinch detection, hysteresis, freeze,
// throttling — sab UNCHANGED.
//
// DEBUG MODE ON hai by default -- har fingertip ka apna, alag-color
// dot dikhega, taaki calibration verify karna aasan ho:
//   - LAAL dot   = thumb tip (landmark 4)
//   - HARA dot   = index tip (landmark 8)
//   - PEELA dot  = wrist (landmark 0)
//   - NEELA dot  = middle-finger base knuckle (landmark 9)
//   - safed dot  = origin (thumb-index ka beech)
//   - cyan/red laser beam = origin se lekar computed target tak

import { useEffect, useRef, useState } from 'react';
import { HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import { getSharedVisionFileset } from './vr-hub/mediapipe-vision-resolver';
import { xrPoseEngine } from './vr-hub/xr-pose-engine';
import { xrCameraSource } from './vr-hub/xr-camera-source';
import { perfStats } from './vr-hub/perf-stats';

// =====================================================================
// ⚙️ SETTINGS
// =====================================================================

const DEBUG_HAND_TRACKING = true;

const MIN_DETECTION_CONFIDENCE = 0.6;
const MIN_TRACKING_CONFIDENCE = 0.5;
const MAX_NUM_HANDS = 1;

const PINCH_ENTER_THRESHOLD = 0.25;
const PINCH_EXIT_THRESHOLD = 0.4;

const MIN_HAND_SIZE = 0.08;
const FREEZE_MS = 400;

const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 480;

const PROCESS_INTERVAL_MS = 1000 / 24;
const RAY_LENGTH_RATIO = 0.4;
const SMOOTHING_ALPHA = 0.5;
const DEBUG_PERF_LOG = false;

// 3D ray ko screen par project karte waqt, agar haath seedha camera ki
// taraf (ya door) point kare to projected laser bahut chhoti ho jaati
// hai (pure 3D mein ye sahi hai), lekin target tak pahunchna
// mushkil ho jaata hai. Isliye projected length ko rayLength ke is
// ratio se neeche girne nahi dete. 0 = koi clamp nahi (pure 3D
// projection). Agar laser camera ki taraf point karte waqt bahut
// chhoti lage to isse badhao, agar zyada "fixed length" lage to ghatao.
const MIN_PLANAR_RATIO = 0.3;

// Model asset: "lite"-equivalent — fastest, lowest CPU/GPU cost.
const MODEL_ASSET_PATH =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

class PerfCounter {
  private frameCount = 0;
  private totalMs = 0;
  private windowStart = performance.now();
  private label: string;
  constructor(label: string) {
    this.label = label;
  }
  record(durationMs: number) {
    if (!DEBUG_PERF_LOG) return;
    this.frameCount++;
    this.totalMs += durationMs;
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed >= 1000) {
      const fps = (this.frameCount / elapsed) * 1000;
      const avgMs = this.totalMs / this.frameCount;
      perfStats.update({ mediapipeFps: fps, mediapipeAvgMs: avgMs });
      this.frameCount = 0;
      this.totalMs = 0;
      this.windowStart = now;
    }
  }
}

// =====================================================================

type Landmark = { x: number; y: number; z: number };
type PxPoint = { x: number; y: number };
type Vec3 = { x: number; y: number; z: number };

function dist(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// 3D pointing direction nikalta hai (screen-pixel units mein, same
// axis convention jo toScreen() use karta hai: x right, y down, z
// camera se door = positive; MediaPipe ka z bhi yahi convention hai —
// chhota/negative z = camera ke kareeb — isliye koi axis invert/swap
// NAHI kiya).
//
// Scale: MediaPipe z ko x ke (image width) scale mein dete hain, isliye
// x ko sourceW*scale, y ko sourceH*scale, z ko sourceW*scale se
// multiply karte hain. Ye wahi `scale` hai jo toScreen() mein hai, to
// x/y components pehle jaise hi rehte hain; sirf z naya add hua hai.
//
// Palm frame:
//   forward = middleMCP(9) - wrist(0)
//   right   = indexMCP(5) - pinkyMCP(17)
// forward ko `right` ke against Gram-Schmidt se orthogonalize karte
// hain (forward -= right * dot(forward, right)). Isse wrist roll se
// aane wala skew forward mein leak nahi hota, aur ye left/right hand
// ya palm/back-of-hand dono ke liye sahi rehta hai (right ka sign
// matter nahi karta).
function computePalmForward(
  lm: Landmark[],
  sx: number,
  sy: number,
  sz: number,
  out: Vec3,
): boolean {
  const w = lm[0];
  const m = lm[9];
  const i = lm[5];
  const p = lm[17];

  let fx = (m.x - w.x) * sx;
  let fy = (m.y - w.y) * sy;
  let fz = (m.z - w.z) * sz;
  const fLen0 = Math.hypot(fx, fy, fz);
  if (fLen0 < 1e-6) return false;

  let rx = (i.x - p.x) * sx;
  let ry = (i.y - p.y) * sy;
  let rz = (i.z - p.z) * sz;
  const rLen = Math.hypot(rx, ry, rz);

  if (rLen > 1e-6) {
    rx /= rLen;
    ry /= rLen;
    rz /= rLen;
    const d = fx * rx + fy * ry + fz * rz;
    const ox = fx - rx * d;
    const oy = fy - ry * d;
    const oz = fz - rz * d;
    const oLen = Math.hypot(ox, oy, oz);
    // Degenerate case guard: agar orthogonalize karne ke baad vector
    // bahut chhota reh jaaye (forward ~ right), to raw forward use karo.
    if (oLen > fLen0 * 0.2) {
      fx = ox;
      fy = oy;
      fz = oz;
    }
  }

  const len = Math.hypot(fx, fy, fz) || 1;
  out.x = fx / len;
  out.y = fy / len;
  out.z = fz / len;
  return true;
}

// 3D unit direction ko 2D screen target mein project karta hai.
// Orthographic projection: x/y components hi screen par dikhte hain,
// z (depth) laser ki projected length ko foreshorten karta hai —
// bilkul jaise asli 3D ray screen par dikhti hai.
function projectRay(origin: PxPoint, dir: Vec3, length: number): PxPoint {
  let px = dir.x;
  let py = dir.y;
  const planar = Math.hypot(px, py);
  if (planar > 1e-6 && planar < MIN_PLANAR_RATIO) {
    const s = MIN_PLANAR_RATIO / planar;
    px *= s;
    py *= s;
  }
  return { x: origin.x + px * length, y: origin.y + py * length };
}

type HandSlot = {
  smoothedOrigin: PxPoint;
  smoothedDir: Vec3;
  isPinching: boolean;
  lastGoodTime: number;
  debug: { thumb: PxPoint; index: PxPoint; wrist: PxPoint; middleMcp: PxPoint } | null;
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
    let landmarker: HandLandmarker | null = null;
    let cancelled = false;

    let lastSentWidth = CAPTURE_WIDTH;
    let lastSentHeight = CAPTURE_HEIGHT;

    function useXRCameraSource() {
      return xrPoseEngine.isActive() && xrCameraSource.isSupported();
    }

    let handSlots: HandSlot[] = [];
    const mediapipePerf = new PerfCounter('mediapipe');

    function processResults(result: HandLandmarkerResult, sourceW: number, sourceH: number) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const screenW = window.innerWidth;
      const screenH = window.innerHeight;
      canvas.width = screenW;
      canvas.height = screenH;
      ctx.clearRect(0, 0, screenW, screenH);

      const now = Date.now();

      const scale = Math.max(screenW / sourceW, screenH / sourceH);
      const offsetX = (screenW - sourceW * scale) / 2;
      const offsetY = (screenH - sourceH * scale) / 2;

      function toScreen(lm: Landmark): PxPoint {
        return {
          x: lm.x * sourceW * scale + offsetX,
          y: lm.y * sourceH * scale + offsetY,
        };
      }

      const landmarkSets: Landmark[][] = result.landmarks || [];
      const markers: PinchMarker[] = [];
      const pointMarkers: PinchMarker[] = [];

      type Detection = {
        origin: PxPoint;
        dir: Vec3;
        pinchRatio: number;
        debug: { thumb: PxPoint; index: PxPoint; wrist: PxPoint; middleMcp: PxPoint };
      };
      const detections: Detection[] = [];

      for (let i = 0; i < landmarkSets.length; i++) {
        const lm = landmarkSets[i];
        const wristLm = lm[0];
        const thumbLm = lm[4];
        const indexLm = lm[8];
        const middleMcpLm = lm[9];

        const handSize = dist(wristLm, middleMcpLm);
        if (handSize < MIN_HAND_SIZE) continue;

        // Pinch detection UNCHANGED (2D ratio, same as before).
        const pinchRatio = dist(thumbLm, indexLm) / handSize;

        const thumb = toScreen(thumbLm);
        const index = toScreen(indexLm);
        const wrist = toScreen(wristLm);
        const middleMcp = toScreen(middleMcpLm);

        // Origin UNCHANGED: thumb/index midpoint.
        const origin: PxPoint = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };

        // NAYA: 3D palm-frame direction (X/Y/Z landmarks).
        const dir: Vec3 = { x: 0, y: 0, z: 0 };
        if (!computePalmForward(lm, sourceW * scale, sourceH * scale, sourceW * scale, dir)) continue;

        detections.push({ origin, dir, pinchRatio, debug: { thumb, index, wrist, middleMcp } });
      }

      const detection = detections[0];

      if (detection) {
        let slot = handSlots[0];
        if (!slot) {
          slot = {
            smoothedOrigin: { ...detection.origin },
            smoothedDir: { ...detection.dir },
            isPinching: detection.pinchRatio < PINCH_ENTER_THRESHOLD,
            lastGoodTime: now,
            debug: detection.debug,
          };
          handSlots = [slot];
        } else {
          slot.lastGoodTime = now;
          slot.debug = detection.debug;
          slot.smoothedOrigin.x += (detection.origin.x - slot.smoothedOrigin.x) * SMOOTHING_ALPHA;
          slot.smoothedOrigin.y += (detection.origin.y - slot.smoothedOrigin.y) * SMOOTHING_ALPHA;

          // NAYA: 3D direction vector ko smooth karte hain (lerp +
          // renormalize), X/Y angles ko alag-alag nahi.
          const sd = slot.smoothedDir;
          sd.x += (detection.dir.x - sd.x) * SMOOTHING_ALPHA;
          sd.y += (detection.dir.y - sd.y) * SMOOTHING_ALPHA;
          sd.z += (detection.dir.z - sd.z) * SMOOTHING_ALPHA;
          const sdLen = Math.hypot(sd.x, sd.y, sd.z);
          if (sdLen > 1e-6) {
            sd.x /= sdLen;
            sd.y /= sdLen;
            sd.z /= sdLen;
          } else {
            sd.x = detection.dir.x;
            sd.y = detection.dir.y;
            sd.z = detection.dir.z;
          }

          slot.isPinching = slot.isPinching
            ? detection.pinchRatio < PINCH_EXIT_THRESHOLD
            : detection.pinchRatio < PINCH_ENTER_THRESHOLD;
        }

        const rayLength = Math.min(screenW, screenH) * RAY_LENGTH_RATIO;
        const target = projectRay(slot.smoothedOrigin, slot.smoothedDir, rayLength);

        if (slot.isPinching) markers.push(target);
        else pointMarkers.push(target);
      } else {
        if (handSlots[0] && now - handSlots[0].lastGoodTime > FREEZE_MS) {
          handSlots = [];
        }
      }

      onPinchMarkersRef.current?.(markers);
      onPointMarkersRef.current?.(pointMarkers);

      const slot = handSlots[0];
      if (slot) {
        const rayLength = Math.min(screenW, screenH) * RAY_LENGTH_RATIO;
        const origin = slot.smoothedOrigin;
        const target = projectRay(origin, slot.smoothedDir, rayLength);
        const color = slot.isPinching ? '#ff3b30' : '#22d3ee';
        const glow = slot.isPinching ? 'rgba(255,59,48,0.4)' : 'rgba(34,211,238,0.4)';

        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y);
        ctx.lineTo(target.x, target.y);
        ctx.strokeStyle = color;
        ctx.lineWidth = 3.5;
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.shadowBlur = 0;

        ctx.beginPath();
        ctx.arc(origin.x, origin.y, 6, 0, 2 * Math.PI);
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(target.x, target.y, slot.isPinching ? 16 : 12, 0, 2 * Math.PI);
        ctx.fillStyle = glow;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(target.x, target.y, slot.isPinching ? 7 : 5, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();

        if (DEBUG_HAND_TRACKING && slot.debug) {
          const { thumb, index, wrist, middleMcp } = slot.debug;
          const dot = (p: PxPoint, c: string, label: string) => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 8, 0, 2 * Math.PI);
            ctx.fillStyle = c;
            ctx.fill();
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 12px sans-serif';
            ctx.fillText(label, p.x + 10, p.y - 10);
          };
          dot(thumb, '#ff0000', 'THUMB');
          dot(index, '#00ff00', 'INDEX');
          dot(wrist, '#ffff00', 'WRIST');
          dot(middleMcp, '#3366ff', 'MCP');
        }
      }
    }

    async function start() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!canvas) return;

      try {
        // FIX (shared WASM runtime): use the shared fileset instead of
        // calling FilesetResolver.forVisionTasks() ourselves.
        const fileset = await getSharedVisionFileset();
        landmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: MODEL_ASSET_PATH,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: MAX_NUM_HANDS,
          minHandDetectionConfidence: MIN_DETECTION_CONFIDENCE,
          minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
        });
      } catch (err) {
        console.error('[HandTracker] Failed to init MediaPipe Tasks HandLandmarker:', err);
        if (!cancelled) setStatus('Failed to load hand tracking. Reload page.');
        return;
      }

      if (cancelled || !landmarker) return;

      let xrModeAtStart = useXRCameraSource();
      let pollAttempts = 0;
      while (!xrModeAtStart && xrPoseEngine.isActive() && pollAttempts < 40) {
        await new Promise((r) => setTimeout(r, 100));
        xrModeAtStart = useXRCameraSource();
        pollAttempts++;
      }

      if (xrModeAtStart) {
        let isProcessing = false;
        let lastProcessTime = 0;

        const unsubscribe = xrCameraSource.subscribe((xrCanvas) => {
          if (cancelled || !xrCanvas || isProcessing || !landmarker) return;

          const nowMs = performance.now();
          if (nowMs - lastProcessTime < PROCESS_INTERVAL_MS) return;
          lastProcessTime = nowMs;

          lastSentWidth = xrCanvas.width;
          lastSentHeight = xrCanvas.height;

          isProcessing = true;
          const __perfStart = DEBUG_PERF_LOG ? performance.now() : 0;
          try {
            const result = landmarker.detectForVideo(xrCanvas, performance.now());
            processResults(result, lastSentWidth, lastSentHeight);
            if (DEBUG_PERF_LOG) mediapipePerf.record(performance.now() - __perfStart);
          } catch (err) {
            // silent
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
        let lastProcessTime = 0;
        let rafId = 0;
        const loop = () => {
          if (cancelled || !landmarker) return;
          const nowMs = performance.now();
          if (video.readyState >= 2 && !isProcessing && nowMs - lastProcessTime >= PROCESS_INTERVAL_MS) {
            lastProcessTime = nowMs;
            lastSentWidth = video.videoWidth || CAPTURE_WIDTH;
            lastSentHeight = video.videoHeight || CAPTURE_HEIGHT;
            isProcessing = true;
            const __perfStart = DEBUG_PERF_LOG ? performance.now() : 0;
            try {
              const result = landmarker.detectForVideo(video, performance.now());
              processResults(result, lastSentWidth, lastSentHeight);
              if (DEBUG_PERF_LOG) mediapipePerf.record(performance.now() - __perfStart);
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
      landmarker?.close();
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
