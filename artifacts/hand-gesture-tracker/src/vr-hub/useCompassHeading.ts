// useCompassHeading.ts
//
// Tries to get REAL magnetic north heading from the device's compass
// sensor. This is "best effort" — on some phones/browsers (especially
// during an active WebXR session, where the browser may give XR
// exclusive access to motion sensors) this will never fire any events.
//
// If no usable heading arrives within FALLBACK_TIMEOUT_MS, this hook
// reports heading = null so the caller (SpatialCompass) can fall back to
// anchor-relative behavior instead of a real compass.
//
// Cross-browser handling:
// - Android Chrome/Firefox/Opera: 'deviceorientationabsolute' event,
//   event.alpha is already relative to magnetic north when absolute.
// - iOS Safari (and Chrome/Firefox on iOS, which use WebKit under the
//   hood): 'deviceorientationabsolute' does NOT fire. Must call
//   DeviceOrientationEvent.requestPermission() (user-gesture-gated) then
//   listen to plain 'deviceorientation' and read
//   event.webkitCompassHeading instead.

import { useEffect, useRef, useState } from 'react';

type CompassState = {
  headingDegrees: number | null; // 0-360, 0 = North. null = not available.
  isReal: boolean; // true only if this came from an absolute/compass source
};

const FALLBACK_TIMEOUT_MS = 2500;

interface WebkitDeviceOrientationEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}

interface DeviceOrientationEventConstructorWithPermission {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

// TILT FIX: raw event.alpha is only reliable while the phone is roughly
// flat/upright in its "normal" orientation. When the phone pitches
// steeply (e.g. pointing down at the floor, ~180° on the beta/gamma
// axes), alpha alone starts reporting the wrong rotation — that's the
// "poles flip when I point the camera down" bug. The fix is to build the
// FULL 3D rotation from alpha+beta+gamma and extract just the
// world-frame Z-axis rotation (yaw/heading) from it — that value stays
// correct regardless of how much the phone is tilted forward/back,
// because it's derived from the complete orientation, not just one raw
// angle in isolation.
//
// This follows the standard device-orientation -> compass heading
// rotation-matrix method (w3c deviceorientation spec's compassHeading
// example), applied to both the Android absolute-alpha path and (as a
// safety net) the iOS path.
function computeTiltCompensatedHeading(alphaDeg: number, betaDeg: number, gammaDeg: number): number {
  const degToRad = Math.PI / 180;
  const alpha = alphaDeg * degToRad;
  const beta = betaDeg * degToRad;
  const gamma = gammaDeg * degToRad;

  const cA = Math.cos(alpha), sA = Math.sin(alpha);
  const cB = Math.cos(beta), sB = Math.sin(beta);
  const cG = Math.cos(gamma), sG = Math.sin(gamma);

  // Rotation matrix R = Rz(alpha) * Rx(beta) * Ry(gamma), following the
  // W3C DeviceOrientation spec's axis convention. We only need the two
  // components that give us the world-frame heading of the device's
  // "top" (out-of-screen-top) direction projected onto the horizontal
  // plane — this is what stays well-defined even when beta/gamma
  // indicate a steep tilt.
  const rM11 = cA * cG - sA * sB * sG;
  const rM21 = sA * cG + cA * sB * sG;

  let headingRad = Math.atan2(rM11, rM21);
  if (headingRad < 0) headingRad += 2 * Math.PI;

  return (headingRad * 180) / Math.PI;
}

export function useCompassHeading(enabled: boolean): CompassState {
  const [state, setState] = useState<CompassState>({ headingDegrees: null, isReal: false });
  const gotAnyEventRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setState({ headingDegrees: null, isReal: false });
      return;
    }

    cancelledRef.current = false;
    gotAnyEventRef.current = false;

    // Plain 'deviceorientation' handler — used on iOS via
    // webkitCompassHeading, and skipped on Android if the absolute
    // event below is working (to avoid double-handling / conflicting
    // values).
    let usingAbsoluteEvent = false;

    function handleAbsolute(event: DeviceOrientationEvent) {
      if (cancelledRef.current) return;
      if (event.alpha == null) return;
      usingAbsoluteEvent = true;
      gotAnyEventRef.current = true;
      // TILT FIX: use full alpha/beta/gamma -> tilt-compensated heading
      // instead of raw event.alpha, so pointing the camera steeply up
      // or down doesn't flip N/S/E/W. Falls back to raw alpha if beta or
      // gamma aren't available (shouldn't normally happen, but keeps
      // this from silently breaking on an unusual device).
      const heading =
        event.beta != null && event.gamma != null
          ? computeTiltCompensatedHeading(event.alpha, event.beta, event.gamma)
          : event.alpha;
      setState({ headingDegrees: heading, isReal: true });
    }

    function handlePlain(event: Event) {
      if (cancelledRef.current) return;
      if (usingAbsoluteEvent) return; // absolute event already handling it
      const e = event as WebkitDeviceOrientationEvent;
      if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
        // webkitCompassHeading is already 0-360 with 0 = North, and
        // (unlike alpha) already accounts for screen orientation.
        gotAnyEventRef.current = true;
        setState({ headingDegrees: e.webkitCompassHeading, isReal: true });
      }
    }

    async function setup() {
      const DOE = window.DeviceOrientationEvent as unknown as
        | (DeviceOrientationEventConstructorWithPermission & typeof DeviceOrientationEvent)
        | undefined;

      // iOS/WebKit gate: must request permission (requires this to run
      // from a user-gesture-triggered call chain — e.g. right after the
      // "Enter AR" button tap — otherwise the promise silently rejects).
      if (DOE && typeof DOE.requestPermission === 'function') {
        try {
          const result = await DOE.requestPermission();
          if (result !== 'granted') {
            return; // user denied — stay in fallback (headingDegrees: null)
          }
        } catch {
          return; // permission call failed/not from a user gesture
        }
      }

      // Try the absolute event first (Android/Chrome/Firefox/Opera).
      window.addEventListener('deviceorientationabsolute', handleAbsolute as EventListener);
      // Always also listen to plain deviceorientation for the iOS
      // webkitCompassHeading path — harmless no-op on browsers where
      // the absolute event already works, since handlePlain bails out
      // once usingAbsoluteEvent is true.
      window.addEventListener('deviceorientation', handlePlain as EventListener);
    }

    setup();

    const timeoutId = setTimeout(() => {
      if (!gotAnyEventRef.current && !cancelledRef.current) {
        // Nothing arrived — signal fallback mode.
        setState({ headingDegrees: null, isReal: false });
      }
    }, FALLBACK_TIMEOUT_MS);

    return () => {
      cancelledRef.current = true;
      clearTimeout(timeoutId);
      window.removeEventListener('deviceorientationabsolute', handleAbsolute as EventListener);
      window.removeEventListener('deviceorientation', handlePlain as EventListener);
    };
  }, [enabled]);

  return state;
}
