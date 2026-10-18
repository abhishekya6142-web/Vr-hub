// hand tracking - MINIMAL, VERIFIABLE VERSION
// MIGRATED to @mediapipe/tasks-vision (new Hand Landmarker) from the
// legacy @mediapipe/hands package.
//
// FIX (shared WASM runtime): now uses getSharedVisionFileset() instead
// of calling FilesetResolver.forVisionTasks() itself. See
// mediapipe-vision-resolver.ts for full explanation.
//
// 3D palm-frame laser direction, worldLandmarks depth, perspective
// projection, infinite beam — UNCHANGED from the previous version.
//
// NAYA — 3 INTERACTION MODES (hand-interaction-mode.ts se select hote
// hain, settings screen mein badalte hain, mode ek ref se padha jaata
// hai isliye switch karne par landmarker / XR / loop kuch restart
// NAHI hota):
//   'laser'  — visible laser beam; beam ka tip (aim) jis element par
//              ho, pinch ENTER par wahi activate hota hai.
//   'direct' — koi laser nahi. Thumb/index midpoint (pinch point) hi
//              aim hai; uske neeche ka element pinch ENTER par activate.
//   'center' — screen ke exact beech fixed reticle. Aim = screen
//              centre. Pinch haath kahin bhi ho, sirf trigger hai.
//
// Hand-landmark detection mode se independent hai. Mode sirf teen
// cheezein decide karta hai: aim point kahan hai, kya draw hota hai,
// aur activation kis point par hoti hai.
//
// Activation: pinch ke false -> true transition (rising edge) par
// dwell engine ka activateAt(aim) EK baar call hota hai. Pinch hold
// rehne par dobara click nahi hota. Hand untracked (FREEZE_MS) ho jaaye
// to slot reset hota hai, wapas aane par "already pinching" frame click
// nahi banta. Pinch markers pehle ki tarah dwell engine ko jaate hain
// (drag-scroll aur accessibility ke liye); dwell-select pinch-click
// mode mein band rehta hai, isliye double-activation nahi hoti.
//
// DEBUG MODE ON hai by default -- har fingertip ka apna, alag-color
// dot dikhega, taaki calibration verify karna aasan ho:
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

const DEBUG_HAND_TRACKING = true;

const MIN_DETECTION_CONFIDENCE = 0.6;
const MIN_TRACKING_CONFIDENCE = 0.5;
const MAX_NUM_HANDS = 1;

const PINCH_ENTER_THRESHOLD = 0.25;
const PINCH_EXIT_THRESHOLD = 0.4;

const MIN_HAND_SIZE = 0.08;
const FREEZE_MS = 400;

// CLICK vs SCROLL: click ab pinch shuru hote hi nahi, thoda gap (CLICK_
// DELAY_MS) ke baad (ya usse pehle pinch chhodne par) hota hai. Is gap
// ke dauraan agar pinch point SCROLL_INTENT_PX se zyada upar/neeche
// hila to wo scroll maana jaata hai aur click cancel ho jaata hai.
// Abhi bhi scroll karte waqt click ho jaaye to CLICK_DELAY_MS badhao
// (bahut bada = click sirf pinch chhodne par). Click slow lage to ghatao.
const CLICK_DELAY_MS = 220;
const SCROLL_INTENT_PX = 16;

const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 480;

// FPS: pehle 24fps par throttle tha. Ab 60 target hai; asal rate device
// ki MediaPipe speed se limit hoti hai (isProcessing guard overlap rokta
// hai), isliye ye "jitna tez ho sake" hai. Agar phone garam ho / AR
// panels lag karein to 30 kar do. "-2ms" isliye ki ~16.6ms ke frame
// timing jitter se alternate frames skip hokar 30fps na ban jaaye.
// Power: har mode ko utni hi processing jitni usse chahiye.
//   laser  — smooth beam chahiye -> sabse zyada fps
//   direct — smooth cursor chahiye
//   center — sirf pinch + scroll detect karna hai, reticle fixed hai
//            -> kam fps kaafi (MediaPipe ke frames hi asli power kharch
//            hain, isliye frame kam = seedha power kam)
// IDLE_FPS: jab haath ~0.4s se nahi dikha, sirf "haath aaya?" check
// karne ke liye bahut dheema scan; haath dikhte hi wapas mode ke fps par.
const FPS_BY_MODE: Record<HandInteractionMode, number> = {
  laser: 60,
  direct: 45,
  center: 30,
};
const IDLE_FPS = 12;
const RAY_LENGTH_RATIO = 0.4;

// SMOOTHING: fixed alpha (frame-rate par depend karta tha) ki jagah One
// Euro filter. Haath ruka ho to bahut smoothing (jitter khatam), tez
// chale to kam smoothing (lag nahi). Time-based hai, isliye fps badalne
// par feel nahi badalta.
//   MIN_CUTOFF_HZ: kam = ruke hue haath par zyada smooth (par thoda slow)
//   BETA: zyada = tez movement par jaldi catch-up (kam lag)
// Jitter bacha ho to MIN_CUTOFF kam karo; lag lage to BETA badhao.
const ORIGIN_MIN_CUTOFF_HZ = 1.0;
const ORIGIN_BETA = 0.02; // origin pixels mein hai
const DIR_MIN_CUTOFF_HZ = 0.8;
const DIR_BETA = 1.5; // direction unit-vector components hain
const FILTER_D_CUTOFF_HZ = 1.0;
const DEBUG_PERF_LOG = false;

// Phone back-camera ka approximate horizontal field of view (degrees).
// Sirf perspective projection ke (a, b) offsets ke liye use hota hai.
const CAMERA_HFOV_DEG = 65;
const TAN_HALF_HFOV = Math.tan((CAMERA_HFOV_DEG * Math.PI) / 360);

// Depth axis ka sign. MediaPipe convention: z chhota/negative = camera
// ke kareeb. Default 1. AGAR haath camera ki taraf jhukane par laser
// ulta chale tab hi -1 karke test karo.
const DEPTH_SIGN = 1;

// Foreshortening floor (target dot/marker ke reach ke liye).
const MIN_PLANAR_RATIO = 0.3;

// Beam ke far end ke liye extra margin (px).
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

// Haath ka "marker" point — jo dwell engine ko jaata hai (drag-scroll /
// accessibility ke liye) aur laser/direct mode mein aim bhi yahi hai.
//   direct: thumb/index midpoint (pinch point)
//   laser/center: laser tip (origin + screenDir * reach)
function markerFor(slot: HandSlot, mode: HandInteractionMode): PxPoint {
  // Center aur direct mode mein marker = haath ka pinch point (thumb/index
  // midpoint) — scroll ke liye haath ki seedhi up/down movement chahiye,
  // laser tip ki nahi. Sirf laser mode mein tip marker hai.
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
  const [, setStatus] = useState<string>('Requesting camera access...');

  const onPinchMarkersRef = useRef(onPinchMarkers);
  onPinchMarkersRef.current = onPinchMarkers;
  const onPointMarkersRef = useRef(onPointMarkers);
  onPointMarkersRef.current = onPointMarkers;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // NAYA: dwell engine (agar DwellProvider ke andar mount hai) — pinch
  // activation + hover hit-test ke liye. Ref mein rakhte hain taaki
  // per-frame loop ko kabhi re-create na karna pade.
  const dwell = useOptionalDwellEngine();
  const dwellRef = useRef(dwell);
  dwellRef.current = dwell;

  // NAYA: selected interaction mode — ek ref (per-frame loop padhta hai),
  // store se subscribe. Mode badalne par koi re-render/re-init nahi.
  const modeRef = useRef<HandInteractionMode>(getHandInteractionMode());
  useEffect(() => {
    modeRef.current = getHandInteractionMode();
    return subscribeHandInteractionMode((m) => {
      modeRef.current = m;
    });
  }, []);

  // NAYA: HandTracker mount hote hi dwell engine ko pinch-click mode mein
  // daalo (dwell-select band, activation sirf pinch ENTER par); unmount
  // par purana dwell behavior wapas.
  useEffect(() => {
    const d = dwellRef.current;
    if (!d) return;
    d.setSelectMode('pinch-click');
    return () => d.setSelectMode('dwell');
  }, []);

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
    // Pinch ENTER par ban-ne wala click, jo gap ke baad fire hota hai
    // (ya cancel hota hai agar scroll-intent mile / tracking lost ho).
    let pendingClick: { aim: PxPoint; startY: number; startMs: number } | null = null;

    // Mode + haath ki maujoodgi ke hisaab se processing interval (ms).
    // "-2ms" margin: frame timing jitter se alternate frames skip hokar
    // rate aadha na ho jaaye.
    function currentIntervalMs(): number {
      const fps = handSlots.length > 0 ? FPS_BY_MODE[modeRef.current] : IDLE_FPS;
      return 1000 / fps - 2;
    }

    // Hover check (DOM rect reads) center mode mein har frame zaroori
    // nahi — reticle ka ring size hi badalta hai.
    let lastPeekMs = 0;
    let cachedHover: DOMRect | null = null;
    const mediapipePerf = new PerfCounter('mediapipe');

    function processResults(result: HandLandmarkerResult, sourceW: number, sourceH: number) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const mode = modeRef.current;
      // Direct mode ko laser direction ki zarurat nahi — calculation skip.
      const needsDir = mode === 'laser';

      const screenW = window.innerWidth;
      const screenH = window.innerHeight;
      // PERF FIX: canvas.width/height set karna har baar backing store
      // dobara allocate karta hai (mobile par mehnga) — sirf size badalne
      // par set karo, warna clearRect kaafi hai.
      if (canvas.width !== screenW) canvas.width = screenW;
      if (canvas.height !== screenH) canvas.height = screenH;
      ctx.clearRect(0, 0, screenW, screenH);

      const now = Date.now();
      const tSec = performance.now() / 1000;

      const scale = Math.max(screenW / sourceW, screenH / sourceH);
      const offsetX = (screenW - sourceW * scale) / 2;
      const offsetY = (screenH - sourceH * scale) / 2;

      // Principal point = screen centre (cover-scaling centred hai) —
      // wahi point jo center-mode reticle ka aim hai.
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

      if (detection) {
        let slot = handSlots[0];
        // Pinch rising edge sirf tab jab slot pehle se maujood tha aur
        // pichhle frame mein pinch NAHI tha. Naya slot (hand abhi dikha /
        // tracking lost ke baad wapas aaya) kabhi click nahi banata.
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

        // ACTIVATION: sirf pinch ENTER par, ek baar. Aim point mode se
        // decide hota hai — center mode mein haath ki position bilkul
        // matter nahi karti.
        //
        // CLICK vs SCROLL: pinch ENTER par click turant nahi, ek pending
        // click banta hai. Fir:
        //   - pinch point SCROLL_INTENT_PX se zyada upar/neeche hila
        //     -> scroll ka irada, click cancel (dwell engine scroll karta hai)
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
        // Tracking lost: pending click cancel (kuch bhi accidentally click nahi).
        pendingClick = null;
        if (handSlots[0] && now - handSlots[0].lastGoodTime > FREEZE_MS) {
          handSlots = [];
        }
      }

      onPinchMarkersRef.current?.(markers);
      onPointMarkersRef.current?.(pointMarkers);

      // ----------------------------- DRAW -----------------------------
      const slot = handSlots[0];

      // Hover/aim feedback: wahi hit-test jo activation use karta hai,
      // isliye reticle/highlight hamesha asli target ke saath aligned.
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

      // (Hit-box highlight hata diya — target ka feedback ab sirf
      // reticle/cursor ke size aur shade se milta hai.)

      // MODE 3: fixed center reticle (haath ke saath nahi hilta, koi
      // parallax nahi). Haath na dikhe tab bhi hamesha dikhta hai.
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

    async function start() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!canvas) return;

      try {
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
          if (nowMs - lastProcessTime < currentIntervalMs()) return;
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
          if (video.readyState >= 2 && !isProcessing && nowMs - lastProcessTime >= currentIntervalMs()) {
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
