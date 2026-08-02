// xr-pose-engine.ts
//
// ---------------------------------------------------------------------------
// COORDINATE SYSTEM NOTE (read this before touching the matrix math below):
//
// WebXR poses are right-handed, Y-up: +X right, +Y up, +Z towards the
// viewer (out of the screen). CSS 3D transforms are left-handed, Y-down:
// +X right, +Y DOWN, +Z towards the viewer.
//
// The only axis that actually differs in direction between the two
// systems is Y. The fix for that is a SINGLE, consistent conversion:
// negate every Y-component (both in rotation and translation) exactly
// ONCE, in exactly one place, applied uniformly to both matrices we
// build. Previously this was done inconsistently — negating some rows
// of the rotation matrix but not the corresponding translation, or vice
// versa — which produces a matrix that is neither a pure rotation nor a
// valid coordinate change, and shows up visually as mirroring/upside-down
// flipping.
//
// Below, we build the rotation matrix from the quaternion in WebXR space
// first (standard, well-tested formula — this part was always correct),
// and ONLY at the very end, when writing values into the matrix3d()
// string, do we apply the Y-flip — uniformly, to row 1 AND to the Y
// translation component, for both matrices. This is the "conjugate by a
// flip matrix" approach: F * R * F for rotation (flips row 1 and column 1,
// net effect = negate the off-diagonal Y terms twice = they stay the same
// sign structure, only R01/R21/R10/R12 change sign — NOT R11), and just
// negate ty for translation. This is the mathematically correct way to
// change a right-handed Y-up rotation into its Y-down equivalent.
// ---------------------------------------------------------------------------

export type WorldLockedTransform = {
  cameraMatrix3d: string;
  sceneMatrix3d: string;
};

export type PoseDebugState = {
  hasAnchor: boolean;
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

const IDENTITY: WorldLockedTransform = {
  cameraMatrix3d: 'none',
  sceneMatrix3d: 'none',
};

const SCALE = 1000; // 1 meter = 1000px

function epsilon(value: number) {
  return Math.abs(value) < 1e-10 ? 0 : value;
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

// Standard quaternion -> 3x3 rotation matrix (WebXR space, no flip yet).
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

// Converts a WebXR-space rotation matrix into its CSS (Y-down) equivalent
// via conjugation by the flip matrix F = diag(1, -1, 1): F*R*F.
// Net effect: every term that has Y exactly ONCE (r01, r10, r12, r21)
// flips sign; every term with Y zero or TWO times (r00, r02, r11, r20, r22)
// stays the same. This is the single, uniform, mathematically-correct
// way to re-express the same rotation in a Y-flipped coordinate system —
// as opposed to negating an arbitrary row, which distorts the rotation
// into something that isn't a rotation anymore (causing mirroring).
function flipRotationToCss(r: ReturnType<typeof quatToRotationMatrix>) {
  return {
    r00: r.r00, r01: -r.r01, r02: r.r02,
    r10: -r.r10, r11: r.r11, r12: -r.r12,
    r20: r.r20, r21: -r.r21, r22: r.r22,
  };
}

// Builds the "camera" matrix: the INVERSE of the viewer's world transform
// (since to render the world from the camera's point of view, everything
// must move opposite to the camera). Position and rotation both convert
// through the same Y-flip.
function getCameraMatrix3d(pos: Vec3, quat: Quat): string {
  const rWebXR = quatToRotationMatrix(quat);

  // Inverse of a pure rotation matrix = its transpose.
  const rInvWebXR = {
    r00: rWebXR.r00, r01: rWebXR.r10, r02: rWebXR.r20,
    r10: rWebXR.r01, r11: rWebXR.r11, r12: rWebXR.r21,
    r20: rWebXR.r02, r21: rWebXR.r12, r22: rWebXR.r22,
  };

  // Inverse translation: -R_inv * pos (still in WebXR space, un-flipped).
  const itx = -(rInvWebXR.r00 * pos.x + rInvWebXR.r01 * pos.y + rInvWebXR.r02 * pos.z);
  const ity = -(rInvWebXR.r10 * pos.x + rInvWebXR.r11 * pos.y + rInvWebXR.r12 * pos.z);
  const itz = -(rInvWebXR.r20 * pos.x + rInvWebXR.r21 * pos.y + rInvWebXR.r22 * pos.z);

  const rCss = flipRotationToCss(rInvWebXR);

  // Translation Y-flip: negate ty ONCE, uniformly (matches the rotation's
  // uniform flip above).
  return `matrix3d(
    ${epsilon(rCss.r00)}, ${epsilon(rCss.r10)}, ${epsilon(rCss.r20)}, 0,
    ${epsilon(rCss.r01)}, ${epsilon(rCss.r11)}, ${epsilon(rCss.r21)}, 0,
    ${epsilon(rCss.r02)}, ${epsilon(rCss.r12)}, ${epsilon(rCss.r22)}, 0,
    ${epsilon(itx * SCALE)}, ${epsilon(-ity * SCALE)}, ${epsilon(itz * SCALE)}, 1
  )`;
}

// Builds the "scene anchor" matrix: where the anchor point sits in world
// space (NOT inverted — this is a forward transform, placing the anchor
// content at the anchor's captured position/orientation). Same uniform
// Y-flip as the camera matrix, so the two compose consistently.
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
  private anchorPose: { pos: Vec3; quat: Quat } | null = null;
  private active = false;
  private debugState: PoseDebugState = emptyDebugState();

  getDebugState(): PoseDebugState {
    return this.debugState;
  }

  init() {
    this.active = false;
  }

  // FIX (Bug 1): explicitly clear anchorPose AND debugState every time a
  // session starts. Previously, if this module's singleton instance
  // somehow survived across a remount/HMR/re-render with anchorPose left
  // in a weird state, the "only set anchor once" logic would never
  // re-fire — silently keeping stale/undefined data forever. start() is
  // called exactly once per new AR session (from XRHub), so this
  // guarantees every session begins from a clean, known state.
  start() {
    this.active = true;
    this.anchorPose = null;
    this.debugState = emptyDebugState();
    this.lastBroadcast = { ...IDENTITY };
  }

  stop() {
    this.active = false;
    this.anchorPose = null;
    this.lastBroadcast = { ...IDENTITY };
    this.debugState = emptyDebugState();
    this.listeners.forEach((cb) => cb(this.lastBroadcast));
  }

  isActive() {
    return this.active;
  }

  private setAnchor(pos: Vec3, quat: Quat): boolean {
    if (!isValidVec3(pos) || !isValidQuat(quat)) return false;
    this.anchorPose = { pos: { ...pos }, quat: { ...quat } };
    this.debugState.debugAnchorXType = typeof this.anchorPose.pos.x;
    this.debugState.debugAnchorYType = typeof this.anchorPose.pos.y;
    this.debugState.debugAnchorZType = typeof this.anchorPose.pos.z;
    this.debugState.debugAnchorX = describeNum(this.anchorPose.pos.x);
    this.debugState.debugAnchorY = describeNum(this.anchorPose.pos.y);
    this.debugState.debugAnchorZ = describeNum(this.anchorPose.pos.z);
    return true;
  }

  updatePose(position: Vec3, orientation: Quat) {
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
      return; // bad frame — skip entirely, anchor untouched
    }

    if (!this.anchorPose) {
      this.setAnchor(position, orientation);
    }

    if (!this.anchorPose) return; // defensive; should be unreachable

    const cameraMatrix3d = getCameraMatrix3d(position, orientation);
    const sceneMatrix3d = getSceneMatrix3d(this.anchorPose.pos, this.anchorPose.quat);

    this.lastBroadcast = { cameraMatrix3d, sceneMatrix3d };

    this.debugState = {
      ...this.debugState,
      hasAnchor: true,
      dxMeters: position.x - this.anchorPose.pos.x,
      dyMeters: position.y - this.anchorPose.pos.y,
      dzMeters: position.z - this.anchorPose.pos.z,
      rawPos: { ...position },
      anchorPos: { ...this.anchorPose.pos },
    };

    this.listeners.forEach((cb) => cb(this.lastBroadcast));
  }

  recenter(position?: Vec3, orientation?: Quat) {
    if (position && orientation) {
      this.setAnchor(position, orientation);
    }
    this.debugState = { ...this.debugState, hasAnchor: !!this.anchorPose };
    this.listeners.forEach((cb) => cb(this.lastBroadcast));
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
