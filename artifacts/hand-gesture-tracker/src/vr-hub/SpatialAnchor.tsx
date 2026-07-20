import { useEffect, useRef, useState, type ReactNode } from 'react';

type DeviceOrientationEventWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

interface SpatialAnchorProps {
  children: ReactNode;
  /** Distance in pixels to float the panel inside the 3D depth frustum (default: 600) */
  distance?: number;
}

export function SpatialAnchor({ children, distance = 600 }: SpatialAnchorProps) {
  const [worldTransform, setWorldTransform] = useState<string>('rotateX(0deg) rotateY(0deg) rotateZ(0deg)');
  const [debugInfo, setDebugInfo] = useState('Initializing spatial viewport...');
  const [eventCount, setEventCount] = useState(0);

  const referenceRef = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
  const latestReadingRef = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
  const grantedRef = useRef(false);

  // Asli VR View-Matrix Smoothing parameters
  const smoothedAnglesRef = useRef({ yaw: 0, pitch: 0, roll: 0 });

  function shortestAngleDelta(current: number, reference: number) {
    let delta = current - reference;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    return delta;
  }

  function recompute() {
    const ref = referenceRef.current;
    if (!ref || !latestReadingRef.current) return;

    const latest = { ...latestReadingRef.current };

    // Strict angular orientation deltas calculation
    const yawDelta = shortestAngleDelta(latest.alpha, ref.alpha);
    const pitchDelta = shortestAngleDelta(latest.beta, ref.beta);
    const rollDelta = shortestAngleDelta(latest.gamma, ref.gamma);

    // VR RESEARCH: To anchor an object in space, the world must rotate 
    // inversely relative to the camera's orientation vectors.
    const targetYaw = -yawDelta;
    const targetPitch = -pitchDelta;
    const targetRoll = -rollDelta;

    // Smooth Quaternion-like Euler LERP (Buttery smooth tracking without jitter)
    const LERP_FACTOR = 0.09; 
    const current = smoothedAnglesRef.current;

    current.yaw += (targetYaw - current.yaw) * LERP_FACTOR;
    current.pitch += (targetPitch - current.pitch) * LERP_FACTOR;
    current.roll += (targetRoll - current.roll) * LERP_FACTOR;

    setDebugInfo(
      `Yaw: ${current.yaw.toFixed(1)}° | Pitch: ${current.pitch.toFixed(1)}° | Depth: -${distance}px`
    );

    // Apply exact 3D rotation order matching the spatial inverse matrix
    setWorldTransform(
      `rotateX(${current.pitch}deg) rotateY(${current.yaw}deg) rotateZ(${current.roll}deg)`
    );
  }

  function recenter() {
    const latest = latestReadingRef.current;
    if (!latest) return;
    
    referenceRef.current = { ...latest };
    smoothedAnglesRef.current = { yaw: 0, pitch: 0, roll: 0 };

    setWorldTransform('rotateX(0deg) rotateY(0deg) rotateZ(0deg)');
    setDebugInfo('Recentered spatial coordinates.');
  }

  useEffect(() => {
    function handleOrientation(e: DeviceOrientationEvent) {
      setEventCount((c) => c + 1);
      if (e.beta == null || e.gamma == null) return;

      latestReadingRef.current = { 
        alpha: e.alpha ?? 0, 
        beta: e.beta, 
        gamma: e.gamma 
      };
    }

    window.addEventListener('deviceorientation', handleOrientation);

    // High precision render loop syncing directly with device refresh rate
    let rafId: number;
    const tick = () => {
      recompute();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    const autoRecenterTimer = setTimeout(() => {
      recenter();
    }, 500);

    return () => {
      window.removeEventListener('deviceorientation', handleOrientation);
      cancelAnimationFrame(rafId);
      clearTimeout(autoRecenterTimer);
    };
  }, [distance]);

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
    <div 
      style={{ 
        perspective: '1000px', 
        perspectiveOrigin: 'center center',
        width: '100vw', 
        height: '100vh', 
        overflow: 'hidden',
        position: 'relative',
        backgroundColor: '#000'
      }}
    >
      {/* VR Status overlay */}
      <div
        style={{
          position: 'fixed',
          top: 12,
          left: 12,
          zIndex: 9999999,
          background: 'rgba(15, 15, 15, 0.85)',
          backdropFilter: 'blur(8px)',
          color: '#00e5ff',
          fontSize: '11px',
          fontFamily: 'monospace',
          padding: '8px 12px',
          borderRadius: '8px',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          pointerEvents: 'none',
        }}
      >
        VR Engine | FPS Trace: {eventCount} | {debugInfo}
      </div>

      <button
        type="button"
        onClick={recenter}
        style={{
          position: 'fixed',
          bottom: 30,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 9999999,
          background: 'rgba(255, 255, 255, 0.15)',
          backdropFilter: 'blur(12px)',
          color: '#fff',
          fontSize: '13px',
          fontWeight: 600,
          padding: '10px 24px',
          borderRadius: '999px',
          border: '1px solid rgba(255, 255, 255, 0.25)',
          cursor: 'pointer',
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)'
        }}
      >
        Recenter View
      </button>

      {/* 3D World Space Wrapper */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transformStyle: 'preserve-3d',
          transform: worldTransform,
          transition: 'none', 
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 0,
          height: 0,
        }}
        onClick={() => {
          if (!grantedRef.current) requestAccess();
        }}
      >
        {/* Spatial Depth Frustum Layer */}
        <div
          style={{
            transform: `translateZ(-${distance}px)`,
            transformStyle: 'preserve-3d',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
