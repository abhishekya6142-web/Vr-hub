// PerfOverlay.tsx
//
// TEMP (measurement only): chhota fixed-position overlay jo screen ke
// top-left corner mein XR render FPS, camera-extraction FPS, aur
// MediaPipe FPS live dikhata hai. Sirf DEBUG_PERF_LOG=true hone par
// koi data aayega (baaki files mein flag on hai) — is component ko
// khud kabhi remove/disable nahi karna padega, VRHub.tsx se sirf ek
// line (<PerfOverlay />) hata dena kaafi hai jab measurement khatam
// ho jaaye.

import { useEffect, useRef } from 'react';
import { perfStats, type PerfStats } from './perf-stats';

function fmtFps(v: number | null): string {
  return v === null ? '--' : v.toFixed(0);
}

function fmtMs(v: number | null): string {
  return v === null ? '--' : v.toFixed(1);
}

// FIX (perf — no more React re-render per update): pehle ye component
// useState use karta tha, jiska matlab har ~1 second (XR/camera/
// mediapipe teeno se) ek React re-render trigger hota tha. Lambe
// session mein (jaisa perf-testing ke dauran hota hai) ye accumulate
// ho sakta tha aur khud performance-degradation ka ek chhota factor
// ban sakta tha — jo ki bilkul ironic hota, ek "measurement tool" khud
// jis cheez ko measure kar raha hai usko slow kar de. Ab seedha DOM
// text content update karte hain (ref ke through), React render cycle
// se bilkul bahar — zero re-render cost.
export function PerfOverlay() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return perfStats.subscribe((stats: PerfStats) => {
      if (!ref.current) return;
      ref.current.textContent = `XR render:   ${fmtFps(stats.xrRenderFps)} fps
Cam extract: ${fmtFps(stats.cameraExtractionFps)} fps (${fmtMs(stats.cameraExtractionAvgMs)}ms)
MediaPipe:   ${fmtFps(stats.mediapipeFps)} fps (${fmtMs(stats.mediapipeAvgMs)}ms)`;
    });
  }, []);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        top: 8,
        left: 8,
        zIndex: 999999,
        background: 'rgba(0,0,0,0.75)',
        color: '#0f0',
        fontFamily: 'monospace',
        fontSize: 11,
        lineHeight: 1.5,
        padding: '6px 8px',
        borderRadius: 6,
        pointerEvents: 'none',
        whiteSpace: 'pre',
      }}
    />
  );
}

export default PerfOverlay;
