// hand tracking - ROBUST VERSION (diagnostics + fallbacks)
// @mediapipe/tasks-vision (Hand Landmarker) use karta hai.
//
// FIX SUMMARY (is version mein kya badla):
//  1. Saari errors ab dikhti hain: pehle detectForVideo ke catch "silent"
//     the aur `status` kabhi render hi nahi hota tha. Ab screen par
//     chhota status pill + debug overlay (src / delegate / frames / hands
//     / last error) dikhta hai. DEBUG_HAND_TRACKING = false karke band karo.
//  2. Model ab pehle fetch hota hai (local /models/hand_landmarker.task,
//     phir Google storage) timeout + size check ke saath. Network /
//     service-worker / CSP issue ho to clear error milta hai.
//  3. GPU delegate fail ho to automatically CPU par fallback (init par
//     bhi, aur runtime par bhi agar detectForVideo baar-baar fail ho).
//  4. Camera: orphan stream leak fix (React StrictMode / unmount ke beech
//     getUserMedia resolve hone par stream band hota hai), video element
//     hamesha mounted, 'environment' fail ho to default camera retry.
//  5. XR <-> normal camera source ab runtime par switch hota hai (pehle
//     sirf mount ke time check hota tha). XR session mein camera
//     getUserMedia se lena aksar fail/black frame deta hai.
//  6. Frame timestamps strictly increasing (MediaPipe "monotonic" error se bachav).
//  7. rAF loop landmarker rebuild ke dauraan band nahi hota.
//
// 3D palm-frame laser direction, worldLandmarks depth, perspective
// projection, infinite beam, 3 interaction modes, pinch-click,
// click-vs-scroll logic — UNCHANGED.
//
// 3 INTERACTION MODES (hand-interaction-mode.ts se select hote hain):
//   'laser'  — visible laser beam; beam ka tip jis element par ho, pinch
//              ENTER par wahi activate hota hai.
//   'direct' — koi laser nahi. Thumb/index midpoint hi aim hai.
//   'center' — screen ke beech fixed reticle. Pinch sirf trigger hai.
//
// Activation: pinch ke false -> true transition par dwell engine ka
// activateAt(aim) EK baar call hota hai.
//
// DEBUG dots:
//   - safed dot        = thumb tip (landmark 4)
//   - halka grey dot   = index tip (landmark 8)
//   - medium grey dot  = wrist (landmark 0)
//   - dark grey dot    = middle-finger base knuckle (landmark 9)

import { useEffect, useRef, useState } from 'react';
import { HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import { getSharedVisionFileset } from './vr-hub/mediapipe-vision-resolver';
import { xrPoseEngine } from './vr-hub/xr-pose-engine';
import { xrCameraSource } from './vr-hub/xr-camera-source';
import { perfStats } from './vr-hub/perf-stats';
import { useOptionalDwellEngine } from './vr-hub/dwell-engine';
import {
  getHandInteractionMode,
  subscribeHandInteractionMode,
  type HandInteractionMode,
} from './vr-hub/hand-interaction-mode';

// =====================================================================
// ⚙️ SETTINGS
// =====================================================================

// true = dots + top-left diagnostics overlay + status pill. Sab theek
// chalne ke baad false kar do.
const DEBUG_HAND_TRACKING = true;

const MIN_DETECTION_CONFIDENCE = 0.6;
const MIN_TRACKING_CONFIDENCE = 0.5;
const MAX_NUM_HANDS = 1;

const PINCH_ENTER_THRESHOLD = 0.25;
const PINCH_EXIT_THRESHOLD = 0.4;

const MIN_HAND_SIZE = 0.08;
const FREEZE_MS = 400;

// CLICK vs SCROLL: click pinch shuru hote hi nahi, CLICK_DELAY_MS ke baad
// (ya usse pehle pinch chhodne par) hota hai. Is gap mein pinch point
// SCROLL_INTENT_PX se zyada upar/neeche hila to scroll maana jaata hai
// aur click cancel ho jaata hai.
const CLICK_DELAY_MS = 150; // 220 se kam: pinch ke baad click jaldi (lag feel kam)
const SCROLL_INTENT_PX = 16;

const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 480;

// FPS: mode ke hisaab se. Asal rate device ki MediaPipe speed se limit
// hoti hai (isProcessing guard overlap rokta hai).
//   laser  — smooth beam chahiye -> sabse zyada fps
//   direct — smooth cursor chahiye
//   center — sirf pinch + scroll detect karna hai -> kam fps kaafi
// IDLE_FPS: haath ~0.4s se nahi dikha to dheema scan.
//
// ADAPTIVE SCHEDULER (XR ko priority): MediaPipe main thread par chalta
// hai aur har inference ke dauraan XR/DOM frame ruka rehta hai. Isliye
// detection rate ab fixed nahi — har 0.5s par XR fps naapa jaata hai:
//   XR fps < XR_TARGET_FPS  -> detection ka gap badhta hai (XR ko jagah)
//   XR fps > XR_TARGET_FPS+4 -> gap wapas ghatta hai (tracking tez)
// FPS_BY_MODE ab sirf UPAR ki seema (cap) hai; asli rate device decide karta hai.
const FPS_BY_MODE: Record<HandInteractionMode, number> = {
  laser: 30,
  direct: 30,
  center: 30,
};
// Haath nahi dikh raha tab palm-detector (sabse mehnga part) har frame
// chalta hai — 12 se 8 fps: idle mein ~35% kam main-thread load.
const IDLE_FPS = 8;
const XR_TARGET_FPS = 24;
// Detection is se neeche kabhi nahi jaayega (warna tracking bekaar).
const MIN_DET_FPS = 9;
// Inference ke baad kam se kam itna x gap (back-to-back chalne se bachav).
const MIN_GAP_AFTER_INFERENCE = 1.3;
// 'GPU' ya 'CPU'. Agar GPU par XR fps girta hai (GPU XR ke saath contend
// karta hai) to 'CPU' try karo aur overlay ke inf/xr numbers compare karo.
const PREFERRED_DELEGATE: 'GPU' | 'CPU' = 'GPU';
const RAY_LENGTH_RATIO = 0.4;

// SMOOTHING: One Euro filter (time-based).
//   MIN_CUTOFF_HZ: kam = ruke haath par zyada smooth
//   BETA: zyada = tez movement par kam lag
// Detection 14-18fps par ho tab purani values (1.0 / 0.02) dheere haath par
// ~150ms lag deti thi; thodi tez values lag kam karti hain, jitter abhi bhi dabta hai.
const ORIGIN_MIN_CUTOFF_HZ = 1.2;
const ORIGIN_BETA = 0.06; // origin pixels mein hai
const DIR_MIN_CUTOFF_HZ = 0.8;
const DIR_BETA = 1.5; // direction unit-vector components hain
const FILTER_D_CUTOFF_HZ = 1.0;
const DEBUG_PERF_LOG = false;

// Phone back-camera ka approximate horizontal field of view (degrees).
const CAMERA_HFOV_DEG = 65;
const TAN_HALF_HFOV = Math.tan((CAMERA_HFOV_DEG * Math.PI) / 360);

// Depth axis ka sign. Haath camera ki taraf jhukane par laser ulta chale
// tab hi -1 karke test karo.
const DEPTH_SIGN = 1;

// Foreshortening floor.
const MIN_PLANAR_RATIO = 0.3;

// Beam ke far end ke liye extra margin (px).
const BEAM_EDGE_MARGIN = 8;

// Model: pehle local file try hoti hai (agar tumne public/models/ mein
// rakhi ho — sabse reliable, offline/PWA mein bhi chalti hai), warna
// Google storage se.
const MODEL_ASSET_PATH =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const MODEL_URLS = ['/models/hand_landmarker.task', MODEL_ASSET_PATH];
const MODEL_FETCH_TIMEOUT_MS = 25000;
const MODEL_MIN_BYTES = 1000000; // asli model ~7.8MB; HTML error page isse chhota hota hai

// detectForVideo itni baar lagatar fail ho (GPU par) to CPU par switch.
const GPU_FAIL_THRESHOLD = 20;

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
type Delegate = 'GPU' | 'CPU';
type SourceKind = 'xr' | 'camera';
type VisionFileset = Awaited<ReturnType<typeof getSharedVisionFileset>>;
type ImageInput = Parameters<HandLandmarker['detectForVideo']>[0];

function errMsg(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// One Euro filter (adaptive low-pass): ruke haath par jitter hatata hai,
// tez movement par lag nahi deta. tSec = seconds mein timestamp.
function oneEuroAlpha(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

class OneEuro {
  private xPrev = 0;
  private dxPrev = 0;
  private tPrev = 0;
  private ready = false;
  private minCutoff: number;
  private beta: number;

  constructor(minCutoff: number, beta: number) {
    this.minCutoff = minCutoff;
    this.beta = beta;
  }

  filter(x: number, tSec: number): number {
    if (!this.ready) {
      this.xPrev = x;
      this.dxPrev = 0;
      this.tPrev = tSec;
      this.ready = true;
      return x;
    }
    const dt = Math.max(1e-3, tSec - this.tPrev);
    this.tPrev = tSec;
    const dx = (x - this.xPrev) / dt;
    this.dxPrev += oneEuroAlpha(FILTER_D_CUTOFF_HZ, dt) * (dx - this.dxPrev);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev);
    this.xPrev += oneEuroAlpha(cutoff, dt) * (x - this.xPrev);
    return this.xPrev;
  }
}

function dist(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// 3D pointing direction (x right, y down, z camera se door = positive).
// sx/sy/sz: har axis ka scale (worldLandmarks ke liye 1,1,DEPTH_SIGN).
// Palm frame: forward = middleMCP(9) - wrist(0), right = indexMCP(5) -
// pinkyMCP(17); forward ko right ke against Gram-Schmidt se
// orthogonalize karte hain (roll skew leak nahi hota).
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

// Perspective-correct projection of a 3D ray direction onto the screen
// (screen dir = (dx - a*dz, dy - b*dz), a/b = hand-origin ka camera-
// centre se offset focal-length units mein; Oz cancel ho jaata hai).
// End-on singularity (magnitude ~0) par `out` ko last good direction par
// chhod deta hai.
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
  filters: { ox: OneEuro; oy: OneEuro; dx: OneEuro; dy: OneEuro; dz: OneEuro };
  debug: { thumb: PxPoint; index: PxPoint; wrist: PxPoint; middleMcp: PxPoint } | null;
};

// Haath ka "marker" point — dwell engine ko jaata hai (drag-scroll /
// accessibility ke liye) aur laser/direct mode mein aim bhi yahi hai.
//   center/direct: thumb/index midpoint (pinch point)
//   laser: laser tip (origin + screenDir * reach)
function markerFor(slot: HandSlot, mode: HandInteractionMode): PxPoint {
  if (mode !== 'laser') return { x: slot.smoothedOrigin.x, y: slot.smoothedOrigin.y };
  return {
    x: slot.smoothedOrigin.x + slot.screenDir.x * slot.reach,
    y: slot.smoothedOrigin.y + slot.screenDir.y * slot.reach,
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
  // Status ab screen par dikhta hai (pehle render hi nahi hota tha).
  const [status, setStatus] = useState<string>('Loading hand tracking...');
  const [debugText, setDebugText] = useState<string>('');
  // xrMode ab state hai (watchdog update karta hai) taaki XR start/end
  // par UI sahi re-render ho.
  const [xrMode, setXrMode] = useState<boolean>(() => xrPoseEngine.isActive() && xrCameraSource.isSupported());

  const onPinchMarkersRef = useRef(onPinchMarkers);
  onPinchMarkersRef.current = onPinchMarkers;
  const onPointMarkersRef = useRef(onPointMarkers);
  onPointMarkersRef.current = onPointMarkers;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // Dwell engine (agar DwellProvider ke andar mount hai) — pinch
  // activation + hover hit-test ke liye.
  const dwell = useOptionalDwellEngine();
  const dwellRef = useRef(dwell);
  dwellRef.current = dwell;

  // Selected interaction mode — ref (per-frame loop padhta hai).
  const modeRef = useRef<HandInteractionMode>(getHandInteractionMode());
  useEffect(() => {
    modeRef.current = getHandInteractionMode();
    return subscribeHandInteractionMode((m) => {
      modeRef.current = m;
    });
  }, []);

  // HandTracker mount hote hi dwell engine ko pinch-click mode mein
  // daalo; unmount par purana dwell behavior wapas.
  useEffect(() => {
    const d = dwellRef.current;
    if (!d) return;
    d.setSelectMode('pinch-click');
    return () => d.setSelectMode('dwell');
  }, []);

  useEffect(() => {
    let cancelled = false;
    let landmarker: HandLandmarker | null = null;
    let fileset: VisionFileset | null = null;
    let modelBuffer: ArrayBuffer | null = null;
    let delegateInUse: Delegate = 'GPU';
    let rebuilding = false;
    let consecutiveErrors = 0;
    let lastTs = 0;
    let readyFired = false;
    let processErrorLogs = 0;

    let lastSentWidth = CAPTURE_WIDTH;
    let lastSentHeight = CAPTURE_HEIGHT;

    // Debug overlay ke liye counters.
    const stats = {
      source: 'none' as 'none' | SourceKind,
      delegate: '-' as string,
      frames: 0,
      hands: 0,
      lastError: '',
      infMs: 0, // average inference time (ms)
      detFps: 0, // detection fps (measured)
      xrFps: 0, // XR frame fps (measured)
    };

    // Adaptive scheduler state (currentIntervalMs ke upar use hota hai).
    let intervalScale = 1;
    let infEma = 0;
    let detCount = 0;

    function shouldUseXRCamera() {
      return xrPoseEngine.isActive() && xrCameraSource.isSupported();
    }

    let handSlots: HandSlot[] = [];
    // Pinch ENTER par ban-ne wala click, jo gap ke baad fire hota hai
    // (ya cancel hota hai agar scroll-intent mile / tracking lost ho).
    let pendingClick: { aim: PxPoint; startY: number; startMs: number } | null = null;

    // Mode + haath ki maujoodgi ke hisaab se processing interval (ms).
    function currentIntervalMs(): number {
      const fps = handSlots.length > 0 ? FPS_BY_MODE[modeRef.current] : IDLE_FPS;
      const maxInterval = 1000 / MIN_DET_FPS;
      // XR fps ke hisaab se scale, par inference ke baad kam se kam
      // MIN_GAP_AFTER_INFERENCE x gap (main thread ko saans lene do).
      const wanted = Math.max((1000 / fps) * intervalScale, infEma * MIN_GAP_AFTER_INFERENCE);
      return Math.min(maxInterval, wanted) - 2;
    }

    // Hover check (DOM rect reads) center mode mein har frame zaroori nahi.
    let lastPeekMs = 0;
    let cachedHover: DOMRect | null = null;
    const mediapipePerf = new PerfCounter('mediapipe');

    function processResults(result: HandLandmarkerResult, sourceW: number, sourceH: number) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const mode = modeRef.current;
      // Direct/center mode ko laser direction ki zarurat nahi.
      const needsDir = mode === 'laser';

      const screenW = window.innerWidth;
      const screenH = window.innerHeight;
      // canvas.width/height sirf size badalne par set karo (mobile par mehnga).
      if (canvas.width !== screenW) canvas.width = screenW;
      if (canvas.height !== screenH) canvas.height = screenH;
      ctx.clearRect(0, 0, screenW, screenH);

      const now = Date.now();
      const tSec = performance.now() / 1000;

      const scale = Math.max(screenW / sourceW, screenH / sourceH);
      const offsetX = (screenW - sourceW * scale) / 2;
      const offsetY = (screenH - sourceH * scale) / 2;

      // Principal point = screen centre (cover-scaling centred hai).
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
      stats.hands = landmarkSets.length;

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
        if (!wristLm || !thumbLm || !indexLm || !middleMcpLm) continue;

        const handSize = dist(wristLm, middleMcpLm);
        if (handSize < MIN_HAND_SIZE) continue;

        // Pinch detection (2D ratio).
        const pinchRatio = dist(thumbLm, indexLm) / handSize;

        const thumb = toScreen(thumbLm);
        const index = toScreen(indexLm);
        const wrist = toScreen(wristLm);
        const middleMcp = toScreen(middleMcpLm);

        // Origin: thumb/index midpoint.
        const origin: PxPoint = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };

        const dir: Vec3 = { x: 0, y: 0, z: 0 };
        if (needsDir) {
          const wl = worldSets[i];
          const ok =
            wl && wl.length >= 21
              ? computePalmForward(wl, 1, 1, DEPTH_SIGN, dir)
              : computePalmForward(lm, sourceW * scale, sourceH * scale, DEPTH_SIGN * sourceW * scale, dir);
          if (!ok) continue;
        }

        detections.push({ origin, dir, pinchRatio, debug: { thumb, index, wrist, middleMcp } });
      }

      const detection = detections[0];
      const rayLength = Math.min(screenW, screenH) * RAY_LENGTH_RATIO;

      if (detection){
        let slot = handSlots[0];
        // Pinch rising edge sirf tab jab slot pehle se maujood tha aur
        // pichhle frame mein pinch NAHI tha. Naya slot kabhi click nahi banata.
        let pinchEnter = false;

        if (!slot) {
          slot = {
            smoothedOrigin: { ...detection.origin },
            smoothedDir: { ...detection.dir },
            screenDir: { x: 0, y: -1 },
            reach: rayLength,
            isPinching: detection.pinchRatio < PINCH_ENTER_THRESHOLD,
            lastGoodTime: now,
            filters: {
              ox: new OneEuro(ORIGIN_MIN_CUTOFF_HZ, ORIGIN_BETA),
              oy: new OneEuro(ORIGIN_MIN_CUTOFF_HZ, ORIGIN_BETA),
              dx: new OneEuro(DIR_MIN_CUTOFF_HZ, DIR_BETA),
              dy: new OneEuro(DIR_MIN_CUTOFF_HZ, DIR_BETA),
              dz: new OneEuro(DIR_MIN_CUTOFF_HZ, DIR_BETA),
            },
            debug: detection.debug,
          };
          // Filters ko pehli value se seed karo (pehle frame mein jump nahi).
          slot.filters.ox.filter(detection.origin.x, tSec);
          slot.filters.oy.filter(detection.origin.y, tSec);
          if (needsDir) {
            slot.filters.dx.filter(detection.dir.x, tSec);
            slot.filters.dy.filter(detection.dir.y, tSec);
            slot.filters.dz.filter(detection.dir.z, tSec);
          }
          handSlots = [slot];
        } else {
          slot.lastGoodTime = now;
          slot.debug = detection.debug;
          slot.smoothedOrigin.x = slot.filters.ox.filter(detection.origin.x, tSec);
          slot.smoothedOrigin.y = slot.filters.oy.filter(detection.origin.y, tSec);

          if (needsDir) {
            // 3D direction vector ke teeno components ko filter karke
            // renormalize karte hain (X/Y angles alag-alag nahi).
            const sd = slot.smoothedDir;
            sd.x = slot.filters.dx.filter(detection.dir.x, tSec);
            sd.y = slot.filters.dy.filter(detection.dir.y, tSec);
            sd.z = slot.filters.dz.filter(detection.dir.z, tSec);
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
          }

          const wasPinching = slot.isPinching;
          slot.isPinching = slot.isPinching
            ? detection.pinchRatio < PINCH_EXIT_THRESHOLD
            : detection.pinchRatio < PINCH_ENTER_THRESHOLD;
          pinchEnter = !wasPinching && slot.isPinching;
        }

        if (needsDir) {
          const mag = projectDirPerspective(slot.smoothedOrigin, slot.smoothedDir, cx, cy, fPx, slot.screenDir);
          slot.reach = rayLength * Math.min(1, Math.max(MIN_PLANAR_RATIO, mag));
        }

        const marker = markerFor(slot, mode);
        if (slot.isPinching) markers.push(marker);
        else pointMarkers.push(marker);

        // ACTIVATION: sirf pinch ENTER par, ek baar. Center mode mein
        // aim = screen centre.
        //
        // CLICK vs SCROLL: pinch ENTER par click turant nahi, pending
        // click banta hai. Fir:
        //   - pinch point SCROLL_INTENT_PX se zyada upar/neeche hila
        //     -> scroll ka irada, click cancel
        //   - pinch chhoda ya CLICK_DELAY_MS beet gaya -> click EK baar fire
        if (pinchEnter) {
          const aim: PxPoint = mode === 'center' ? { x: cx, y: cy } : marker;
          pendingClick = { aim, startY: marker.y, startMs: performance.now() };
        } else if (pendingClick) {
          if (Math.abs(marker.y - pendingClick.startY) > SCROLL_INTENT_PX) {
            pendingClick = null; // scroll intent — click nahi
          } else if (!slot.isPinching || performance.now() - pendingClick.startMs >= CLICK_DELAY_MS) {
            const aim = pendingClick.aim;
            pendingClick = null;
            dwellRef.current?.activateAt(aim);
          }
        }
      } else {
        // Tracking lost: pending click cancel (kuch accidentally click nahi).
        pendingClick = null;
        if (handSlots[0] && now - handSlots[0].lastGoodTime > FREEZE_MS) {
          handSlots = [];
        }
      }

      onPinchMarkersRef.current?.(markers);
      onPointMarkersRef.current?.(pointMarkers);

      // ----------------------------- DRAW -----------------------------
      const slot = handSlots[0];

      // Hover/aim feedback: wahi hit-test jo activation use karta hai.
      const aimPt: PxPoint | null = mode === 'center' ? { x: cx, y: cy } : slot ? markerFor(slot, mode) : null;
      let hoverRect: DOMRect | null = null;
      if (aimPt) {
        const peekNow = performance.now();
        if (mode !== 'center' || peekNow - lastPeekMs >= 100) {
          cachedHover = dwellRef.current?.peekTargetAt(aimPt) ?? null;
          lastPeekMs = peekNow;
        }
        hoverRect = cachedHover;
      }

      // MODE 3: fixed center reticle (haath na dikhe tab bhi dikhta hai).
      if (mode === 'center') {
        const pinching = !!slot && slot.isPinching;
        const rc = pinching ? '#a3a3a3' : hoverRect ? '#ffffff' : '#e5e5e5';
        const ringR = pinching ? 7 : hoverRect ? 12 : 9;
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, 0, 2 * Math.PI);
        ctx.lineWidth = 4.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, 0, 2 * Math.PI);
        ctx.lineWidth = 2;
        ctx.strokeStyle = rc;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
        ctx.fillStyle = rc;
        ctx.fill();
      }

      if (slot) {
        const origin = slot.smoothedOrigin;

        if (mode === 'laser') {
          const ux = slot.screenDir.x;
          const uy = slot.screenDir.y;
          const target: PxPoint = { x: origin.x + ux * slot.reach, y: origin.y + uy * slot.reach };

          // INFINITE BEAM: origin se screen edge tak ek hi line.
          const edgeDist = distToScreenEdge(origin.x, origin.y, ux, uy, screenW, screenH) + BEAM_EDGE_MARGIN;
          const beamLen = Math.max(edgeDist, slot.reach);
          const beamEnd: PxPoint = { x: origin.x + ux * beamLen, y: origin.y + uy * beamLen };

          const color = slot.isPinching ? '#a3a3a3' : '#ffffff';
          const glow = slot.isPinching ? 'rgba(163,163,163,0.35)' : 'rgba(255,255,255,0.35)';

          ctx.beginPath();
          ctx.moveTo(origin.x, origin.y);
          ctx.lineTo(beamEnd.x, beamEnd.y);
          ctx.strokeStyle = color;
          ctx.lineWidth = 3;
          // Dark shadow taaki white beam bright background par bhi dikhe.
          ctx.shadowColor = 'rgba(0,0,0,0.7)';
          ctx.shadowBlur = 6;
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
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = 'rgba(0,0,0,0.7)';
          ctx.stroke();
        } else if (mode === 'direct') {
          // MODE 2: koi beam/trail/glow nahi — sirf pinch-point cursor.
          const color = slot.isPinching ? '#a3a3a3' : hoverRect ? '#ffffff' : '#e5e5e5';
          ctx.beginPath();
          ctx.arc(origin.x, origin.y, 11, 0, 2 * Math.PI);
          ctx.lineWidth = 4.5;
          ctx.strokeStyle = 'rgba(0,0,0,0.55)';
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(origin.x, origin.y, 11, 0, 2 * Math.PI);
          ctx.lineWidth = 2;
          ctx.strokeStyle = color;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(origin.x, origin.y, 3.5, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        }
        // mode === 'center': haath ke liye koi pointer draw nahi hota.

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
          dot(thumb, '#ffffff', 'THUMB');
          dot(index, '#d4d4d4', 'INDEX');
          dot(wrist, '#8a8a8a', 'WRIST');
          dot(middleMcp, '#404040', 'MCP');
        }
      }
    }

    // =================================================================
    // DETECTION RUNNER (errors ab chhupte nahi)
    // =================================================================

    // MediaPipe VIDEO mode ko strictly increasing timestamps chahiye.
    function nextTimestamp(): number {
      const t = Math.round(performance.now());
      lastTs = t > lastTs ? t : lastTs + 1;
      return lastTs;
    }

    function handleDetectError(err: unknown) {
      consecutiveErrors++;
      stats.lastError = 'detect: ' + errMsg(err);
      if (consecutiveErrors <= 3) console.error('[HandTracker] detectForVideo failed:', err);
      if (consecutiveErrors === GPU_FAIL_THRESHOLD) {
        if (delegateInUse === 'GPU') {
          void rebuildOnCpu();
        } else if (!cancelled) {
          setStatus('Hand tracking errors: ' + errMsg(err));
        }
      }
    }

    function runDetection(input: ImageInput, w: number, h: number) {
      const lm = landmarker;
      if (!lm || rebuilding) return;
      const perfStart = DEBUG_PERF_LOG ? performance.now() : 0;

      let result: HandLandmarkerResult;
      const infStart = performance.now();
      try {
        result = lm.detectForVideo(input, nextTimestamp());
      } catch (err) {
        handleDetectError(err);
        return;
      }
      const infDt = performance.now() - infStart;
      infEma = infEma === 0 ? infDt : infEma * 0.85 + infDt * 0.15;
      consecutiveErrors = 0;
      stats.frames++;
      detCount++;

      try {
        processResults(result, w, h);
      } catch (err) {
        stats.lastError = 'process: ' + errMsg(err);
        if (processErrorLogs < 5) {
          processErrorLogs++;
          console.error('[HandTracker] processResults failed:', err);
        }
      }
      if (DEBUG_PERF_LOG) mediapipePerf.record(performance.now() - perfStart);
    }

    // =================================================================
    // MODEL + LANDMARKER INIT
    // =================================================================

    async function fetchModel(url: string): Promise<ArrayBuffer> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), MODEL_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (buf.byteLength < MODEL_MIN_BYTES) {
          throw new Error(`model file too small (${buf.byteLength} bytes) — shayad HTML error page`);
        }
        return buf;
      } finally {
        clearTimeout(timer);
      }
    }

    async function loadModelBuffer(): Promise<ArrayBuffer> {
      let lastErr: unknown = null;
      for (const url of MODEL_URLS) {
        try {
          return await fetchModel(url);
        } catch (err) {
          lastErr = err;
          console.warn('[HandTracker] model load failed from', url, '-', errMsg(err));
          if (cancelled) break;
        }
      }
      throw lastErr ?? new Error('model load failed');
    }

    function createLandmarker(fs: VisionFileset, buf: ArrayBuffer, delegate: Delegate) {
      return HandLandmarker.createFromOptions(fs, {
        baseOptions: {
          modelAssetBuffer: new Uint8Array(buf),
          delegate,
        },
        runningMode: 'VIDEO',
        numHands: MAX_NUM_HANDS,
        minHandDetectionConfidence: MIN_DETECTION_CONFIDENCE,
        minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
      });
    }

    async function initLandmarker(): Promise<boolean> {
      try {
        fileset = await getSharedVisionFileset();
        if (cancelled) return false;
        modelBuffer = await loadModelBuffer();
        if (cancelled) return false;
      } catch (err) {
        console.error('[HandTracker] WASM/model load failed:', err);
        stats.lastError = 'init: ' + errMsg(err);
        if (!cancelled) setStatus('Hand tracking load failed: ' + errMsg(err));
        return false;
      }

      if (!fileset || !modelBuffer) return false;
      const fs = fileset;
      const buf = modelBuffer;

      const delegates: Delegate[] = PREFERRED_DELEGATE === 'GPU' ? ['GPU', 'CPU'] : ['CPU', 'GPU'];
      for (const delegate of delegates) {
        try {
          const lm = await createLandmarker(fs, buf, delegate);
          if (cancelled) {
            lm.close();
            return false;
          }
          landmarker = lm;
          delegateInUse = delegate;
          stats.delegate = delegate;
          return true;
        } catch (err) {
          console.error(`[HandTracker] ${delegate} delegate init failed:`, err);
          stats.lastError = `${delegate} init: ` + errMsg(err);
        }
      }
      if (!cancelled) setStatus('Could not start hand tracking engine. Reload page.');
      return false;
    }

    // GPU runtime par baar-baar fail ho to CPU par rebuild.
    async function rebuildOnCpu() {
      if (rebuilding || !fileset || !modelBuffer) return;
      rebuilding = true;
      console.warn('[HandTracker] GPU delegate failing — CPU par switch kar raha hoon');
      try {
        landmarker?.close();
      } catch {
        // ignore
      }
      landmarker = null;
      try {
        const lm = await createLandmarker(fileset, modelBuffer, 'CPU');
        if (cancelled) {
          lm.close();
          return;
        }
        landmarker = lm;
        delegateInUse = 'CPU';
        stats.delegate = 'CPU';
        consecutiveErrors = 0;
      } catch (err) {
        stats.lastError = 'cpu rebuild: ' + errMsg(err);
        if (!cancelled) setStatus('Hand tracking engine failed to restart. Reload page.');
      } finally {
        rebuilding = false;
      }
    }

    // =================================================================
    // FRAME SOURCES (XR canvas ya normal camera) — runtime par switch
    // =================================================================

    let sourceGen = 0;
    let sourceKind: SourceKind | null = null;
    let stopSource: (() => void) | null = null;
    let starting = false;
    // XR source chal raha ho par koi frame na aaye to user ko batao.
    let xrSince = 0;
    let stallReported = false;

    function teardownSource() {
      const stop = stopSource;
      stopSource = null;
      sourceKind = null;
      stats.source = 'none';
      try {
        stop?.();
      } catch {
        // ignore
      }
    }

    function markReady() {
      if (cancelled) return;
      setStatus('');
      if (!readyFired) {
        readyFired = true;
        onReadyRef.current?.();
      }
    }

    function startXRSource() {
      let isProcessing = false;
      let lastProcessTime = 0;
      let frameFresh = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      // Detection XR frame callback ke BAAD (alag macrotask mein) chalta
      // hai: pehle is frame ka pose/DOM update ho jaata hai, phir inference.
      // Pehle inference usi callback ke andar chalta tha aur pose update
      // ko inference ke ~30ms peeche kar deta tha (panel jitter).
      // Canvas same object hai jo jagah-jagah overwrite hota hai, isliye
      // run() hamesha sabse taaza frame dekhta hai.
      const run = () => {
        timer = null;
        if (cancelled || !frameFresh || isProcessing || !landmarker || rebuilding) return;
        const canvas = xrCameraSource.getCanvas();
        if (!canvas || !canvas.width || !canvas.height) return;

        frameFresh = false;
        lastProcessTime = performance.now();
        lastSentWidth = canvas.width;
        lastSentHeight = canvas.height;

        isProcessing = true;
        try {
          runDetection(canvas, lastSentWidth, lastSentHeight);
        } finally {
          isProcessing = false;
        }
      };

      const unsubscribe = xrCameraSource.subscribe((xrCanvas) => {
        if (cancelled || !xrCanvas) return;
        frameFresh = true;
        if (timer !== null) return;
        const wait = Math.max(0, lastProcessTime + currentIntervalMs() - performance.now());
        timer = setTimeout(run, wait);
      });

      xrCameraSource.setProcessInterval(currentIntervalMs() - 10);

      stopSource = () => {
        unsubscribe();
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
      sourceKind = 'xr';
      stats.source = 'xr';
      markReady();
    }

    async function startCameraSource(gen: number): Promise<void> {
      const video = videoRef.current;
      if (!video) {
        if (!cancelled) setStatus('Video element missing.');
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (!cancelled) setStatus('Camera API unavailable (HTTPS chahiye).');
        return;
      }
      if (!cancelled) setStatus('Requesting camera access...');

      const attempts: MediaStreamConstraints[] = [
        {
          video: {
            facingMode: 'environment',
            width: { ideal: CAPTURE_WIDTH },
            height: { ideal: CAPTURE_HEIGHT },
          },
        },
        { video: true }, // 'environment' fail ho to koi bhi camera
      ];

      let stream: MediaStream | null = null;
      let lastErr: unknown = null;
      for (const constraints of attempts) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          break;
        } catch (err) {
          lastErr = err;
          if (cancelled || gen !== sourceGen) return;
        }
      }

      if (!stream) {
        stats.lastError = 'camera: ' + errMsg(lastErr);
        console.error('[HandTracker] getUserMedia failed:', lastErr);
        if (!cancelled && gen === sourceGen) setStatus('Camera access failed: ' + errMsg(lastErr));
        return;
      }

      // Unmount / source switch ke dauraan stream aa gayi to turant band
      // karo, warna camera lock ho jaata hai (orphan stream).
      const stopTracks = () => stream?.getTracks().forEach((t) => t.stop());
      if (cancelled || gen !== sourceGen) {
        stopTracks();
        return;
      }

      video.srcObject = stream;
      try {
        await video.play();
      } catch (err) {
        stopTracks();
        if (video.srcObject === stream) video.srcObject = null;
        stats.lastError = 'video.play: ' + errMsg(err);
        if (!cancelled && gen === sourceGen) setStatus('Camera preview could not start: ' + errMsg(err));
        return;
      }
      if (cancelled || gen !== sourceGen) {
        stopTracks();
        if (video.srcObject === stream) video.srcObject = null;
        return;
      }

      let isProcessing = false;
      let lastProcessTime = 0;
      let rafId = 0;
      const activeStream = stream;

      const loop = () => {
        if (cancelled || gen !== sourceGen) return;
        const nowMs = performance.now();
        if (
          landmarker &&
          !rebuilding &&
          video.readyState >= 2 &&
        
