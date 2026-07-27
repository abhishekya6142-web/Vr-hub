// XR Pose Engine
// ---------------------------------------------------------------------------
// SpatialAnchor.tsx ke gyroscope-based spatial-tracking-engine.ts se ALAG hai
// — ye asli WebXR camera pose (position + rotation, 6DoF) use karta hai,
// jo sirf tab available hota hai jab ek immersive-ar XRSession active ho.
//
// WebXR ko ek "render loop" chahiye hota hai (requestAnimationFrame apne
// hi XRSession pe, normal window.requestAnimationFrame nahi) taaki har
// frame par fresh camera pose mile. Isliye is module ko XRSession +
// XRWebGLLayer + XRReferenceSpace chahiye — XRHub.tsx ise set up karega.
//
// Concept: "Recenter" dabane par, jo bhi current camera pose hai use
// "origin" bana dete hain. Uske baad har frame par, current pose ka us
// origin se DELTA (kitna aage/peeche/left/right/rotate hua) nikaal ke
// panels ko dete hain — taaki panel origin ke relative ek fixed
// real-world point pe "locked" feel ho, jaise Vision Pro/Quest me hota hai.
// ---------------------------------------------------------------------------

export type WorldLockedTransform = {
  // Screen-space CSS transform jo world-lock illusion deta hai.
  translateXpx: number;
  translateYpx: number;
  translateZpx: number; // depth-scale ke liye use hoga
  rotateXdeg: number;
  rotateYdeg: number;
};

type Listener = (t: WorldLockedTransform) => void;

const IDENTITY: WorldLockedTransform = {
  translateXpx: 0,
  translateYpx: 0,
  translateZpx: 0,
  rotateXdeg: 0,
  rotateYdeg: 0,
};

// Real-world meters ko screen pixels me convert karne ka rough scale —
// taaki chhoti head-movements (jaise 10-20cm) bhi visually meaningful
// panel-shift den, bahut chhoti ya bahut badi na lagen.
const METERS_TO_PX = 800;
const MAX_TRANSLATE_PX = 260;
const MAX_ROTATE_DEG = 35;

function clamp(v: number, max: number) {
  return Math.max(-max, Math.min(max, v));
}

// Quaternion se yaw/pitch degrees nikalne ka helper — spatial-tracking-engine.ts
// ke forwardVectorFromQuaternion jaisa hi concept, yahan XRRigidTransform
// ke orientation quaternion pe apply hota hai.
function quaternionToYawPitchDeg(x: number, y: number, z: number, w: number) {
  const fwdX = -2 * (w * y + x * z);
  const fwdY = 2 * (w * x - y * z);
  const fwdZ = -1 + 2 * (x * x + y * y);
  const pitch = Math.asin(Math.max(-1, Math.min(1, fwdY))) * (180 / Math.PI);
  const yaw = Math.atan2(fwdX, -fwdZ) * (180 / Math.PI);
  return { yaw, pitch };
}

class XRPoseEngine {
  private listeners = new Set<Listener>();
  private lastBroadcast: WorldLockedTransform = { ...IDENTITY };

  private origin: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
  } | null = null;

  private active = false;

  // Added init method to prevent "init is not a function" errors
  init() {
    this.active = false;
  }

  // XRHub calls this once the session + reference space are ready.
  start() {
    this.active = true;
  }

  stop() {
    this.active = false;
    this.origin = null;
    this.lastBroadcast = { ...IDENTITY };
    this.listeners.forEach((cb) => cb(this.lastBroadcast));
  }

  isActive() {
    return this.active;
  }

  // XRHub's per-frame WebXR render loop calls this with the current
  // XRRigidTransform-like pose (position + orientation quaternion).
  updatePose(position: { x: number; y: number; z: number }, orientation: { x: number; y: number; z: number; w: number }) {
    if (!this.active) return;

    const { yaw, pitch } = quaternionToYawPitchDeg(
      orientation.x,
      orientation.y,
      orientation.z,
      orientation.w,
    );

    if (!this.origin) {
      // First pose after (re)start becomes the origin automatically —
      // recenter() below lets the user re-snap to a new origin anytime.
      this.origin = { x: position.x, y: position.y, z: position.z, yaw, pitch };
    }

    const dx = position.x - this.origin.x;
    const dy = position.y - this.origin.y;
    const dz = position.z - this.origin.z;
    let dyaw = yaw - this.origin.yaw;
    let dpitch = pitch - this.origin.pitch;
    while (dyaw > 180) dyaw -= 360;
    while (dyaw < -180) dyaw += 360;

    // Panel ko world-space me "fixed" feel dene ke liye movement invert —
    // user right move kare to panel screen par left shift ho (jaise real
    // fixed object ke paas se guzarte waqt hota hai), same jaisa
    // spatial-tracking-engine.ts karta hai gyroscope ke liye.
    const translateXpx = clamp(-dx * METERS_TO_PX, MAX_TRANSLATE_PX);
    const translateYpx = clamp(dy * METERS_TO_PX, MAX_TRANSLATE_PX);
    const translateZpx = clamp(-dz * METERS_TO_PX, MAX_TRANSLATE_PX);
    const rotateYdeg = clamp(-dyaw * 0.5, MAX_ROTATE_DEG);
    const rotateXdeg = clamp(-dpitch * 0.5, MAX_ROTATE_DEG);

    this.lastBroadcast = {
      translateXpx,
      translateYpx,
      translateZpx,
      rotateXdeg,
      rotateYdeg,
    };
    this.listeners.forEach((cb) => cb(this.lastBroadcast));
  }

  // "Recenter" button calls this — snaps the origin to whatever the last
  // known pose was, so the world-locked panels re-anchor to the user's
  // current position/facing.
  recenter(position?: { x: number; y: number; z: number }, orientation?: { x: number; y: number; z: number; w: number }) {
    if (position && orientation) {
      const { yaw, pitch } = quaternionToYawPitchDeg(
        orientation.x,
        orientation.y,
        orientation.z,
        orientation.w,
      );
      this.origin = { x: position.x, y: position.y, z: position.z, yaw, pitch };
    } else {
      this.origin = null; // next updatePose() call will re-snap
    }
    this.lastBroadcast = { ...IDENTITY };
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
