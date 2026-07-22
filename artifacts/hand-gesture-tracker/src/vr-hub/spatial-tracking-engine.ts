// Shared Spatial Tracking Engine
// ---------------------------------------------------------------------------
// Pehle har <SpatialAnchor> apna khud ka deviceorientation listener + RAF loop
// + quaternion/EMA calculation chalata tha. Agar N panels open hain, to N
// baar wahi same sensor data process ho raha tha — redundant CPU cost jo
// panel count ke saath linearly badhta hai.
//
// Ye module ek hi baar sensor read karta hai, ek hi RAF loop chalata hai, aur
// sab subscribers (SpatialAnchor instances) ko wahi computed transform
// broadcast karta hai. Panels sirf "subscribe" karte hain — apna koi
// listener/RAF nahi banate.
//
// Math (quaternion, EMA, dead-zone, lerp) SpatialAnchor.tsx se hu-bahu liya
// gaya hai — behavior identical rehna chahiye, sirf "kitni baar chalta hai"
// badla hai.

export type SpatialTransform = {
  shiftX: number;
  shiftY: number;
  rotateX: number;
  rotateY: number;
};

type Listener = (t: SpatialTransform) => void;

type DeviceOrientationEventWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

const IDENTITY_TRANSFORM: SpatialTransform = { shiftX: 0, shiftY: 0, rotateX: 0, rotateY: 0 };

// Quaternion multiply helper (Hamilton product): returns a*b
function quatMultiply(
  ax: number, ay: number, az: number, aw: number,
  bx: number, by: number, bz: number, bw: number,
): [number, number, number, number] {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

// Raw alpha/beta/gamma + current screen rotation ko ek single "world-space"
// quaternion me convert karta hai — yehi exact math three.js
// DeviceOrientationControls (cardboard/WebVR ke liye industry-standard) use
// karti hai. Isse portrait/landscape holding aur screen rotation automatically
// compensate ho jaate hain.
function computeDeviceQuaternion(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
  screenAngleDeg: number,
): [number, number, number, number] {
  const d2r = Math.PI / 180;
  const _x = betaDeg * d2r;
  const _y = alphaDeg * d2r;
  const _z = -gammaDeg * d2r;

  const c1 = Math.cos(_x / 2);
  const c2 = Math.cos(_y / 2);
  const c3 = Math.cos(_z / 2);
  const s1 = Math.sin(_x / 2);
  const s2 = Math.sin(_y / 2);
  const s3 = Math.sin(_z / 2);

  // Euler order 'YXZ' -> quaternion (device orientation relative to Earth)
  let qx = s1 * c2 * c3 + c1 * s2 * s3;
  let qy = c1 * s2 * c3 - s1 * c2 * s3;
  let qz = c1 * c2 * s3 - s1 * s2 * c3;
  let qw = c1 * c2 * c3 + s1 * s2 * s3;

  // Camera "backside" ki taraf dekhta hai (VR/cardboard use case), top edge
  // ki taraf nahi -> -90deg X rotation apply karo.
  const H = Math.SQRT1_2;
  [qx, qy, qz, qw] = quatMultiply(qx, qy, qz, qw, -H, 0, 0, H);

  // Phone abhi portrait me hai ya landscape me, uske hisaab se compensate karo
  const screenRad = screenAngleDeg * d2r;
  const qsz = Math.sin(-screenRad / 2);
  const qsw = Math.cos(-screenRad / 2);
  [qx, qy, qz, qw] = quatMultiply(qx, qy, qz, qw, 0, 0, qsz, qsw);

  return [qx, qy, qz, qw];
}

// Quaternion se "forward" vector (0,0,-1) nikalta hai. ROLL (ek edge upar,
// dusra edge apni jagah — steering-wheel jaisa twist) is vector ko badalta
// HI nahi hai, mathematically — isi wajah se ismein se nikala gaya
// pitch/yaw automatically roll-independent hota hai. Yehi is poore fix ka
// core hai.
function forwardVectorFromQuaternion(x: number, y: number, z: number, w: number) {
  return {
    x: -2 * (w * y + x * z),
    y: 2 * (w * x - y * z),
    z: -1 + 2 * (x * x + y * y),
  };
}

// recompute() aur recenter() dono isi function se pitch/yaw nikalte hain —
// taaki recenter ke waqt hum koi purani/lagged value use na karein, balki
// hamesha ek fresh raw computation ho.
function computePitchYaw(
  latest: { alpha: number; beta: number; gamma: number },
  screenAngle: number,
): { pitch: number; yaw: number } {
  const [qx, qy, qz, qw] = computeDeviceQuaternion(latest.alpha, latest.beta, latest.gamma, screenAngle);
  const fwd = forwardVectorFromQuaternion(qx, qy, qz, qw);
  const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y))) * (180 / Math.PI);
  const yaw = Math.atan2(fwd.x, -fwd.z) * (180 / Math.PI);
  return { pitch, yaw };
}

function getScreenAngle(): number {
  if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number') {
    return screen.orientation.angle;
  }
  const w = window as unknown as { orientation?: number };
  return typeof w.orientation === 'number' ? w.orientation : 0;
}

const PX_PER_DEG = 18;
const MAX_PANEL_ROTATE_DEG = 20;
const DEAD_ZONE_DEG = 3; // chhoti/accidental head-jitter ignore karne ke liye
const EMA_ALPHA = 0.25; // raw signal ka low-pass filter strength
const LERP_FACTOR = 0.12;

function applyDeadZone(delta: number) {
  if (Math.abs(delta) <= DEAD_ZONE_DEG) return 0;
  return delta > 0 ? delta - DEAD_ZONE_DEG : delta + DEAD_ZONE_DEG;
}

function clamp(v: number, max: number) {
  return Math.max(-max, Math.min(max, v));
}

class SpatialTrackingEngine {
  private listeners = new Set<Listener>();
  private started = false;
  private grantedRef = false;

  private latestReading: { alpha: number; beta: number; gamma: number } | null = null;
  private screenAngle = 0;
  private referenceRef: { pitch: number; yaw: number } | null = null;
  private emaRef: { pitch: number; yaw: number } | null = null;
  private smoothedValues: SpatialTransform = { ...IDENTITY_TRANSFORM };
  private lastBroadcast: SpatialTransform = { ...IDENTITY_TRANSFORM };

  private rafId = 0;
  private autoRecenterTimer: ReturnType<typeof setTimeout> | undefined;

  private handleOrientation = (e: DeviceOrientationEvent) => {
    if (e.beta == null || e.gamma == null) return;
    this.latestReading = { alpha: e.alpha ?? 0, beta: e.beta, gamma: e.gamma };
  };

  private handleScreenChange = () => {
    this.screenAngle = getScreenAngle();
  };

  private recompute = () => {
    const latest = this.latestReading;
    if (!latest) return;

    const { pitch: rawPitch, yaw: rawYaw } = computePitchYaw(latest, this.screenAngle);

    if (!this.emaRef) {
      this.emaRef = { pitch: rawPitch, yaw: rawYaw };
    } else {
      this.emaRef.pitch += (rawPitch - this.emaRef.pitch) * EMA_ALPHA;
      let yawDiff = rawYaw - this.emaRef.yaw;
      while (yawDiff > 180) yawDiff -= 360;
      while (yawDiff < -180) yawDiff += 360;
      this.emaRef.yaw += yawDiff * EMA_ALPHA;
    }

    if (!this.referenceRef) {
      this.referenceRef = { pitch: this.emaRef.pitch, yaw: this.emaRef.yaw };
    }

    let pitchDelta = this.emaRef.pitch - this.referenceRef.pitch;
    let yawDelta = this.emaRef.yaw - this.referenceRef.yaw;
    while (yawDelta > 180) yawDelta -= 360;
    while (yawDelta < -180) yawDelta += 360;

    pitchDelta = applyDeadZone(pitchDelta);
    yawDelta = applyDeadZone(yawDelta);

    // Panel world-space me "fixed" feel de — isliye final movement invert
    // kiya hai: phone RIGHT ghoome to panel LEFT jaaye, phone UP tilt ho to
    // panel DOWN jaaye (Vision Pro / Quest jaisa illusion).
    const targetShiftX = -yawDelta * PX_PER_DEG;
    const targetShiftY = pitchDelta * PX_PER_DEG;
    const targetRotateY = clamp(-yawDelta * 0.4, MAX_PANEL_ROTATE_DEG);
    const targetRotateX = clamp(-pitchDelta * 0.4, MAX_PANEL_ROTATE_DEG);

    const current = this.smoothedValues;
    current.shiftX += (targetShiftX - current.shiftX) * LERP_FACTOR;
    current.shiftY += (targetShiftY - current.shiftY) * LERP_FACTOR;
    current.rotateX += (targetRotateX - current.rotateX) * LERP_FACTOR;
    current.rotateY += (targetRotateY - current.rotateY) * LERP_FACTOR;

    this.lastBroadcast = { ...current };
    this.listeners.forEach((cb) => cb(this.lastBroadcast));
  };

  recenter = () => {
    const latest = this.latestReading;
    if (!latest) return;

    // Fresh raw reading se turant pitch/yaw nikalo (koi EMA lag nahi) —
    // taaki reference bilkul abhi ke actual orientation se match kare.
    const fresh = computePitchYaw(latest, this.screenAngle);

    // Filter state ko bhi isi fresh value pe snap kar do, taaki agla frame
    // turant 0 delta se shuru ho — koi residual off-center offset na aaye.
    this.emaRef = { ...fresh };
    this.referenceRef = { ...fresh };
    this.smoothedValues = { ...IDENTITY_TRANSFORM };
    this.lastBroadcast = { ...IDENTITY_TRANSFORM };
    this.listeners.forEach((cb) => cb(this.lastBroadcast));
  };

  private ensureStarted() {
    if (this.started) return;
    this.started = true;

    this.screenAngle = getScreenAngle();

    window.addEventListener('deviceorientation', this.handleOrientation);
    if (screen.orientation) {
      screen.orientation.addEventListener('change', this.handleScreenChange);
    } else {
      window.addEventListener('orientationchange', this.handleScreenChange);
    }

    const tick = () => {
      this.recompute();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);

    this.autoRecenterTimer = setTimeout(() => {
      this.recenter();
    }, 600);

    this.requestAccess();
  }

  private async requestAccess() {
    if (this.grantedRef) return;
    const DOE = DeviceOrientationEvent as DeviceOrientationEventWithPermission;
    if (typeof DOE.requestPermission === 'function') {
      try {
        const result = await DOE.requestPermission();
        this.grantedRef = result === 'granted';
      } catch {
        this.grantedRef = false;
      }
    } else {
      this.grantedRef = true;
    }
  }

  // Manual retry hook — permission prompt ke liye (jaise pehle ek click pe
  // requestAccess() dobara try hota tha).
  requestAccessManually = () => {
    if (!this.grantedRef) this.requestAccess();
  };

  // Panels engine ko subscribe karte hain. Pehla subscriber engine ko start
  // karta hai (lazy init — agar koi SpatialAnchor mount hi nahi hua to
  // listener/RAF bilkul nahi chalega). Turant last known transform bhi
  // deta hai taaki subscriber ko pehle frame ka wait na karna pade.
  subscribe = (cb: Listener): (() => void) => {
    this.ensureStarted();
    this.listeners.add(cb);
    cb(this.lastBroadcast);
    return () => {
      this.listeners.delete(cb);
    };
  };
}

// Singleton — poore app me ek hi instance, sab SpatialAnchor isi ko subscribe karte hain.
export const spatialTrackingEngine = new SpatialTrackingEngine();
      
