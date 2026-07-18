;import { useEffect, useRef, useState, type ReactNode } from 'react';

type DeviceOrientationEventWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

export function SpatialAnchor({ children }: { children: ReactNode }) {
  const [style, setStyle] = useState<{
    transform: string;
    opacity: number;
    pointerEvents: 'auto' | 'none';
  }>({
    transform: 'translate3d(0,0,0) rotateX(0deg) rotateY(0deg)',
    opacity: 1,
    pointerEvents: 'auto',
  });

  const [debugInfo, setDebugInfo] = useState('waiting for first event...');
  const [eventCount, setEventCount] = useState(0);

  const referenceRef = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
  const latestReadingRef = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
  const grantedRef = useRef(false);

  // Both axes now shift by the same amount, so looking up/down moves the
  // panel just as much as turning left/right does.
  const PX_PER_DEG_X = 18;
  const PX_PER_DEG_Y = 18;
  const FADE_START_DEG = 35;
  const FADE_END_DEG = 70;
  const MAX_PANEL_ROTATE_DEG = 20;

  function shortestAngleDelta(current: number, reference: number) {
    let delta = current - reference;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    return delta;
  }

  function recompute() {
    const ref = referenceRef.current;
    const latest = latestReadingRef.current;
    if (!ref || !latest) return;

    const yawDelta = shortestAngleDelta(latest.alpha, ref.alpha);
    const pitchDelta = latest.beta - ref.beta;
    const rollDelta = shortestAngleDelta(latest.gamma, ref.gamma);

    setDebugInfo(
      `yaw=${yawDelta.toFixed(1)} pitch=${pitchDelta.toFixed(1)} roll=${rollDelta.toFixed(1)} (abs: a=${latest.alpha.toFixed(1)} b=${latest.beta.toFixed(1)} g=${latest.gamma.toFixed(1)})`,
    );

    const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));

    const shiftX = yawDelta * PX_PER_DEG_X;
    const shiftY = pitchDelta * PX_PER_DEG_Y;
    const rotateY = clamp(-yawDelta * 0.4, MAX_PANEL_ROTATE_DEG);
    const rotateX = clamp(pitchDelta * 0.4, MAX_PANEL_ROTATE_DEG);

    // Fade-out now only responds to left/right turning (yaw). Looking
    // up/down no longer hides the panel — it just moves with the tilt
    // instead, same as the horizontal behavior.
    const angularDistance = Math.abs(yawDelta);

    let opacity = 1;
    if (angularDistance > FADE_START_DEG) {
      const t = (angularDistance - FADE_START_DEG) / (FADE_END_DEG - FADE_START_DEG);
      opacity = Math.max(0, 1 - t);
    }

    const rollTilt = clamp(rollDelta * 0.3, 15);

    setStyle({
      transform: `translate3d(${shiftX}px, ${shiftY}px, 0) rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rollTilt}deg)`,
      opacity,
      pointerEvents: opacity > 0.15 ? 'auto' : 'none',
    });
  }

  function recenter() {
    const latest = latestReadingRef.current;
    if (!latest) return;
    referenceRef.current = { ...latest };
    setStyle({
      transform: 'translate3d(0,0,0) rotateX(0deg) rotateY(0deg) rotateZ(0deg)',
      opacity: 1,
      pointerEvents: 'auto',
    });
    setDebugInfo(
      `recentered: a=${latest.alpha.toFixed(1)} b=${latest.beta.toFixed(1)} g=${latest.gamma.toFixed(1)}`,
    );
  }

  useEffect(() => {
    function handleOrientation(e: DeviceOrientationEvent) {
      setEventCount((c) => c + 1);
      if (e.beta == null || e.gamma == null) return;

      const reading = { alpha: e.alpha ?? 0, beta: e.beta, gamma: e.gamma };
      latestReadingRef.current = reading;

      if (!referenceRef.current) {
        return;
      }

      recompute();
    }

    window.addEventListener('deviceorientation', handleOrientation);

    const autoRecenterTimer = setTimeout(() => {
      recenter();
    }, 600);

    return () => {
      window.removeEventListener('deviceorientation', handleOrientation);
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
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          transition: 'transform 90ms linear, opacity 200ms ease-out',
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
