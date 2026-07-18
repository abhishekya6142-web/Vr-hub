import { useEffect, useRef, useState, type ReactNode } from 'react';

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

  // DEBUG: shows live sensor readouts on screen so we can verify whether
  // deviceorientation events are firing at all. Remove once confirmed.
  const [debugInfo, setDebugInfo] = useState('waiting for first event...');
  const [eventCount, setEventCount] = useState(0);

  const referenceRef = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
  const grantedRef = useRef(false);

  const PX_PER_DEG = 18;
  const FADE_START_DEG = 35;
  const FADE_END_DEG = 70;
  const MAX_PANEL_ROTATE_DEG = 20;

  function shortestAngleDelta(current: number, reference: number) {
    let delta = current - reference;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    return delta;
  }

  useEffect(() => {
    function handleOrientation(e: DeviceOrientationEvent) {
      setEventCount((c) => c + 1);

      if (e.beta == null || e.gamma == null) {
        setDebugInfo(`event fired but beta/gamma is null (alpha=${e.alpha})`);
        return;
      }
      const alpha = e.alpha ?? 0;

      if (!referenceRef.current) {
        referenceRef.current = { alpha, beta: e.beta, gamma: e.gamma };
        setDebugInfo(`reference set: a=${alpha.toFixed(1)} b=${e.beta.toFixed(1)} g=${e.gamma.toFixed(1)}`);
        return;
      }

      const ref = referenceRef.current;
      const yawDelta = shortestAngleDelta(alpha, ref.alpha);
      const pitchDelta = e.beta - ref.beta;
      const rollDelta = shortestAngleDelta(e.gamma, ref.gamma);

      setDebugInfo(
        `yaw=${yawDelta.toFixed(1)} pitch=${pitchDelta.toFixed(1)} roll=${rollDelta.toFixed(1)} (abs: a=${alpha.toFixed(1)} b=${e.beta.toFixed(1)} g=${e.gamma.toFixed(1)})`,
      );

      const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));

      const shiftX = -yawDelta * PX_PER_DEG;
      const shiftY = -pitchDelta * PX_PER_DEG;
      const rotateY = clamp(yawDelta * 0.4, MAX_PANEL_ROTATE_DEG);
      const rotateX = clamp(-pitchDelta * 0.4, MAX_PANEL_ROTATE_DEG);

      const angularDistance = Math.max(Math.abs(yawDelta), Math.abs(pitchDelta));

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

    window.addEventListener('deviceorientation', handleOrientation);
    return () => window.removeEventListener('deviceorientation', handleOrientation);
  }, []);

  async function requestAccess() {
    if (grantedRef.current) return;
    const DOE = DeviceOrientationEvent as DeviceOrientationEventWithPermission;
    if (typeof DOE.requestPermission === 'function') {
      try {
        const result = await DOE.requestPermission();
        grantedRef.current = result === 'granted';
        setDebugInfo(`iOS permission result: ${result}`);
      } catch (err) {
        grantedRef.current = false;
        setDebugInfo(`iOS permission error: ${err}`);
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
      {/* DEBUG OVERLAY — remove after diagnosing */}
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
