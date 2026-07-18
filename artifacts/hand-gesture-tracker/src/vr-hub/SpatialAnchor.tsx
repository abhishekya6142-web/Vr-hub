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

  const [debugInfo, setDebugInfo] = useState('waiting for first event...');
  const [eventCount, setEventCount] = useState(0);

  const referenceRef = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
  const latestReadingRef = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
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

  // Sets "straight ahead" to whatever orientation the phone is at right
  // now. Called automatically a moment after mount, and available to the
  // user any time via the Recenter button — useful if the panel has
  // drifted or the phone wasn't held steady when it first anchored.
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
      latestRea
