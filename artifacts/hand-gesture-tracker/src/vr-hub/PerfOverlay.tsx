// PerfOverlay.tsx
//
// TEMP (measurement only): chhota fixed-position overlay jo screen ke
// top-left corner mein XR render FPS, camera-extraction FPS, aur
// MediaPipe FPS live dikhata hai. Sirf DEBUG_PERF_LOG=true hone par
// koi data aayega (baaki files mein flag on hai) — is component ko
// khud kabhi remove/disable nahi karna padega, VRHub.tsx se sirf ek
// line (<PerfOverlay />) hata dena kaafi hai jab measurement khatam
// ho jaaye.

import { useEffect, useState } from 'react';
import { perfStats, type PerfStats } from './perf-stats';

function fmtFps(v: number | null): string {
  return v === null ? '--' : v.toFixed(0);
}

function fmtMs(v: number | null): string {
  return v === null ? '--' : v.toFixed(1);
}

export function PerfOverlay() {
  const [stats, setStats] = useState<PerfStats>(perfStats.getSnapshot());

  useEffect(() => {
    return perfStats.subscribe(setStats);
  }, []);

  return (
    <div
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
    >
      {`XR render:   ${fmtFps(stats.xrRenderFps)} fps
Cam extract: ${fmtFps(stats.cameraExtractionFps)} fps (${fmtMs(stats.cameraExtractionAvgMs)}ms)
MediaPipe:   ${fmtFps(stats.mediapipeFps)} fps (${fmtMs(stats.mediapipeAvgMs)}ms)`}
    </div>
  );
}

export default PerfOverlay;
