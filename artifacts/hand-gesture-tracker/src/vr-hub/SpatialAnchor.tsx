import { useEffect, useRef, type ReactNode } from 'react';
import { spatialTrackingEngine } from './spatial-tracking-engine';

// Pehle har SpatialAnchor apna khud ka deviceorientation listener + RAF loop
// + quaternion/EMA calculation chalata tha. Ab sab kuch spatial-tracking-engine.ts
// ke shared singleton me hai — ye component sirf us engine ko subscribe karta
// hai aur latest transform apply karta hai. N panels open hone par bhi
// sirf ek hi listener/RAF chalta hai, is component ke andar kuch nahi.
//
// Debug overlay aur Recenter button yahan se hata diye gaye hain — Recenter
// ab VRHub level pe ek hi jagah render hota hai (spatialTrackingEngine.recenter
// ko seedha wahan se call kiya ja sakta hai).
export function SpatialAnchor({ children }: { children: ReactNode }) {
  const groupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubscribe = spatialTrackingEngine.subscribe((t) => {
      const el = groupRef.current;
      if (!el) return;
      el.style.transform = `translate3d(${t.shiftX}px, ${t.shiftY}px, 0) rotateX(${t.rotateX}deg) rotateY(${t.rotateY}deg)`;
    });
    return unsubscribe;
  }, []);

  return (
    <div style={{ perspective: '1200px', width: '100%', height: '100%' }}>
      <div
        ref={groupRef}
        style={{
          transform: 'translate3d(0,0,0) rotateX(0deg) rotateY(0deg)',
          transition: 'none',
          transformStyle: 'preserve-3d',
          width: '100%',
          height: '100%',
        }}
        onClick={() => spatialTrackingEngine.requestAccessManually()}
      >
        {children}
      </div>
    </div>
  );
}
