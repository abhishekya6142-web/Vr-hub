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
  rawPos: { x: number; y: number; z: number };
  anchorPos: { x: number; y: number; z: number } | null;
  updateCount: number;
};

type Listener = (t: WorldLockedTransform) => void;

const IDENTITY: WorldLockedTransform = {
  cameraMatrix3d: 'none',
  sceneMatrix3d: 'none',
};

// Float precision errors ko CSS mein tootne se bachane ke liye
function epsilon(value: number) {
  return Math.abs(value) < 1e-10 ? 0 : value;
}

// 1. Camera ka Inverse Matrix (Phone ki current position ko CSS duniya par apply karne ke liye)
function getCameraMatrix3d(pos: {x:number,y:number,z:number}, quat: {x:number,y:number,z:number,w:number}) {
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

// 2. Scene Anchor Matrix (Duniya mein panel kahan rakha hai, uski fixed location)
function getSceneMatrix3d(pos: {x:number,y:number,z:number}, quat: {x:number,y:number,z:number,w:number}) {
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

class XRPoseEngine {
  private listeners = new Set<Listener>();
  private lastBroadcast: WorldLockedTransform = { ...IDENTITY };

  private anchorPose: { pos: {x:number, y:number, z:number}, quat: {x:number, y:number, z:number, w:number} } | null = null;
  private active = false;

  // --- DEBUG STATE (naya) ---
  private debugState: PoseDebugState = {
    hasAnchor: false,
    dxMeters: 0,
    dyMeters: 0,
    dzMeters: 0,
    rawPos: { x: 0, y: 0, z: 0 },
    anchorPos: null,
    updateCount: 0,
  };

  getDebugState(): PoseDebugState {
    return this.debugState;
  }

  init() { this.active = false; }
  start() { this.active = true; }

  stop() {
    this.active = false;
    this.anchorPose = null;
    this.lastBroadcast = { ...IDENTITY };
    this.listeners.forEach((cb) => cb(this.lastBroadcast));
  }

  isActive() { return this.active; }

  updatePose(position: { x: number; y: number; z: number }, orientation: { x: number; y: number; z: number; w: number }) {
    if (!this.active) return;

    if (!this.anchorPose) {
      this.anchorPose = { pos: { ...position }, quat: { ...orientation } };
    }

    const cameraMatrix3d = getCameraMatrix3d(position, orientation);
    const sceneMatrix3d = getSceneMatrix3d(this.anchorPose.pos, this.anchorPose.quat);

    this.lastBroadcast = { cameraMatrix3d, sceneMatrix3d };

    // --- DEBUG: raw deltas track karo taaki on-screen dikha sakein ---
    this.debugState = {
      hasAnchor: true,
      dxMeters: position.x - this.anchorPose.pos.x,
      dyMeters: position.y - this.anchorPose.pos.y,
      dzMeters: position.z - this.anchorPose.pos.z,
      rawPos: { ...position },
      anchorPos: { ...this.anchorPose.pos },
      updateCount: this.debugState.updateCount + 1,
    };

    this.listeners.forEach((cb) => cb(this.lastBroadcast));
  }

  recenter(position?: { x: number; y: number; z: number }, orientation?: { x: number; y: number; z: number; w: number }) {
    if (position && orientation) {
      this.anchorPose = { pos: { ...position }, quat: { ...orientation } };
    } else {
      this.anchorPose = null;
    }
    this.listeners.forEach((cb) => cb(this.lastBroadcast));
  }

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    cb(this.lastBroadcast);
    return () => { this.listeners.delete(cb); };
  };
}

export const xrPoseEngine = new XRPoseEngine();
