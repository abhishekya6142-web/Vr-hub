import { useEffect, useRef, type ReactNode } from 'react';
import { spatialTrackingEngine } from './spatial-tracking-engine';
import { xrPoseEngine } from './xr-pose-engine';

// Pehle har SpatialAnchor apna khud ka deviceorientation listener + RAF loop
// + quaternion/EMA calculation chalata tha. Ab sab kuch spatial-tracking-engine.ts
// ke shared singleton me hai — ye component sirf us engine ko subscribe karta
// hai aur latest transform apply karta hai. N panels open hone par bhi
// sirf ek hi listener/RAF chalta hai, is component ke andar kuch nahi.
//
// XR world-locking: jab ek WebXR immersive-ar session active hai (XRHub.tsx
// se), VRHub.tsx ka OUTER WRAPPER already xr-pose-engine.ts ke
// cameraMatrix3d/sceneMatrix3d ko poore panel row par apply kar chuka hota
// hai — poora world-lock wahin se aata hai. Is component ko XR mode me
// DOBARA koi transform nahi lagana chahiye (pehle ye xrPoseEngine ko bhi
// subscribe karta tha with a stale/wrong API — t.translateXpx wagaira jo
// WorldLockedTransform type me exist hi nahi karte, isliye NaN transform
// lagta tha — aur saath me double world-locking bhi ho rahi thi: ek layer
// VRHub ke wrapper se, ek (broken) layer yahan se). Ab XR active hone par
// ye component identity transform par rehta hai aur kuch nahi karta — sari
// positioning/rotation VRHub.tsx ke wrapper se aati hai.
//
// Normal (non-XR) mode me pehle jaisa hi gyroscope-based spatialTrackingEngine
// behavior chalta hai, koi change nahi.
//
// Debug overlay aur Recenter button yahan se hata diye gaye hain — Recenter
// ab VRHub level pe ek hi jagah render hota hai.
type SpatialAnchorProps = {
  children: ReactNode;
  // Har panel ka apna depth illusion — near (far se dur, isliye "user ke
  // paas") panels ko zyada parallax (>1), far/cinematic panels ko kam
  // parallax (<1) chahiye. Default 1 = purana/uniform behavior, so agar
  // koi existing usage prop nahi deta to exactly pehle jaisa chalega.
  // NOTE: XR mode me ye prop currently kuch nahi karta (world-lock VRHub
  // wrapper se aata hai) — sirf non-XR gyroscope fallback me apply hota hai.
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
    function applyTransform(shiftX: number, shiftY: number, rotateX: number, rotateY: number) {
      const el = groupRef.current;
      if (!el) return;

      let scale = 1;
      if (scaleCompensation) {
        const totalTilt = Math.abs(rotateX) + Math.abs(rotateY);
        scale = 1 - Math.min(totalTilt, 20) * 0.00075;
      }

      el.style.transform = `translate3d(${shiftX}px, ${shiftY}px, 0) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(${scale})`;
    }

    // FIX: XR active ho to ye component kuch mat kare — VRHub.tsx ka
    // outer wrapper (cameraMatrix3d/sceneMatrix3d) already poora
    // world-lock kar raha hai. Pehle yahan xrPoseEngine ko bhi subscribe
    // kiya jaata tha ek outdated API (translateXpx/rotateXdeg) ke sath jo
    // ab exist hi nahi karti — har frame NaN transform lagta tha, aur
    // saath hi double world-locking (rotation/distance ka galat feel) bhi
    // ho rahi thi. Ab identity transform par rakhte hain, kuch nahi karte.
    if (xrPoseEngine.isActive()) {
      const el = groupRef.current;
      if (el) el.style.transform = 'translate3d(0,0,0) rotateX(0deg) rotateY(0deg)';
      return;
    }

    // Normal mode: gyroscope-only illusion (unchanged behavior).
    const unsubscribeGyro = spatialTrackingEngine.subscribe((t) => {
      if (xrPoseEngine.isActive()) return; // XR pose takes priority when active
      applyTransform(
        t.shiftX * parallaxAmount,
        t.shiftY * parallaxAmount,
        t.rotateX * parallaxAmount,
        t.rotateY * parallaxAmount,
      );
    });

    return () => {
      unsubscribeGyro();
    };
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
