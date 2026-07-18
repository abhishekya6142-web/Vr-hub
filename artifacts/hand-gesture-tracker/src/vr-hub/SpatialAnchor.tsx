import { useEffect, useRef, useState, type ReactNode } from 'react';

type ScreenOrientationWithLock = ScreenOrientation & {
  lock?: (orientation: string) => Promise<void>;
};

type DeviceOrientationEventWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

// Gives a floating panel a "fixed point in space" illusion, similar to how
// windows behave in spatial computing headsets: the panel is anchored to
// whatever device orientation was present when it first appeared, and as
// the phone tilts/rotates away from that reference, the panel counter-
// shifts (via a 3D CSS transform) so it feels like it's staying put in the
// real world rather than being glued to the screen.
//
// This uses DeviceOrientationEvent (tilt angles) rather than raw IMU/
// DeviceMotion data — it's coarser than true sensor-fusion tracking (no
// drift correction, no positional/6DoF tracking), but is the practical
// browser-available approximation without native ARCore access.
export function SpatialAnchor({ children }: { children: ReactNode }) {
  const [granted, setGranted] = useState(false);
  const [transform, setTransform] = useState('translate3d(0,0,0) rotateX(0deg) rotateY(0deg)');
  const referenceRef = useRef<{ beta: number; gamma: number } | null>(null);

  // Sensitivity: how many px/deg the panel shifts per degree of tilt away
  // from the reference orientation. Tuned conservatively so small natural
  // hand tremor doesn't make the panel swim, but a deliberate head/phone
  // turn clearly moves it.
  const SHIFT_PX_PER_DEG = 4;
  const ROTATE_DEG_PER_DEG = 0.15;
  const MAX_SHIFT_PX = 60;
  const MAX_ROTATE_DEG = 8;

  useEffect(() => {
    function handleOrientation(e: DeviceOrientationEvent) {
      if (e.beta == null || e.gamma == null) return;

      if (!referenceRef.current) {
        // First reading becomes the "zero" reference — the orientation the
        // panel is anchored to.
        referenceRef.current = { beta: e.beta, gamma: e.gamma };
        return;
      }

      const deltaBeta = e.beta - referenceRef.current.beta; // front/back tilt
      const deltaGamma = e.gamma - referenceRef.current.gamma; // left/right tilt

      const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));

      const shiftX = clamp(-deltaGamma * SHIFT_PX_PER_DEG, MAX_SHIFT_PX);
      const shiftY = clamp(-deltaBeta * SHIFT_PX_PER_DEG, MAX_SHIFT_PX);
      const rotateY = clamp(deltaGamma * ROTATE_DEG_PER_DEG, MAX_ROTATE_DEG);
      const rotateX = clamp(-deltaBeta * ROTATE_DEG_PER_DEG, MAX_ROTATE_DEG);

      setTransform(
        `translate3d(${shiftX}px, ${shiftY}px, 0) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`,
      );
    }

    window.addEventListener('deviceorientation', handleOrientation);
    return () => window.removeEventListener('deviceorientation', handleOrientation);
  }, []);

  async function requestAccess() {
    const DOE = DeviceOrientationEvent as DeviceOrientationEventWithPermission;
    if (typeof DOE.requestPermission === 'function') {
      try {
        const result = await DOE.requestPermission();
        setGranted(result === 'granted');
      } catch {
        setGranted(false);
      }
    } else {
      // Android Chrome doesn't require an explicit permission prompt over
      // HTTPS — orientation events just start arriving.
      setGranted(true);
    }
  }

  useEffect(() => {
    // Auto-request on mount for browsers that don't need explicit
    // permission (most Android Chrome). iOS Safari requires this to be
    // triggered from a user gesture, so those browsers will only get the
    // effect after the user interacts once (see the button fallback).
    requestAccess();
  }, []);

  return (
    <div
      style={{ perspective: '1200px' }}
      className="contents"
    >
      <div
        style={{
          transform,
          transition: 'transform 120ms ease-out',
          transformStyle: 'preserve-3d',
        }}
        className="contents"
        onClick={() => {
          if (!granted) requestAccess();
        }}
      >
        {children}
      </div>
    </div>
  );
}
