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

// Standard quaternion-to-heading extraction (yaw around the world Z/up
// axis). This is the well-known formula for extracting the Z-axis Euler
// angle from a quaternion [x, y, z, w] — used as-is, not re-derived, to
// avoid repeating the earlier mistake of hand-deriving trig from
// scratch. AbsoluteOrientationSensor's .quaternion is defined in the
// same coordinate frame as DeviceOrientationEvent's alpha/beta/gamma
// (Z-up, following the W3C spec), so this yaw value is directly usable
// as a compass heading once converted to the 0-360 "0 = North" range.
function quaternionToHeadingDegrees(q: [number, number, number, number]): number {
  const [x, y, z, w] = q;
  // yaw (rotation about Z axis)
  const yawRad = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  let heading = (yawRad * 180) / Math.PI;
  // Normalize to 0-360, and flip sign to match compass convention
  // (alpha/heading increases clockwise when viewed from above, same as
  // DeviceOrientationEvent.alpha).
  heading = -heading;
  heading = ((heading % 360) + 360) % 360;
  return heading;
}

interface AbsoluteOrientationSensorLike {
  quaternion: [number, number, number, number];
  start: () => void;
  stop: () => void;
  addEventListener: (type: 'reading' | 'error', cb: (event?: unknown) => void) => void;
  removeEventListener: (type: 'reading' | 'error', cb: (event?: unknown) => void) => void;
}

interface AbsoluteOrientationSensorConstructor {
  new (options?: { frequency?: number }): AbsoluteOrientationSensorLike;
}

declare const AbsoluteOrientationSensor: AbsoluteOrientationSensorConstructor | undefined;

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
    let orientationSensor: AbsoluteOrientationSensorLike | null = null;

    function handleSensorReading() {
      if (cancelledRef.current || !orientationSensor) return;
      const heading = quaternionToHeadingDegrees(orientationSensor.quaternion);
      usingAbsoluteEvent = true; // also suppress the deviceorientation fallback path
      gotAnyEventRef.current = true;
      setState({ headingDegrees: heading, isReal: true });
    }

    async function trySensorAPI(): Promise<boolean> {
      if (typeof AbsoluteOrientationSensor === 'undefined') return false;
      try {
        const results = await Promise.all([
          navigator.permissions?.query({ name: 'accelerometer' as PermissionName }),
          navigator.permissions?.query({ name: 'magnetometer' as PermissionName }),
          navigator.permissions?.query({ name: 'gyroscope' as PermissionName }),
        ]);
        const allGranted = results.every((r) => !r || r.state === 'granted' || r.state === 'prompt');
        if (!allGranted) return false;

        orientationSensor = new AbsoluteOrientationSensor({ frequency: 30 });
        orientationSensor.addEventListener('reading', handleSensorReading);
        orientationSensor.addEventListener('error', () => {
          // Sensor failed to start (e.g. no magnetometer hardware, or
          // permission actually denied at the OS level) — let the
          // fallback timeout below hand off to deviceorientation/anchor.
        });
        orientationSensor.start();
        return true;
      } catch {
        return false;
      }
    }

    function handleAbsolute(event: DeviceOrientationEvent) {
      if (cancelledRef.current) return;
      if (event.alpha == null) return;
      // Reverted tilt-compensation attempt — it made headings wrong in
      // general, not just under extreme tilt. Back to raw alpha, which
      // is correct for normal phone orientation and only glitches at
      // steep pitch angles.
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
      // First choice: AbsoluteOrientationSensor (fusion sensor, quaternion
      // based, does not suffer from the alpha/beta/gamma gimbal-lock-style
      // tilt bug). Falls through to the deviceorientation-based paths
      // below if unavailable/unsupported/denied.
      const sensorStarted = await trySensorAPI();
      if (sensorStarted) return;

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
      if (orientationSensor) {
        orientationSensor.removeEventListener('reading', handleSensorReading);
        orientationSensor.stop();
      }
      window.removeEventListener('deviceorientationabsolute', handleAbsolute as EventListener);
      window.removeEventListener('deviceorientation', handlePlain as EventListener);
    };
  }, [enabled]);

  return state;
}
