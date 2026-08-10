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
//
// NOTE: this is the plain/baseline version. Two attempts at fixing the
// known tilt-flip glitch (a hand-derived tilt-compensation formula, and
// the AbsoluteOrientationSensor fusion-sensor API) were both tried and
// both made things worse in practice, so both were reverted. This file
// intentionally does neither — just raw alpha / webkitCompassHeading,
// no extra math, no extra sensors.

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
      setState({ headingDegrees: event.alpha, isReal: true });
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
