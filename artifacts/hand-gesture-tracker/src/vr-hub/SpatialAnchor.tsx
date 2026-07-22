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
type SpatialAnchorProps = {
  children: ReactNode;
  // Har panel ka apna depth illusion — near (far se dur, isliye "user ke
  // paas") panels ko zyada parallax (>1), far/cinematic panels ko kam
  // parallax (<1) chahiye. Default 1 = purana/uniform behavior, so agar
  // koi existing usage prop nahi deta to exactly pehle jaisa chalega.
  parallaxAmount?: number;
  // Subtle scale-compensation ke liye: door panels thoda chhote/stable
  // dikhte hain jab head move hoti hai, paas wale panels me thoda
  // "breathing" scale add hota hai — depth ka illusion badhane ke liye.
  scaleCompensation?: boolean;
};

export function SpatialAnchor({
  children,
  parallaxAmount = 1,
  scaleCompensation = true,
}: SpatialAnchorProps) {
  const groupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubscribe = spatialTrackingEngine.subscribe((t) => {
      const el = groupRef.current;
      if (!el) return;

      const shiftX = t.shiftX * parallaxAmount;
      const shiftY = t.shiftY * parallaxAmount;
      const rotateX = t.rotateX * parallaxAmount;
      const rotateY = t.rotateY * parallaxAmount;

      // Subtle scale compensation — jitna zyada tilt/shift, utna halka sa
      // scale-down, taaki panel "physically hinged" lage instead of flat
      // sliding. Bahut chhota effect hai (max ~1.5%), taaki content ka
      // layout disturb na ho.
      let scale = 1;
      if (scaleCompensation) {
        const totalTilt = Math.abs(rotateX) + Math.abs(rotateY);
        scale = 1 - Math.min(totalTilt, 20) * 0.00075;
      }

      el.style.transform = `translate3d(${shiftX}px, ${shiftY}px, 0) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(${scale})`;
    });
    return unsubscribe;
  }, [parallaxAmount, scaleCompensation]);

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
