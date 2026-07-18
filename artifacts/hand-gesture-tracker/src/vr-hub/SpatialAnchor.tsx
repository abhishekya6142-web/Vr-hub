import { useEffect, useRef, useState, type ReactNode } from 'react';

type DeviceOrientationEventWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

// Anchors a floating panel to a fixed point in 3D space, similar to how
// windows behave in spatial computing headsets (Vision Pro, YouTube VR /
// Cardboard mode): the panel is "placed" at whatever device yaw/pitch was
// current when it first appeared. As the phone rotates away from that
// point, the panel swings across the screen in the opposite direction
// (like looking away from something fixed in the room), and once the
// rotation exceeds the field of view, the panel fades out entirely —
// simulating "it's behind you now". Rotating back brings it into view
// again from the correct direction.
//
// This uses DeviceOrientationEvent (absolute-ish alpha/beta/gamma) rather
// than true 6DoF sensor fusion — there's no positional tracking and slow
// compass drift on alpha is possible on some devices — but it's the best
// approximation available without native ARCore/ARKit access.
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

  const referenceRef = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
  const grantedRef = useRef(false);

  // How many px the panel swings per degree of rotation away from the
  // anchored point. Larger than the old parallax version since this now
  // represents the panel's actual angular position, not a subtle wobble.
  const PX_PER_DEG = 18;
  // Degrees of rotation (yaw or pitch) at which the panel is fully faded
  // out — i.e. treated as "behind" the user.
  const FADE_START_DEG = 35;
  const FADE_END_DEG = 70;
  // Small tilt (holding the phone naturally) shouldn't rotate the panel's
  // own plane too aggressively, just its screen position.
  const MAX_PANEL_ROTATE_DEG = 20;

  function shortestAngleDelta(current: number, reference: number) {
    // Handles alpha's 0-360 wraparound so a reference near 359° and a
    // reading near 1° don't produce a huge false delta.
    let delta = current - reference;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    return delta;
  }

  useEffect(() => {
    function handleOrientation(e: DeviceOrientationEvent) {
      if (e.beta == null || e.gamma == null) return;
      const alpha = e.alpha ?? 0;

      if (!referenceRef.current) {
        referenceRef.current = { alpha, beta: e.beta, gamma: e.gamma };
        return;
      }

      const ref = referenceRef.current;
      // Yaw (left/right turn) mostly comes from alpha, but gamma also
      // shifts a bit when the phone is held upright vs flat, so we blend
      // gamma in as a secondary left/right signal for held-in-hand use.
      const yawDelta = shortestAngleDelta(alpha, ref.alpha);
      const pitchDelta = e.beta - ref.beta;
      const rollDelta = shortestAngleDelta(e.gamma, ref.gamma);

      const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));

      const shiftX = -yawDelta * PX_PER_DEG;
      const shiftY = -pitchDelta * PX_PER_DEG;
      const rotateY = clamp(yawDelta * 0.4, MAX_PANEL_ROTATE_DEG);
      const rotateX = clamp(-pitchDelta * 0.4, MAX_PANEL_ROTATE_DEG);

      // Distance from the anchor point in "degrees turned away", used to
      // decide visibility/opacity. Roll (gamma) barely affects this since
      // tilting the phone sideways doesn't turn you away from the anchor.
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
    <div style={{ perspective: '1200px' }} className="contents">
      <div
        style={{
          transform: style.transform,
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          transition: 'transform 90ms linear, opacity 200ms ease-out',
          transformStyle: 'preserve-3d',
        }}
        className="contents"
        onClick={() => {
          if (!grantedRef.current) requestAccess();
        }}
      >
        {children}
      </div>
    </div>
  );
}
