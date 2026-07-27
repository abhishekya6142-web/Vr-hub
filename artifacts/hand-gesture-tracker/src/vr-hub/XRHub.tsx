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
// FIX (previous bug): pehle overlay <div> sirf "sessionActive === true" hone
// par render hota tha. Lekin startSession() ko session start hone SE PEHLE
// hi domOverlay.root chahiye hota hai — matlab button dabane ke waqt
// overlayRef.current hamesha null milta tha, aur function silently
// "if (!overlayRef.current) return" pe ruk jaata tha, koi error dikhaye
// bina. Ab overlay <div> HAMESHA mounted rehta hai (visibility se control
// hota hai, mounting se nahi) — taaki ref hamesha valid rahe.
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

    if (!nav.xr) {
      setError('navigator.xr is not available.');
      return;
    }
    if (!overlayRef.current) {
      setError('Overlay root not ready yet — please try again.');
      return;
    }

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
      // Detailed error surface — name + message dono, taaki debug karna
      // aasan ho (e.g. "NotSupportedError: Session request failed").
      if (e instanceof DOMException) {
        setError(`${e.name}: ${e.message}`);
      } else if (e instanceof Error) {
        setError(`${e.name}: ${e.message}`);
      } else {
        setError(`Failed to start AR session: ${String(e)}`);
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      // Component unmount hote waqt session zaroor close karo — warna
      // camera stream background me lock rehta hai.
      sessionRef.current?.end().catch(() => {});
    };
  }, []);

  return (
    <>
      {/* Pre-session UI — sirf tab dikhta hai jab session active nahi hai.
          Ye "display" se control hota hai, conditional-render se nahi,
          taaki overlay div (neeche) hamesha DOM me rahe. */}
      {!sessionActive && (
        <div className="fixed inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black text-white">
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

          {error && (
            <p className="max-w-xs break-words text-center text-sm text-red-400">{error}</p>
          )}
        </div>
      )}

      {/* DOM Overlay root — HAMESHA mounted (chahe session active ho ya na ho).
          Jab session active nahi hai, ye khaali/invisible rehta hai (koi
          content nahi, kyunki VRHub sirf sessionActive true hone par
          andar render hota hai) — lekin ref hamesha valid rehta hai taaki
          startSession() ise turant use kar sake. */}
      <div
        ref={overlayRef}
        className="fixed inset-0"
        style={{
          background: 'transparent',
          // Session active na hone par ye layer pointer-events consume na
          // kare — upar wala pre-session UI hi interactive rahe.
          pointerEvents: sessionActive ? 'auto' : 'none',
        }}
      >
        {sessionActive && (
          <>
            <VRHub transparentBg />
            <button
              type="button"
              onClick={endSession}
              className="fixed top-4 right-4 z-[9999] rounded-full bg-black/70 px-4 py-2 text-xs font-semibold text-white shadow-lg"
            >
              Exit AR
            </button>
          </>
        )}
      </div>
    </>
  );
}

export default XRHub;
