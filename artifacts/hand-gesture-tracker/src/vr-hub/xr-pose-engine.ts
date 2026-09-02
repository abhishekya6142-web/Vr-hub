// xr-pose-engine.ts
//
// FIX (v2 — real WebXR Anchors API instead of a static math snapshot):
// The old approach captured the phone's position/orientation ONCE at
// session start (or on Recenter), and from then on purely calculated
// "camera moved by X, so subtract X" — pure math, with no connection to
// the phone's own AR tracking system. That's fine as long as ARCore's
// tracking never drifts, but it always drifts a little over time
// (blank walls, low light, fast movement) — and since our math had no
// way to know about that drift, the panel drifted right along with it.
//
// The WebXR "anchors" feature fixes this properly: instead of us doing
// the position math ourselves, we ask the AR system itself to track a
// point in the real world (frame.createAnchor(...)). Every frame we
// then ask that anchor "where are you now?" (frame.getPose(anchor...)),
// and the AR system's own tracking corrections (loop closure, drift
// correction, etc.) are automatically reflected in the answer — the
// panel now benefits from the same self-correcting tracking real AR
// systems use, instead of a one-time snapshot we computed ourselves.
//
// If the device/browser doesn't support the 'anchors' feature, this
// silently falls back to the old static-snapshot behavior so the app
// still works — just without the drift-correction benefit.
// ---------------------------------------------------------------------------
// COORDINATE SYSTEM NOTE (unchanged from before — read before touching
// the matrix math below):
//
// WebXR poses are right-handed, Y-up: +X right, +Y up, +Z towards the
// viewer (out of the screen). CSS 3D transforms are left-handed, Y-down:
// +X right, +Y DOWN, +Z towards the viewer.
//
// The only axis that actually differs in direction between the two
// systems is Y. The fix for that is a SINGLE, consistent conversion:
// negate every Y-component (both in rotation and translation) exactly
// ONCE, in exactly one place, applied uniformly to both matrices we
// build.
// ---------------------------------------------------------------------------
//
// BUG FIX (anchor.x/y/z = undefined, kept from before): WebXR's
// position/orientation values (XRRigidTransform.position / .orientation)
// are DOMPointReadOnly objects — their x/y/z/w are defined via PROTOTYPE
// GETTERS, not own-enumerable properties. `{ ...pos }` silently produces
// `{}`. Fix: never spread Vec3/Quat-like WebXR objects — always
// explicitly build a plain object by reading .x/.y/.z/(.w).
// ---------------------------------------------------------------------------
//
// FIX (v3 — smooth anchor handoff, no more "settle" snap):
// PROBLEM: createAnchor() is async — it resolves a frame or two after
// being requested. Until it resolves, updatePose() uses
// fallbackAnchorPose (a static snapshot taken the instant we requested
// the anchor). The camera keeps moving during those 1-2 frames. When
// the real anchor finally resolves, its pose can differ slightly from
// the static snapshot (because the device's own tracking already
// refined its understanding of that point in space by then) — so the
// panel would visibly "snap"/jerk from the fallback position to the
// real-anchor position the instant it became available. This is the
// "movement ke baad thoda aage-peeche hoke apni jagah aata hai" that
// was reported.
//
// FIX: instead of switching anchorPos/anchorQuat instantly the frame
// the real anchor becomes available, we SMOOTHLY INTERPOLATE (lerp)
// from whatever pose we were broadcasting last frame towards the new
// target pose, over a short window (~150ms). This applies uniformly —
// not just for the fallback->real-anchor handoff, but for any
// frame-to-frame anchor pose change — which also helps smooth out any
// small per-frame jitter from the anchor tracking itself. Recenter()
// (a deliberate, large jump) intentionally SKIPS the smoothing (snaps
// instantly) since the user explicitly asked to move the anchor there.
// ---------------------------------------------------------------------------

export type WorldLockedTransform = {
  cameraMatrix3d: string;
  sceneMatrix3d: string;
};

export type PoseDebugState = {
  hasAnchor: boolean;
  anchorMode: 'none' | 'pending' | 'real-anchor' | 'fallback-static';
  dxMeters: number;
  dyMeters: number;
  dzMeters: number;
  rawPos: { x: number; y: number; z: number } | null;
  anchorPos: { x: number; y: number; z: number } | null;
  updateCount: number;
  lastRawPositionValid: boolean;
  debugRawXType: string;
  debugRawYType: string;
  debugRawZType: string;
  debugAnchorXType: string;
  debugAnchorYType: string;
  debugAnchorZType: string;
  debugRawX: string;
  debugRawY: string;
  debugRawZ: string;
  debugAnchorX: string;
  debugAnchorY: string;
  debugAnchorZ: string;
};

type Listener = (t: WorldLockedTransform) => void;
type Vec3 = { x: number; y: number; z: number };
type Quat = { x: number; y: number; z: number; w: number };

interface XRRigidTransformLike {
  position: Vec3;
  orientation: Quat;
}
interface XRRigidTransformConstructor {
  new (position?: Vec3, orientation?: Quat): XRRigidTransformLike;
}
declare const XRRigidTransform: XRRigidTransformConstructor;

interface XRSpaceLike {}
interface XRAnchorLike {
  anchorSpace: XRSpaceLike;
  delete: () => void;
}
interface XRPoseLike {
  transform: { position: Vec3; orientation: Quat };
}
interface XRFrameLike {
  createAnchor?: (pose: XRRigidTransformLike, space: XRSpaceLike) => Promise<XRAnchorLike>;
  getPose: (space: XRSpaceLike, baseSpace: XRSpaceLike) => XRPoseLike | undefined;
}

const IDENTITY: WorldLockedTransform = {
  cameraMatrix3d: 'none',
  sceneMatrix3d: 'none',
};

const SCALE = 1000; // 1 meter = 1000px

// FIX (v3): smoothing window for anchor-pose transitions. ~150ms is
// short enough that a deliberate recenter or a real handoff still
// feels responsive (not sluggish), but long enough to fully hide the
// 1-2 frame snap described above. This does NOT touch camera pose
// (that stays raw/instant, frame-accurate) — only the anchor
// (scene-lock) pose is smoothed, since that's what was visibly
// jumping.
const ANCHOR_SMOOTH_MS = 150;

function epsilon(value: number) {
  return Math.abs(value) < 1e-10 ? 0 : value;
}

function toPlainVec3(v: { x: number; y: number; z: number }): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function toPlainQuat(q: { x: number; y: number; z: number; w: number }): Quat {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

function isValidVec3(v: Vec3 | null | undefined): v is Vec3 {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function isValidQuat(q: Quat | null | undefined): q is Quat {
  return (
    !!q &&
    Number.isFinite(q.x) &&
    Number.isFinite(q.y) &&
    Number.isFinite(q.z) &&
    Number.isFinite(q.w)
  );
}

// FIX (v3): simple linear interpolation for position, used to smooth
// anchor-pose handoffs/jitter over ANCHOR_SMOOTH_MS.
function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

// FIX (v3): normalized quaternion lerp (nlerp) — cheaper than slerp
// and visually indistinguishable for the small-angle corrections we're
// smoothing here (anchor drift-correction, not large rotations).
function nlerpQuat(a: Quat, b: Quat, t: number): Quat {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const sign = dot < 0 ? -1 : 1;
  const x = a.x + (b.x * sign - a.x) * t;
  const y = a.y + (b.y * sign - a.y) * t;
  const z = a.z + (b.z * sign - a.z) * t;
  const w = a.w + (b.w * sign - a.w) * t;
  const len = Math.hypot(x, y, z, w) || 1;
  return { x: x / len, y: y / len, z: z / len, w: w / len };
}

function quatToRotationMatrix(quat: Quat) {
  const x = quat.x, y = quat.y, z = quat.z, w = quat.w;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  return {
    r00: 1 - (yy + zz), r01: xy - wz,       r02: xz + wy,
    r10: xy + wz,       r11: 1 - (xx + zz), r12: yz - wx,
    r20: xz - wy,       r21: yz + wx,       r22: 1 - (xx + yy),
  };
}

function flipRotationToCss(r: ReturnType<typeof quatToRotationMatrix>) {
  return {
    r00: r.r00, r01: -r.r01, r02: r.r02,
    r10: -r.r10, r11: r.r11, r12: -r.r12,
    r20: r.r20, r21: -r.r21, r22: r.r22,
  };
}

function getCameraMatrix3d(pos: Vec3, quat: Quat): string {
  const rWebXR = quatToRotationMatrix(quat);

  const rInvWebXR = {
    r00: rWebXR.r00, r01: rWebXR.r10, r02: rWebXR.r20,
    r10: rWebXR.r01, r11: rWebXR.r11, r12: rWebXR.r21,
    r20: rWebXR.r02, r21: rWebXR.r12, r22: rWebXR.r22,
  };

  const itx = -(rInvWebXR.r00 * pos.x + rInvWebXR.r01 * pos.y + rInvWebXR.r02 * pos.z);
  const ity = -(rInvWebXR.r10 * pos.x + rInvWebXR.r11 * pos.y + rInvWebXR.r12 * pos.z);
  const itz = -(rInvWebXR.r20 * pos.x + rInvWebXR.r21 * pos.y + rInvWebXR.r22 * pos.z);

  const rCss = flipRotationToCss(rInvWebXR);

  return `matrix3d(
    ${epsilon(rCss.r00)}, ${epsilon(rCss.r10)}, ${epsilon(rCss.r20)}, 0,
    ${epsilon(rCss.r01)}, ${epsilon(rCss.r11)}, ${epsilon(rCss.r21)}, 0,
    ${epsilon(rCss.r02)}, ${epsilon(rCss.r12)}, ${epsilon(rCss.r22)}, 0,
    ${epsilon(itx * SCALE)}, ${epsilon(-ity * SCALE)}, ${epsilon(itz * SCALE)}, 1
  )`;
}

function getSceneMatrix3d(pos: Vec3, quat: Quat): string {
  const rWebXR = quatToRotationMatrix(quat);
  const rCss = flipRotationToCss(rWebXR);

  return `matrix3d(
    ${epsilon(rCss.r00)}, ${epsilon(rCss.r10)}, ${epsilon(rCss.r20)}, 0,
    ${epsilon(rCss.r01)}, ${epsilon(rCss.r11)}, ${epsilon(rCss.r21)}, 0,
    ${epsilon(rCss.r02)}, ${epsilon(rCss.r12)}, ${epsilon(rCss.r22)}, 0,
    ${epsilon(pos.x * SCALE)}, ${epsilon(-pos.y * SCALE)}, ${epsilon(pos.z * SCALE)}, 1
  )`;
}

function describeNum(n: unknown): string {
  if (typeof n !== 'number') return `NOT_A_NUMBER(${typeof n}:${String(n)})`;
  if (Number.isNaN(n)) return 'NaN';
  if (!Number.isFinite(n)) return `Infinite(${n})`;
  return n.toFixed(4);
}

function emptyDebugState(): PoseDebugState {
  return {
    hasAnchor: false,
    anchorMode: 'none',
    dxMeters: 0,
    dyMeters: 0,
    dzMeters: 0,
    rawPos: null,
    anchorPos: null,
    updateCount: 0,
    lastRawPositionValid: false,
    debugRawXType: '',
    debugRawYType: '',
    debugRawZType: '',
    debugAnchorXType: '',
    debugAnchorYType: '',
    debugAnchorZType: '',
    debugRawX: '',
    debugRawY: '',
    debugRawZ: '',
    debugAnchorX: '',
    debugAnchorY: '',
    debugAnchorZ: '',
  };
}

class XRPoseEngine {
  private listeners = new Set<Listener>();
  private lastBroadcast: WorldLockedTransform = { ...IDENTITY };
  private active = false;
  private debugState: PoseDebugState = emptyDebugState();

  private realAnchor: XRAnchorLike | null = null;
  private anchorCreationInFlight = false;
  private fallbackAnchorPose: { pos: Vec3; quat: Quat } | null = null;
  private pendingRecenter = false;

  // FIX (v3): smoothed anchor pose we actually broadcast — separate
  // from whatever raw anchorPos/anchorQuat this frame's tracking gave
  // us. Every frame we move this a little (lerp) towards the raw
  // target, instead of snapping straight to it.
  private smoothedAnchorPos: Vec3 | null = null;
  private smoothedAnchorQuat: Quat | null = null;
  // When true, the NEXT anchor pose received should be applied
  // instantly (no smoothing) — used right after recenter(), since a
  // deliberate recenter should feel immediate, not eased-in.
  private skipSmoothingOnce = false;
  private lastUpdateTimeMs = 0;

  getDebugState(): PoseDebugState {
    return this.debugState;
  }

  init() {
    this.active = false;
  }

  start() {
    this.active = true;
    this.realAnchor?.delete();
    this.realAnchor = null;
    this.anchorCreationInFlight = false;
    this.fallbackAnchorPose = null;
    this.pendingRecenter = false;
    this.smoothedAnchorPos = null;
    this.smoothedAnchorQuat = null;
    this.skipSmoothingOnce = true;
    this.lastUpdateTimeMs = 0;
    this.debugState = emptyDebugState();
    this.lastBroadcast = { ...IDENTITY };
  }

  stop() {
    this.active = false;
    this.realAnchor?.delete();
    this.realAnchor = null;
    this.anchorCreationInFlight = false;
    this.fallbackAnchorPose = null;
    this.pendingRecenter = false;
    this.smoothedAnchorPos = null;
    this.smoothedAnchorQuat = null;
    this.skipSmoothingOnce = false;
    this.lastBroadcast = { ...IDENTITY };
    this.debugState = emptyDebugState();
    this.listeners.forEach((cb) => cb(this.lastBroadcast));
  }

  isActive() {
    return this.active;
  }

  private createRealAnchor(frame: XRFrameLike, refSpace: XRSpaceLike, pos: Vec3, quat: Quat) {
    if (!frame.createAnchor || this.anchorCreationInFlight) return;
    this.anchorCreationInFlight = true;
    const transform = new XRRigidTransform(pos, quat);
    frame
      .createAnchor(transform, refSpace)
      .then((anchor) => {
        this.realAnchor?.delete();
        this.realAnchor = anchor;
        this.anchorCreationInFlight = false;
      })
      .catch(() => {
        this.anchorCreationInFlight = false;
      });
  }

  updatePose(frame: XRFrameLike, refSpace: XRSpaceLike, position: Vec3, orientation: Quat) {
    if (!this.active) return;

    const posValid = isValidVec3(position);
    const quatValid = isValidQuat(orientation);

    this.debugState.updateCount++;
    this.debugState.lastRawPositionValid = posValid && quatValid;
    this.debugState.debugRawXType = typeof position?.x;
    this.debugState.debugRawYType = typeof position?.y;
    this.debugState.debugRawZType = typeof position?.z;
    this.debugState.debugRawX = describeNum(position?.x);
    this.debugState.debugRawY = describeNum(position?.y);
    this.debugState.debugRawZ = describeNum(position?.z);

    if (!posValid || !quatValid) {
      return;
    }

    if (this.pendingRecenter) {
      this.pendingRecenter = false;
      this.fallbackAnchorPose = { pos: toPlainVec3(position), quat: toPlainQuat(orientation) };
      this.createRealAnchor(frame, refSpace, position, orientation);
    }

    if (!this.realAnchor && !this.fallbackAnchorPose && !this.anchorCreationInFlight) {
      this.fallbackAnchorPose = { pos: toPlainVec3(position), quat: toPlainQuat(orientation) };
      this.createRealAnchor(frame, refSpace, position, orientation);
    }

    let anchorPos: Vec3 | null = null;
    let anchorQuat: Quat | null = null;
    let mode: PoseDebugState['anchorMode'] = 'none';

    if (this.realAnchor) {
      const pose = frame.getPose(this.realAnchor.anchorSpace, refSpace);
      if (pose && isValidVec3(pose.transform.position) && isValidQuat(pose.transform.orientation)) {
        anchorPos = toPlainVec3(pose.transform.position);
        anchorQuat = toPlainQuat(pose.transform.orientation);
        mode = 'real-anchor';
      }
    }

    if (!anchorPos || !anchorQuat) {
      if (this.fallbackAnchorPose) {
        anchorPos = this.fallbackAnchorPose.pos;
        anchorQuat = this.fallbackAnchorPose.quat;
        mode = this.anchorCreationInFlight || !frame.createAnchor ? 'fallback-static' : 'pending';
      }
    }

    if (!anchorPos || !anchorQuat) return;

    // FIX (v3 — smooth handoff): apply the raw anchorPos/anchorQuat
    // through a short lerp instead of using it directly. This is what
    // eliminates the visible "snap" when switching from the fallback
    // snapshot to the real anchor (or any other frame-to-frame anchor
    // pose change) — the panel eases towards the new pose over
    // ANCHOR_SMOOTH_MS instead of jumping there in one frame.
    const nowMs = performance.now();
    const dtMs = this.lastUpdateTimeMs === 0 ? ANCHOR_SMOOTH_MS : nowMs - this.lastUpdateTimeMs;
    this.lastUpdateTimeMs = nowMs;

    if (!this.smoothedAnchorPos || !this.smoothedAnchorQuat || this.skipSmoothingOnce) {
      this.smoothedAnchorPos = anchorPos;
      this.smoothedAnchorQuat = anchorQuat;
      this.skipSmoothingOnce = false;
    } else {
      const t = Math.min(1, Math.max(0, dtMs / ANCHOR_SMOOTH_MS));
      this.smoothedAnchorPos = lerpVec3(this.smoothedAnchorPos, anchorPos, t);
      this.smoothedAnchorQuat = nlerpQuat(this.smoothedAnchorQuat, anchorQuat, t);
    }

    const cameraMatrix3d = getCameraMatrix3d(position, orientation);
    const sceneMatrix3d = getSceneMatrix3d(this.smoothedAnchorPos, this.smoothedAnchorQuat);

    this.lastBroadcast = { cameraMatrix3d, sceneMatrix3d };

    this.debugState = {
      ...this.debugState,
      hasAnchor: true,
      anchorMode: mode,
      dxMeters: position.x - anchorPos.x,
      dyMeters: position.y - anchorPos.y,
      dzMeters: position.z - anchorPos.z,
      rawPos: toPlainVec3(position),
      anchorPos,
      debugAnchorXType: typeof anchorPos.x,
      debugAnchorYType: typeof anchorPos.y,
      debugAnchorZType: typeof anchorPos.z,
      debugAnchorX: describeNum(anchorPos.x),
      debugAnchorY: describeNum(anchorPos.y),
      debugAnchorZ: describeNum(anchorPos.z),
    };

    this.listeners.forEach((cb) => cb(this.lastBroadcast));
  }

  // FIX (v3): also marks skipSmoothingOnce, so the recenter itself
  // feels instant (not eased) — the user explicitly asked to move the
  // panel here right now.
  recenter() {
    if (!this.active) return;
    this.pendingRecenter = true;
    this.skipSmoothingOnce = true;
  }

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    cb(this.lastBroadcast);
    return () => {
      this.listeners.delete(cb);
    };
  };
}

export const xrPoseEngine = new XRPoseEngine();
