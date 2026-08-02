// xr-pose-engine.ts

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

function getCameraMatrix3d(pos: Vec3, quat: Quat) {
  const x = quat.x, y = quat.y, z = quat.z, w = quat.w;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  const r00 = 1 - (yy + zz), r01 = xy - wz,       r02 = xz + wy;
  const r10 = xy + wz,       r11 = 1 - (xx + zz), r12 = yz - wx;
  const r20 = xz - wy,       r21 = yz + wx,       r22 = 1 - (xx + yy);

  const i00 = r00, i01 = r10, i02 = r20;
  const i10 = r01, i11 = r11, i12 = r21;
  const i20 = r02, i21 = r12, i22 = r22;

  const tx = pos.x, ty = pos.y, tz = pos.z;
  const itx = -(i00 * tx + i01 * ty + i02 * tz);
  const ity = -(i10 * tx + i11 * ty + i12 * tz);
  const itz = -(i20 * tx + i21 * ty + i22 * tz);

  const scale = 1000;

  return `matrix3d(
    ${epsilon(i00)}, ${epsilon(-i10)}, ${epsilon(i20)}, 0,
    ${epsilon(i01)}, ${epsilon(-i11)}, ${epsilon(i21)}, 0,
    ${epsilon(i02)}, ${epsilon(-i12)}, ${epsilon(i22)}, 0,
    ${epsilon(itx * scale)}, ${epsilon(-ity * scale)}, ${epsilon(itz * scale)}, 1
  )`;
}

function getSceneMatrix3d(pos: Vec3, quat: Quat) {
  const x = quat.x, y = quat.y, z = quat.z, w = quat.w;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  const r00 = 1 - (yy + zz), r01 = xy - wz,       r02 = xz + wy;
  const r10 = xy + wz,       r11 = 1 - (xx + zz), r12 = yz - wx;
  const r20 = xz - wy,       r21 = yz + wx,       r22 = 1 - (xx + yy);

  const tx = pos.x, ty = pos.y, tz = pos.z;
  const scale = 1000;

  return `matrix3d(
    ${epsilon(r00)}, ${epsilon(r10)}, ${epsilon(r20)}, 0,
    ${epsilon(-r01)}, ${epsilon(-r11)}, ${epsilon(-r21)}, 0,
    ${epsilon(r02)}, ${epsilon(r12)}, ${epsilon(r22)}, 0,
    ${epsilon(tx * scale)}, ${epsilon(ty * scale)}, ${epsilon(tz * scale)}, 1
  )`;
}

function describeNum(n: unknown): string {
  if (typeof n !== 'number') return `NOT_A_NUMBER(${typeof n}:${String(n)})`;
  if (Number.isNaN(n)) return 'NaN';
  if (!Number.isFinite(n)) return `Infinite(${n})`;
  return n.toFixed(4);
}

class XRPoseEngine {
  private listeners = new Set<Listener>();
  private lastBroadcast: WorldLockedTransform = { ...IDENTITY };

  private anchorPose: { pos: Vec3; quat: Quat } | null = null;
  private active = false;

  private debugState: PoseDebugState = {
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

  getDebugState(): PoseDebugState {
    return this.debugState;
  }

  init() {
    this.active = false;
  }

  start() {
    this.active = true;
  }

  stop() {
    this.active = false;
    this.anchorPose = null;
    this.lastBroadcast = { ...IDENTITY };
    this.listeners.forEach((cb) => cb(this.lastBroadcast));
  }

  isActive() {
    return this.active;
  }

  // SINGLE validated entry point for setting the anchor — both
  // updatePose()'s "first valid frame" path and recenter() now go
  // through this, so there's only ONE place that can ever assign
  // this.anchorPose. Refuses to set an invalid pose as anchor.
  private setAnchor(pos: Vec3, quat: Quat) {
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
      // Bad frame — skip entirely. Anchor (if any) stays untouched.
      return;
    }

    if (!this.anchorPose) {
      this.setAnchor(position, orientation);
    }

    // Defensive: even though setAnchor() validates, guard again before
    // using anchorPose in matrix math, in case it's somehow still absent.
    if (!this.anchorPose) return;

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

  // FIX: agar recenter() ko invalid/missing pose milta hai, ab hum
  // anchorPose ko null NAHI karte (jo pehle ek fragile re-creation cycle
  // shuru kar sakta tha agar agla frame bhi kisi wajah se turant valid
  // na ho). Purana anchor jaisa tha waisा hi reh jaata hai — "recenter
  // fail silently, kuch mat badlo" behavior, jo hamesha better hai
  // "anchor corrupt kar do" se.
  recenter(position?: Vec3, orientation?: Quat) {
    if (position && orientation) {
      this.setAnchor(position, orientation);
    }
    // else: no valid pose given — leave anchorPose exactly as it was.
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
