import { useEffect, useRef, useState, type ReactNode } from 'react';

type DeviceOrientationEventWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

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

function getScreenAngle(): number {
  if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number') {
    return screen.orientation.angle;
  }
  const w = window as unknown as { orientation?: number };
  return typeof w.orientation === 'number' ? w.orientation : 0;
}

export function SpatialAnchor({ children }: { children: ReactNode }) {
  const [style, setStyle] = useState<{ transform: string }>({
    transform: 'translate3d(0,0,0) rotateX(0deg) rotateY(0deg)',
  });

  const [debugInfo, setDebugInfo] = useState('waiting for first event...');
  const [eventCount, setEventCount] = useState(0);

  const latestReadingRef = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
  const grantedRef = useRef(false);
  const screenAngleRef = useRef(0);

  // Recenter ke waqt ka "zero" pitch/yaw
  const referenceRef = useRef<{ pitch: number; yaw: number } | null>(null);

  // Raw computed angles pe halka low-pass (EMA) filter — jitter hataane ke liye,
  // panel-shift wale LERP se pehle hi.
  const emaRef = useRef<{ pitch: number; yaw: number } | null>(null);

  const smoothedValuesRef = useRef({ shiftX: 0, shiftY: 0, rotateX: 0, rotateY: 0 });

  const PX_PER_DEG = 18;
  const MAX_PANEL_ROTATE_DEG = 20;
  const DEAD_ZONE_DEG = 3; // chhoti/accidental head-jitter ignore karne ke liye
  const EMA_ALPHA = 0.25; // raw signal ka low-pass filter strength

  function applyDeadZone(delta: number) {
    if (Math.abs(delta) <= DEAD_ZONE_DEG) return 0;
    return delta > 0 ? delta - DEAD_ZONE_DEG : delta + DEAD_ZONE_DEG;
  }

  function recompute() {
    const latest = latestReadingRef.current;
    if (!latest) return;

    const [qx, qy, qz, qw] = computeDeviceQuaternion(
      latest.alpha,
      latest.beta,
      latest.gamma,
      screenAngleRef.current,
    );
    const fwd = forwardVectorFromQuaternion(qx, qy, qz, qw);

    // pitch: poora phone kitna upar/niche point kar raha hai (roll-independent)
    const rawPitch = Math.asin(Math.max(-1, Math.min(1, fwd.y))) * (180 / Math.PI);
    // yaw: kitna left/right ghooma hai
    const rawYaw = Math.atan2(fwd.x, -fwd.z) * (180 / Math.PI);

    if (!emaRef.current) {
      emaRef.current = { pitch: rawPitch, yaw: rawYaw };
    } else {
      emaRef.current.pitch += (rawPitch - emaRef.current.pitch) * EMA_ALPHA;
      let yawDiff = rawYaw - emaRef.current.yaw;
      while (yawDiff > 180) yawDiff -= 360;
      while (yawDiff < -180) yawDiff += 360;
      emaRef.current.yaw += yawDiff * EMA_ALPHA;
    }

    if (!referenceRef.current) {
      referenceRef.current = { pitch: emaRef.current.pitch, yaw: emaRef.current.yaw };
    }

    let pitchDelta = emaRef.current.pitch - referenceRef.current.pitch;
    let yawDelta = emaRef.current.yaw - referenceRef.current.yaw;
    while (yawDelta > 180) yawDelta -= 360;
    while (yawDelta < -180) yawDelta += 360;

    pitchDelta = applyDeadZone(pitchDelta);
    yawDelta = applyDeadZone(yawDelta);

    const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));

    // Poora phone niche pitch kare (upar dekhne jaisa) => panel upar jaaye
    const targetShiftX = yawDelta * PX_PER_DEG;
    const targetShiftY = -pitchDelta * PX_PER_DEG;
    const targetRotateY = clamp(-yawDelta * 0.4, MAX_PANEL_ROTATE_DEG);
    const targetRotateX = clamp(-pitchDelta * 0.4, MAX_PANEL_ROTATE_DEG);

    const LERP_FACTOR = 0.12;
    const current = smoothedValuesRef.current;
    current.shiftX += (targetShiftX - current.shiftX) * LERP_FACTOR;
    current.shiftY += (targetShiftY - current.shiftY) * LERP_FACTOR;
    current.rotateX += (targetRotateX - current.rotateX) * LERP_FACTOR;
    current.rotateY += (targetRotateY - current.rotateY) * LERP_FACTOR;

    setDebugInfo(
      `raw b=${latest.beta.toFixed(1)} g=${latest.gamma.toFixed(1)} | pitch=${pitchDelta.toFixed(1)} yaw=${yawDelta.toFixed(1)} | shiftY=${current.shiftY.toFixed(0)}`,
    );

    setStyle({
      transform: `translate3d(${current.shiftX}px, ${current.shiftY}px, 0) rotateX(${current.rotateX}deg) rotateY(${current.rotateY}deg)`,
    });
  }

  function recenter() {
    if (!emaRef.current) return;
    referenceRef.current = { ...emaRef.current };
    smoothedValuesRef.current = { shiftX: 0, shiftY: 0, rotateX: 0, rotateY: 0 };
    setStyle({ transform: 'translate3d(0,0,0) rotateX(0deg) rotateY(0deg)' });
    setDebugInfo('recentered');
  }

  useEffect(() => {
    screenAngleRef.current = getScreenAngle();

    function handleOrientation(e: DeviceOrientationEvent) {
      setEventCount((c) => c + 1);
      if (e.beta == null || e.gamma == null) return;
      latestReadingRef.current = { alpha: e.alpha ?? 0, beta: e.beta, gamma: e.gamma };
    }

    function handleScreenChange() {
      screenAngleRef.current = getScreenAngle();
    }

    window.addEventListener('deviceorientation', handleOrientation);
    if (screen.orientation) {
      screen.orientation.addEventListener('change', handleScreenChange);
    } else {
      window.addEventListener('orientationchange', handleScreenChange);
    }

    let rafId: number;
    const tick = () => {
      recompute();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    const autoRecenterTimer = setTimeout(() => {
      recenter();
    }, 600);

    return () => {
      window.removeEventListener('deviceorientation', handleOrientation);
      if (screen.orientation) {
        screen.orientation.removeEventListener('change', handleScreenChange);
      } else {
        window.removeEventListener('orientationchange', handleScreenChange);
      }
      cancelAnimationFrame(rafId);
      clearTimeout(autoRecenterTimer);
    };
  }, []);

  async function requestAccess() {
    if (grantedRef.current) return;
    const DOE = DeviceOrientationEvent as DeviceOrientationEventWithPermission;
    if (typeof DOE.requestPermission === 'function') {
      try {
        const result = await DOE.requestPermission();
        grantedRef.current = result === 'granted';
      } catch {
        grantedRef.current = false;
      }
    } else {
      grantedRef.current = true;
    }
  }

  useEffect(() => {
    requestAccess();
  }, []);

  return (
    <div style={{ perspective: '1200px', width: '100%', height: '100%' }}>
      <div
        style={{
          position: 'fixed',
          top: 8,
          left: 8,
          zIndex: 9999999,
          background: 'rgba(0,0,0,0.8)',
          color: '#0f0',
          fontSize: '11px',
          fontFamily: 'monospace',
          padding: '6px 8px',
          borderRadius: '6px',
          maxWidth: '90vw',
          pointerEvents: 'none',
        }}
      >
        events: {eventCount} | {debugInfo}
      </div>

      <button
        type="button"
        onClick={recenter}
        style={{
          position: 'fixed',
          bottom: 90,
          right: 8,
          zIndex: 9999999,
          background: 'rgba(20,20,20,0.85)',
          color: '#fff',
          fontSize: '12px',
          fontWeight: 600,
          padding: '8px 14px',
          borderRadius: '999px',
          border: '1px solid rgba(255,255,255,0.2)',
        }}
      >
        Recenter
      </button>

      <div
        style={{
          transform: style.transform,
          transition: 'none',
          transformStyle: 'preserve-3d',
          width: '100%',
          height: '100%',
        }}
        onClick={() => {
          if (!grantedRef.current) requestAccess();
        }}
      >
        {children}
      </div>
    </div>
  );
}
