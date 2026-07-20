import { useEffect, useRef, useState, type ReactNode } from 'react';

type DeviceOrientationEventWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

export function SpatialAnchor({ children }: { children: ReactNode }) {
  const [style, setStyle] = useState<{
    transform: string;
  }>({
    transform: 'translate3d(0,0,0) rotateX(0deg) rotateY(0deg)',
  });

  const [debugInfo, setDebugInfo] = useState('waiting for first event...');
  const [eventCount, setEventCount] = useState(0);

  const referenceRef = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
  const latestReadingRef = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
  const grantedRef = useRef(false);

  const smoothedValuesRef = useRef({ shiftX: 0, shiftY: 0, rotateX: 0, rotateY: 0 });

  const PX_PER_DEG = 18;
  const MAX_PANEL_ROTATE_DEG = 20;

  function shortestAngleDelta(current: number, reference: number) {
    let delta = current - reference;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    return delta;
  }

  function recompute() {
    const ref = referenceRef.current;
    if (!ref || !latestReadingRef.current) return;

    let latest = { ...latestReadingRef.current };

    // --- Gimbal Lock Un-Flipper Logic ---
    const alphaJump = Math.abs(shortestAngleDelta(latest.alpha, ref.alpha));
    const betaJump = Math.abs(shortestAngleDelta(latest.beta, ref.beta));

    if (alphaJump > 90 && betaJump > 90) {
      latest.alpha = (latest.alpha + 180) % 360;
      latest.beta = latest.beta > 0 ? latest.beta - 180 : latest.beta + 180;
      latest.gamma = latest.gamma > 0 ? 180 - latest.gamma : -180 - latest.gamma;
    }

    const yawDelta = shortestAngleDelta(latest.alpha, ref.alpha);
    const pitchDelta = shortestAngleDelta(latest.beta, ref.beta);

    const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));

    // --- FIXED BOTH AXES FOR PERFECT WRAPPING ---
    // Horizontal (X) ko normal rakha hai taaki right/left sahi chale
    const targetShiftX = yawDelta * PX_PER_DEG; 
    // Vertical (Y) ko invert kiya hai taaki upar dekhne par panel niche jaye
    const targetShiftY = -pitchDelta * PX_PER_DEG; 
    
    // 3D Perspective Rotations ko bhi accordingly fix kar diya hai
    const targetRotateY = clamp(-yawDelta * 0.4, MAX_PANEL_ROTATE_DEG);
    const targetRotateX = clamp(-pitchDelta * 0.4, MAX_PANEL_ROTATE_DEG);

    // Continuous LERP Smoothing
    const LERP_FACTOR = 0.12; 
    const current = smoothedValuesRef.current;

    current.shiftX += (targetShiftX - current.shiftX) * LERP_FACTOR;
    current.shiftY += (targetShiftY - current.shiftY) * LERP_FACTOR;
    current.rotateX += (targetRotateX - current.rotateX) * LERP_FACTOR;
    current.rotateY += (targetRotateY - current.rotateY) * LERP_FACTOR;

    setDebugInfo(
      `yaw=${yawDelta.toFixed(1)} pitch=${pitchDelta.toFixed(1)} (smoothed: x=${current.shiftX.toFixed(0)} y=${current.shiftY.toFixed(0)})`,
    );

    setStyle({
      transform: `translate3d(${current.shiftX}px, ${current.shiftY}px, 0) rotateX(${current.rotateX}deg) rotateY(${current.rotateY}deg)`,
    });
  }

  function recenter() {
    const latest = latestReadingRef.current;
    if (!latest) return;
    referenceRef.current = { ...latest };
    
    smoothedValuesRef.current = { shiftX: 0, shiftY: 0, rotateX: 0, rotateY: 0 };

    setStyle({
      transform: 'translate3d(0,0,0) rotateX(0deg) rotateY(0deg)',
    });
    setDebugInfo(
      `recentered: a=${latest.alpha.toFixed(1)} b=${latest.beta.toFixed(1)} g=${latest.gamma.toFixed(1)}`,
    );
  }

  useEffect(() => {
    function handleOrientation(e: DeviceOrientationEvent) {
      setEventCount((c) => c + 1);
      if (e.beta == null || e.gamma == null) return;

      latestReadingRef.current = { alpha: e.alpha ?? 0, beta: e.beta, gamma: e.gamma };
    }

    window.addEventListener('deviceorientation', handleOrientation);

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
