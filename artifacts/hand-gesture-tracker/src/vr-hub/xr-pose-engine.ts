// xr-pose-engine.ts

export type WorldLockedTransform = {
  matrix: number[]; // 16-element WebXR projection/view matrix for true 3D locking
  translateXpx: number;
  translateYpx: number;
  translateZpx: number;
  rotateXdeg: number;
  rotateYdeg: number;
  rotateZdeg: number;
};

type Listener = (t: WorldLockedTransform) => void;

const IDENTITY_MATRIX = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, -1.2, 1 // Default 1.2 meter distance in front
];

const IDENTITY: WorldLockedTransform = {
  matrix: IDENTITY_MATRIX,
  translateXpx: 0, translateYpx: 0, translateZpx: 0,
  rotateXdeg: 0, rotateYdeg: 0, rotateZdeg: 0,
};

const METERS_TO_PX = 1000;

function quatToEuler(x: number, y: number, z: number, w: number) {
  const sinr_cosp = 2 * (w * z + x * y);
  const cosr_cosp = 1 - 2 * (y * y + z * z);
  const roll = Math.atan2(sinr_cosp, cosr_cosp) * (180 / Math.PI);

  const sinp = 2 * (w * x - y * z);
  let pitch = 0;
  if (Math.abs(sinp) >= 1) pitch = Math.sign(sinp) * 90;
  else pitch = Math.asin(sinp) * (180 / Math.PI);

  const siny_cosp = 2 * (w * y + z * x);
  const cosy_cosp = 1 - 2 * (x * x + y * y);
  const yaw = Math.atan2(siny_cosp, cosy_cosp) * (180 / Math.PI);

  return { pitch, yaw, roll };
}

class XRPoseEngine {
  private listeners = new Set<Listener>();
  private lastBroadcast: WorldLockedTransform = { ...IDENTITY };

  private origin: {
    x: number; y: number; z: number;
    pitch: number; yaw: number; roll: number;
  } | null = null;

  private active = false;

  init() { this.active = false; }
  start() { this.active = true; }

  stop() {
    this.active = false;
    this.origin = null;
    this.lastBroadcast = { ...IDENTITY };
    this.listeners.forEach((cb) => cb(this.lastBroadcast));
  }

  isActive() { return this.active; }

  updatePose(position: { x: number; y: number; z: number }, orientation: { x: number; y: number; z: number; w: number }) {
    if (!this.active) return;

    const { pitch, yaw, roll } = quatToEuler(orientation.x, orientation.y, orientation.z, orientation.w);

    if (!this.origin) {
      // First frame sets the anchor point right in front of the user (e.g. 1.2 meters forward on Z axis)
      this.origin = { 
        x: position.x, 
        y: position.y, 
        z: position.z - 1.2, // Locked 1.2m ahead
        pitch, yaw, roll 
      };
    }

    const dx = position.x - this.origin.x;
    const dy = position.y - this.origin.y;
    const dz = position.z - this.origin.z;

    let dpitch = pitch - this.origin.pitch;
    let dyaw = yaw - this.origin.yaw;
    let droll = roll - this.origin.roll;

    while (dyaw > 180) dyaw -= 360; while (dyaw < -180) dyaw += 360;
    while (dpitch > 180) dpitch -= 360; while (dpitch < -180) dpitch += 360;
    while (droll > 180) droll -= 360; while (droll < -180) droll += 360;

    const translateXpx = -dx * METERS_TO_PX;
    const translateYpx = dy * METERS_TO_PX;
    const translateZpx = -dz * METERS_TO_PX;

    const rotateXdeg = -dpitch;
    const rotateYdeg = -dyaw;
    const rotateZdeg = -droll;

    // Build true CSS Matrix3d string values for solid locking
    // matrix3d(scaleX, 0, 0, 0, 0, scaleY, 0, 0, 0, 0, scaleZ, 0, tx, ty, tz, 1)
    this.lastBroadcast = {
      matrix: [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        translateXpx, translateYpx, translateZpx, 1
      ],
      translateXpx, translateYpx, translateZpx,
      rotateXdeg, rotateYdeg, rotateZdeg,
    };
    
    this.listeners.forEach((cb) => cb(this.lastBroadcast));
  }

  recenter(position?: { x: number; y: number; z: number }, orientation?: { x: number; y: number; z: number; w: number }) {
    if (position && orientation) {
      const { pitch, yaw, roll } = quatToEuler(orientation.x, orientation.y, orientation.z, orientation.w);
      this.origin = { 
        x: position.x, 
        y: position.y, 
        z: position.z - 1.2, 
        pitch, yaw, roll 
      };
    } else {
      this.origin = null;
    }
    this.lastBroadcast = { ...IDENTITY };
    this.listeners.forEach((cb) => cb(this.lastBroadcast));
  }

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    cb(this.lastBroadcast);
    return () => { this.listeners.delete(cb); };
  };
}

export const xrPoseEngine = new XRPoseEngine();
