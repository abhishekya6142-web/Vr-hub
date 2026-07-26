import { useCallback, useEffect, useRef, useState } from 'react';
import VRHub from './VRHub';

// ---------------------------------------------------------------------------
// XRHub — WebXR "immersive-ar" session wrapper.
//
// Ye existing VRHub.tsx ko BILKUL AS-IS render karta hai — koi UI code yahan
// duplicate ya rewrite nahi hua. Sirf ek naya layer add hua hai jo:
//
//   1. WebXR "immersive-ar" session start karta hai (real camera passthrough +
//      real-world 6DoF tracking — position AND rotation, na ki sirf gyroscope
//      wala rotation-only illusion jo SpatialAnchor abhi deta hai).
//   2. Us session ka "dom-overlay" feature use karke, poore VRHub tree ko
//      transparent-background overlay ke roop me dikhata hai, camera feed ke
//      upar.
//
// Iska matlab: Home screen, app panels, iframes (Google/YouTube/Calendar),
// hand-tracking, dwell-engine — sab kuch bilkul waisa hi chalega jaisa
// pehle chalta tha. Sirf background ab asli camera hai (fake gyroscope-tilt
// ki jagah), aur DOM Overlay khud world-locked hota hai screen-space me,
// jab tak WebXR session active hai.
//
// Yeh alag file/route/deployment ke liye hai — VRHub.tsx me koi change nahi.
// ---------------------------------------------------------------------------

type XRSessionMode = 'immersive-ar';

// Minimal ambient types — WebXR abhi tak TypeScript ke lib.dom.d.ts me
// officially poori tarah nahi hai, isliye zaroori surface yahan define kiya.
interface XRSessionLike {
  addEventListener(type: 'end', listener: () => void): void;
  removeEventListener(type: 'end', listener: () => void): void;
  end(): Promise<void>;
  updateRenderState?: (state: { baseLayer?: unknown }) => void;
}

interface NavigatorXR {
  xr?: {
    isSessionSupported: (mode: XRSessionMode) => Promise<boolean>;
    requestSession: (
      mode: XRSessionMode,
      options?: {
        requiredFeatures?: string[];
        optionalFeatures?: string[];
        domOverlay?: { root: HTMLElement };
      },
    ) => Promise<XRSessionLike>;
  };
}

export function XRHub() {
  const [supportChecked, setSupportChecked] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overlayRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<XRSessionLike | null>(null);

  useEffect(() => {
    const nav = navigator as unknown as NavigatorXR;
    if (!nav.xr) {
      setIsSupported(false);
      setSupportChecked(true);
      return;
    }
    nav.xr
      .isSessionSupported('immersive-ar')
      .then((supported) => {
        setIsSupported(supported);
        setSupportChecked(true);
      })
      .catch(() => {
        setIsSupported(false);
        setSupportChecked(true);
      });
  }, []);

  const endSession = useCallback(() => {
    sessionRef.current?.end().catch(() => {
      // Session might already be ending; ignore.
    });
  }, []);

  const startSession = useCallback(async () => {
    setError(null);
    const nav = navigator as unknown as NavigatorXR;
    if (!nav.xr || !overlayRef.current) return;

    try {
      const session = await nav.xr.requestSession('immersive-ar', {
        // dom-overlay hi is poore approach ka core hai — isके bina AR session
        // sirf ek blank WebGL canvas hoga, humara DOM UI nahi dikhega.
        optionalFeatures: ['dom-overlay'],
        domOverlay: { root: overlayRef.current },
      });

      sessionRef.current = session;
      session.addEventListener('end', () => {
        sessionRef.current = null;
        setSessionActive(false);
      });

      setSessionActive(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start AR session');
    }
  }, []);

  useEffect(() => {
    return () => {
      // Component unmount hote waqt session zaroor close karo — warna
      // camera stream background me lock rehta hai.
      sessionRef.current?.end().catch(() => {});
    };
  }, []);

  // ---- Pre-session UI: sirf ek "Enter AR" button, VRHub abhi render nahi hota ----
  if (!sessionActive) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-black text-white">
        <h1 className="text-xl font-semibold">VR Hub — WebXR Mode</h1>

        {!supportChecked && <p className="text-white/60">Checking AR support…</p>}

        {supportChecked && !isSupported && (
          <p className="max-w-xs text-center text-sm text-red-400">
            WebXR immersive-ar is not supported on this browser/device. Use the
            regular (non-XR) VR Hub instead.
          </p>
        )}

        {supportChecked && isSupported && (
          <button
            type="button"
            onClick={startSession}
            className="rounded-full bg-orange-600 px-6 py-3 text-base font-semibold text-white shadow-lg shadow-black/50 active:scale-95"
          >
            Enter AR
          </button>
        )}

        {error && <p className="max-w-xs text-center text-sm text-red-400">{error}</p>}
      </div>
    );
  }

  // ---- Active session: DOM Overlay root renders the ENTIRE existing VRHub UI as-is ----
  return (
    <div
      ref={overlayRef}
      className="fixed inset-0"
      style={{
        // WebXR DOM Overlay requires a transparent background so the camera
        // passthrough shows through behind the UI.
        background: 'transparent',
      }}
    >
      <VRHub transparentBg />

      <button
        type="button"
        onClick={endSession}
        className="fixed top-4 right-4 z-[9999] rounded-full bg-black/70 px-4 py-2 text-xs font-semibold text-white shadow-lg"
      >
        Exit AR
      </button>
    </div>
  );
}

export default XRHub;
