// hand tracking - MINIMAL, VERIFIABLE VERSION
// MIGRATED to @mediapipe/tasks-vision (new Hand Landmarker) from the
// legacy @mediapipe/hands package.
//
// FIX (shared WASM runtime): now uses getSharedVisionFileset() instead
// of calling FilesetResolver.forVisionTasks() itself. Running two
// independent MediaPipe Tasks WASM instances at once (this one +
// AccessibilityApp's ObjectDetector) crashed with "Aborted
// (Module.noExitRuntime ...)". See mediapipe-vision-resolver.ts for
// full explanation.
//
// FIX (laser direction — 3D palm frame): direction ab X/Y/Z landmarks
// se nikalti hai (forward = middleMCP - wrist, knuckle line `right` se
// orthogonalize), 3D vector ko smooth karte hain. Origin (thumb/index
// midpoint), pinch, hysteresis, freeze, throttling UNCHANGED.
//
// NAYA (1) — INFINITE BEAM: laser ab origin se screen ke edge tak
// khinchti hai (kabhi visually khatam nahi hoti). Beam ek hi
// lightweight line hai, koi extra segment/DOM nahi.
//
// NAYA (2) — Z (DEPTH) ZYADA EFFECTIVE:
//   a) Direction ab MediaPipe `worldLandmarks` (metric, meters) se aati
//      hai — normalized z ke muqable zyada accurate depth. Agar
//      worldLandmarks na mile to purana normalized-landmark path
//      fallback hai.
//   b) Pehle 3D direction ko orthographic project karte the: z sirf
//      laser ki length chhoti karta tha, aur "camera ki taraf" vs
//      "camera se door" ka fark (z ka sign) bilkul ignore ho jaata
//      tha. Ab perspective-correct projection hai: screen par ray ki
//      direction = (dx - a*dz, dy - b*dz), jahan (a, b) hand-origin ki
//      camera-centre se offset hai (focal length ke units mein). Isse
//      z ka sign bhi laser ko ghumata hai, aur "upar -> neeche"
//      swing ke dauraan direction smoothly badalti hai (pehle
//      foreshortening ke bina flip hoti thi).
//
// DEBUG MODE ON hai by default -- har fingertip ka apna, alag-color
// dot dikhega, taaki calibration verify karna aasan ho:
//   - LAAL dot   = thumb tip (landmark 4)
//   - HARA dot   = index tip (landmark 8)
//   - PEELA dot  = wrist (landmark 0)
//   - NEELA dot  = middle-finger base knuckle (landmark 9)
//   - safed dot  = origin (thumb-index ka beech)
//   - cyan/red laser beam = origin se lekar screen edge tak

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

// Phone back-camera ka approximate horizontal field of view (degrees).
// Sirf perspective projection ke (a, b) offsets ke liye use hota hai,
// isliye exact hona zaroori nahi. Agar haath screen ke kinare par
// hone par laser ka jhukaav galat lage to isse 60-75 ke beech tune
// karo.
const CAMERA_HFOV_DEG = 65;
const TAN_HALF_HFOV = Math.tan((CAMERA_HFOV_DEG * Math.PI) / 360);

// Depth axis ka sign. MediaPipe convention: z chhota/negative = camera
// ke kareeb, bada = camera se door (x right, y down, z away). Isliye
// 1 hi sahi hona chahiye. AGAR haath camera ki taraf jhukane par laser
// ulta chale (door jaane par neeche, kareeb aane par upar), tab hi -1
// karke test karo.
const DEPTH_SIGN = 1;

// Haath seedha camera ki taraf (ya door) point kare to screen par
// laser-dot ka reach chhota ho jaata hai (foreshortening). Reach ko
// rayLength ke is ratio se neeche nahi girne dete. Beam khud edge
// tak jaati hai, ye sirf target dot/marker ke liye hai.
const MIN_PLANAR_RATIO = 0.3;

// Beam ke far end ke liye extra margin (px) taaki glow edge par na kate.
const BEAM_EDGE_MARGIN = 8;

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

// 3D pointing direction nikalta hai. Axis convention: x right, y down,
// z camera se door = positive (MediaPipe jaisa hi — koi axis invert/
// swap nahi kiya; sirf DEPTH_SIGN debug switch hai, default 1).
//
// sx/sy/sz: har axis ka scale.
//   - worldLandmarks (meters) ke liye: sx = sy = 1, sz = DEPTH_SIGN
//     (already isotropic metric units).
//   - normalized landmarks (fallback) ke liye: sx = sourceW*scale,
//     sy = sourceH*scale, sz = DEPTH_SIGN*sourceW*scale (MediaPipe z
//     ko x ke scale mein deta hai).
//
// Palm frame:
//   forward = middleMCP(9) - wrist(0)
//   right   = indexMCP(5) - pinkyMCP(17)
// forward ko `right` ke against Gram-Schmidt se orthogonalize karte
// hain taaki wrist roll se aane wala skew forward mein leak na ho
// (right ka sign matter nahi karta, left/right hand dono chalte hain).
function computePalmForward(lm: Landmark[], sx: number, sy: number, sz: number, out: Vec3): boolean {
  const w = lm[0];
  const m = lm[9];
  const i = lm[5];
  const p = lm[17];
  if (!w || !m || !i || !p) return false;

  let fx = (m.x - w.x) * sx;
  let fy = (m.y - w.y) * sy;
  let fz = (m.z - w.z) * sz;
  const fLen0 = Math.hypot(fx, fy, fz);
  if (fLen0 < 1e-9) return false;

  let rx = (i.x - p.x) * sx;
  let ry = (i.y - p.y) * sy;
  let rz = (i.z - p.z) * sz;
  const rLen = Math.hypot(rx, ry, rz);

  if (rLen > 1e-9) {
    rx /= rLen;
    ry /= rLen;
    rz /= rLen;
    const d = fx * rx + fy * ry + fz * rz;
    const ox = fx - rx * d;
    const oy = fy - ry * d;
    const oz = fz - rz * d;
    const oLen = Math.hypot(ox, oy, oz);
    // Degenerate guard: agar orthogonalize ke baad vector bahut chhota
    // reh jaaye (forward ~ right), to raw forward use karo.
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

// Perspective-correct projection of a 3D ray direction onto the screen.
//
// Camera space: O = hand origin, d = unit 3D direction. Ray P(t) = O + t*d.
// Pinhole projection u = c + f * P.x / P.z. Screen-space velocity of
// the ray at t=0 is proportional to:
//     ( dx*Oz - Ox*dz ,  dy*Oz - Oy*dz )  =  Oz * ( dx - a*dz ,  dy - b*dz )
// where a = Ox/Oz = (px - cx)/f and b = Oy/Oz = (py - cy)/f.
// Oz (haath ki depth) cancel ho jaata hai — sirf focal length f chahiye.
//
// Returns the planar magnitude (foreshortening, ~1 = ray image plane ke
// parallel, ~0 = ray seedha camera ki taraf/door, end-on). Unit screen
// direction `out` mein likhta hai; agar magnitude ~0 ho (end-on
// singularity) to `out` ko jaisa tha waisa chhod deta hai (last good
// direction) taaki jitter na ho.
function projectDirPerspective(
  origin: PxPoint,
  dir: Vec3,
  cx: number,
  cy: number,
  fPx: number,
  out: PxPoint,
): number {
  const a = (origin.x - cx) / fPx;
  const b = (origin.y - cy) / fPx;
  const sx = dir.x - a * dir.z;
  const sy = dir.y - b * dir.z;
  const mag = Math.hypot(sx, sy);
  if (mag > 1e-4) {
    out.x = sx / mag;
    out.y = sy / mag;
  }
  return mag;
}

// Origin se given unit direction mein screen ke edge tak ki distance.
function distToScreenEdge(ox: number, oy: number, ux: number, uy: number, w: number, h: number): number {
  let t = Infinity;
  if (ux > 1e-6) t = Math.min(t, (w - ox) / ux);
  else if (ux < -1e-6) t = Math.min(t, -ox / ux);
  if (uy > 1e-6) t = Math.min(t, (h - oy) / uy);
  else if (uy < -1e-6) t = Math.min(t, -oy / uy);
  return Number.isFinite(t) ? Math.max(t, 0) : 0;
}

type HandSlot = {
  smoothedOrigin: PxPoint;
  smoothedDir: Vec3; // smoothed 3D unit direction
  screenDir: PxPoint; // unit screen-space direction (perspective projected)
  reach: number; // target dot distance from origin (px)
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

      // Principal point = screen centre (cover-scaling centred hai),
      // focal length pixels mein (screen/cover space).
      const cx = screenW / 2;
      const cy = screenH / 2;
      const fPx = (sourceW * scale * 0.5) / TAN_HALF_HFOV;

      function toScreen(lm: Landmark): PxPoint {
        return {
          x: lm.x * sourceW * scale + offsetX,
          y: lm.y * sourceH * scale + offsetY,
        };
      }

      const landmarkSets: Landmark[][] = result.landmarks || [];
      const worldSets: Landmark[][] = (result as { worldLandmarks?: Landmark[][] }).worldLandmarks || [];
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

        // 3D palm-frame direction. Pehle worldLandmarks (metric, better
        // depth); na mile to normalized landmarks (fallback).
        const dir: Vec3 = { x: 0, y: 0, z: 0 };
        const wl = worldSets[i];
        const ok =
          wl && wl.length >= 21
            ? computePalmForward(wl, 1, 1, DEPTH_SIGN, dir)
            : computePalmForward(lm, sourceW * scale, sourceH * scale, DEPTH_SIGN * sourceW * scale, dir);
        if (!ok) continue;

        detections.push({ origin, dir, pinchRatio, debug: { thumb, index, wrist, middleMcp } });
      }

      const detection = detections[0];
      const rayLength = Math.min(screenW, screenH) * RAY_LENGTH_RATIO;

      if (detection) {
        let slot = handSlots[0];
        if (!slot) {
          slot = {
            smoothedOrigin: { ...detection.origin },
            smoothedDir: { ...detection.dir },
            screenDir: { x: 0, y: -1 },
            reach: rayLength,
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

          // 3D direction vector ko smooth karte hain (lerp +
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

        // NAYA: perspective-correct screen direction + foreshortening.
        const mag = projectDirPerspective(slot.smoothedOrigin, slot.smoothedDir, cx, cy, fPx, slot.screenDir);
        slot.reach = rayLength * Math.min(1, Math.max(MIN_PLANAR_RATIO, mag));

        const target: PxPoint = {
          x: slot.smoothedOrigin.x + slot.screenDir.x * slot.reach,
          y: slot.smoothedOrigin.y + slot.screenDir.y * slot.reach,
        };

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
        const origin = slot.smoothedOrigin;
        const ux = slot.screenDir.x;
        const uy = slot.screenDir.y;
        const target: PxPoint = { x: origin.x + ux * slot.reach, y: origin.y + uy * slot.reach };

        // INFINITE BEAM: origin se screen edge tak ek hi line.
        const edgeDist = distToScreenEdge(origin.x, origin.y, ux, uy, screenW, screenH) + BEAM_EDGE_MARGIN;
        const beamLen = Math.max(edgeDist, slot.reach);
        const beamEnd: PxPoint = { x: origin.x + ux * beamLen, y: origin.y + uy * beamLen };

        const color = slot.isPinching ? '#ff3b30' : '#22d3ee';
        const glow = slot.isPinching ? 'rgba(255,59,48,0.4)' : 'rgba(34,211,238,0.4)';

        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y);
        ctx.lineTo(beamEnd.x, beamEnd.y);
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

         
