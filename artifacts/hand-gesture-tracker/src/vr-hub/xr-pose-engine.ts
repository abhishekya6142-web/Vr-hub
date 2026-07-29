// xr-pose-engine.ts

export type WorldLockedTransform = {
  translateXpx: number;
  translateYpx: number;
  translateZpx: number;
  rotateXdeg: number;
  rotateYdeg: number;
  rotateZdeg: number;
};

type Listener = (t: WorldLockedTransform) => void;

const IDENTITY: WorldLockedTransform = {
  translateXpx: 0, translateYpx: 0, translateZpx: 0,
  rotateXdeg: 0, rotateYdeg: 0, rotateZdeg: 0,
};

// 1 Meter = 1000 CSS Pixels (Ye CSS 3D space ke depth ke liye perfect scale hai)
const METERS_TO_PX = 1000;

// Proper Quaternion to Euler Angles (WebXR / Y-Up standard)
function quatToEuler(x: number, y: number, z: number, w: number) {
  // Roll (Z-axis)
  const sinr_cosp = 2 * (w * z + x * y);
  const cosr_cosp = 1 - 2 * (y * y + z * z);
  const roll = Math.atan2(sinr_cosp, cosr_cosp) * (180 / Math.PI);

  // Pitch (X-axis)
  const sinp = 2 * (w * x - y * z);
  let pitch = 0;
  if (Math.abs(sinp) >= 1) pitch = Math.sign(sinp) * 90;
  else pitch = Math.asin(sinp) * (180 / Math.PI);

  // Yaw (Y-axis)
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
      this.origin = { x: position.x, y: position.y, z: position.z, pitch, yaw, roll };
    }

    // Camera kitna move hua origin se?
    const dx = position.x - this.origin.x;
    const dy = position.y - this.origin.y;
    const dz = position.z - this.origin.z;

    let dpitch = pitch - this.origin.pitch;
    let dyaw = yaw - this.origin.yaw;
    let droll = roll - this.origin.roll;

    // Normalize angles (-180 to 180)
    while (dyaw > 180) dyaw -= 360; while (dyaw < -180) dyaw += 360;
    while (dpitch > 180) dpitch -= 360; while (dpitch < -180) dpitch += 360;
    while (droll > 180) droll -= 360; while (droll < -180) droll += 360;

    // Duniya ko camera se ULTA move karo (Taaki screen par cheezein fixed lagen)
    const translateXpx = -dx * METERS_TO_PX;
    const translateYpx = dy * METERS_TO_PX; // WebXR Y is UP, CSS Y is DOWN
    const translateZpx = -dz * METERS_TO_PX;

    // Duniya ko camera se ULTA rotate karo
    const rotateXdeg = -dpitch;
    const rotateYdeg = -dyaw;
    const rotateZdeg = -droll;

    this.lastBroadcast = {
      translateXpx, translateYpx, translateZpx,
      rotateXdeg, rotateYdeg, rotateZdeg,
    };
    
    this.listeners.forEach((cb) => cb(this.lastBroadcast));
  }

  recenter(position?: { x: number; y: number; z: number }, orientation?: { x: number; y: number; z: number; w: number }) {
    if (position && orientation) {
      const { pitch, yaw, roll } = quatToEuler(orientation.x, orientation.y, orientation.z, orientation.w);
      this.origin = { x: position.x, y: position.y, z: position.z, pitch, yaw, roll };
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
