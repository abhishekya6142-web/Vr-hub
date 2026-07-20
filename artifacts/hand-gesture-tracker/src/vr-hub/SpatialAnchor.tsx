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

  const referenceRef = useRef<{ alpha: number; beta: number } | null>(null);
  const latestReadingRef = useRef<{ alpha: number; beta: number } | null>(null);
  const grantedRef = useRef(false);

  const smoothedValuesRef = useRef({ shiftX: 0, shiftY: 0, rotateX: 0, rotateY: 0 });

  // ==========================================
  // 🛠️ DEVELOPER CONTROLS (TWEAK THESE)
  // ==========================================
  // Agar phone Right ghumane par panel Right hi jaa raha hai (instead of Left), toh ise true/false karein
  const INVERT_X = false; 
  
  // Agar phone Upar dekhne par panel Upar hi jaa raha hai (instead of Niche), toh ise true/false karein
  const INVERT_Y = true;  
  
  const PX_PER_DEGREE = 22; // Movement speed/distance
  const LERP_FACTOR = 0.15; // Lower is smoother/laggy, Higher is snappy
  // ==========================================

  function shortestAngleDelta(current: number, reference: number) {
    let delta = current - reference;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    return delta;
  }

  function recompute() {
    const ref = referenceRef.current;
    if (!ref || !latestReadingRef.current) return;

    let latest = latestReadingRef.current;

    // Sirf Alpha (Yaw) aur Beta (Pitch) use kar rahe hain. 
    // Gamma (Roll) ko ignore kar diya taaki wo round-round spin na ho!
    const yawDelta = shortestAngleDelta(latest.alpha, ref.alpha);
    const pitchDelta = shortestAngleDelta(latest.beta, ref.beta);

    // X aur Y coordinates calculate karna for anchoring
    const targetShiftX = yawDelta * PX_PER_DEGREE * (INVERT_X ? -1 : 1);
    const targetShiftY = pitchDelta * PX_PER_DEGREE * (INVERT_Y ? -1 : 1);

    // Halki si 3D tilt detail parallax feel ke liye (max 15 degrees)
    const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));
    const targetRotateY = clamp(targetShiftX * 0.015, 15);
    const targetRotateX = clamp(-targetShiftY * 0.015, 15);

    // Smooth LERP calculations
    const current = smoothedValuesRef.current;
    current.shiftX += (targetShiftX - current.shiftX) * LERP_FACTOR;
    current.shiftY += (targetShiftY - current.shiftY) * LERP_FACTOR;
    current.rotateX += (targetRotateX - current.rotateX) * LERP_FACTOR;
    current.rotateY += (targetRotateY - current.rotateY) * LERP_FACTOR;

    setDebugInfo(
      `Yaw: ${yawDelta.toFixed(0)}° | Pitch: ${pitchDelta.toFixed(0)}°`
    );

    // Apply via Translate3D (Rock Solid Positioning)
    setStyle({
      transform: `translate3d(${current.shiftX}px, ${current.shiftY}px, 0) rotateX(${current.rotateX}deg) rotateY(${current.rotateY}deg)`,
    });
  }

  function recenter() {
    const latest = latestReadingRef.current;
    if (!latest) return;
    
    referenceRef.current = { ...latest };
    smoothedValuesRef.current = { shiftX: 0, shiftY: 0, rotateX: 0, rotateY: 0 };

    setStyle({ transform: 'translate3d(0,0,0) rotateX(0deg) rotateY(0deg)' });
    setDebugInfo('View Recentered');
  }

  useEffect(() => {
    function handleOrientation(e: DeviceOrientationEvent) {
      setEventCount((c) => c + 1);
      if (e.beta == null || e.alpha == null) return;

      latestReadingRef.current = { alpha: e.alpha, beta: e.beta };
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
    }, 400);

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
    <div style={{ perspective: '1000px', width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}>
      
      {/* Debug UI */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          zIndex: 9999,
          background: 'rgba(0,0,0,0.7)',
          color: '#00ffcc',
          fontSize: '11px',
          fontFamily: 'monospace',
          padding: '6px 10px',
          borderRadius: '6px',
          pointerEvents: 'none',
        }}
      >
        FPS: {eventCount} | {debugInfo}
      </div>

      <button
        type="button"
        onClick={recenter}
        style={{
          position: 'absolute',
          bottom: 40,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 9999,
          background: 'rgba(255,255,255,0.15)',
          backdropFilter: 'blur(10px)',
          color: '#fff',
          fontSize: '14px',
          fontWeight: 600,
          padding: '12px 24px',
          borderRadius: '99px',
          border: '1px solid rgba(255,255,255,0.2)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        }}
      >
        Recenter View
      </button>

      {/* Floating Spatial Panel Container */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          // Sirf X/Y translation use kar rahe hain, isliye spin nahi hoga!
          transform: `translate(-50%, -50%) ${style.transform}`,
          transition: 'none', 
          transformStyle: 'preserve-3d',
          willChange: 'transform',
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
