import { useCallback, useEffect, useRef, useState } from 'react';
import VRHub from './VRHub';
import { xrPoseEngine } from './xr-pose-engine';

// ---------------------------------------------------------------------------
// XRHub — WebXR "immersive-ar" session wrapper.
//
// Ye existing VRHub.tsx ko BILKUL AS-IS render karta hai — koi UI code yahan
// duplicate ya rewrite nahi hua. Do naye layers add hue hain:
//
//   1. WebXR "immersive-ar" session + DOM Overlay — poore VRHub tree ko
//      real camera passthrough ke upar dikhata hai.
//   2. Ek hidden WebGL canvas + XRWebGLLayer render loop, jo sirf ek
//      kaam karta hai: har frame WebXR se REAL camera pose (position +
//      rotation, 6DoF) nikaal ke xr-pose-engine.ts ko deta hai. Ye engine
//      us pose ko world-locked panel-transform me convert karta hai.
//      Koi 3D scene actually render nahi hoti — canvas sirf WebXR
//      requirement pura karne ke liye hai (session ko ek baseLayer chahiye
//      hota hai).
//
// FIX (from previous version): overlay <div> ab HAMESHA mounted rehta hai
// (visibility se control hota hai, conditional-render se nahi) — taaki
// startSession() ke waqt overlayRef.current hamesha valid rahe.
// ---------------------------------------------------------------------------

type XRSessionMode = 'immersive-ar';

interface XRRigidTransformLike {
  position: { x: number; y: number; z: number };
  orientation: { x: number; y: number; z: number; w: number };
}

interface XRViewLike {
  transform: XRRigidTransformLike;
}

interface XRViewerPoseLike {
  transform: XRRigidTransformLike;
  views: XRViewLike[];
}

interface XRReferenceSpaceLike {
  addEventListener?: (type: string, cb: () => void) => void;
}

interface XRFrameLike {
  getViewerPose: (refSpace: XRReferenceSpaceLike) => XRViewerPoseLike | undefined;
}

interface XRSessionLike {
  addEventListener(type: 'end', listener: () => void): void;
  removeEventListener(type: 'end', listener: () => void): void;
  end(): Promise<void>;
  updateRenderState: (state: { baseLayer: unknown }) => void;
  requestReferenceSpace: (type: 'local' | 'local-floor' | 'viewer') => Promise<XRReferenceSpaceLike>;
  requestAnimationFrame: (cb: (time: number, frame: XRFrameLike) => void) => number;
  cancelAnimationFrame: (handle: number) => void;
  renderState: { baseLayer?: unknown };
}

interface XRWebGLLayerConstructor {
  new (session: XRSessionLike, gl: WebGLRenderingContext): unknown;
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

declare const XRWebGLLayer: XRWebGLLayerConstructor;

export function XRHub() {
  const [supportChecked, setSupportChecked] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overlayRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<XRSessionLike | null>(null);
  const refSpaceRef = useRef<XRReferenceSpaceLike | null>(null);
  const rafHandleRef = useRef<number | null>(null);
  const lastPoseRef = useRef<XRRigidTransformLike | null>(null);

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

  const onXRFrame = useCallback((_time: number, frame: XRFrameLike) => {
    const session = sessionRef.current;
    const refSpace = refSpaceRef.current;
    if (!session) return;

    // Queue next frame first, so a mid-frame error doesn't kill the loop.
    rafHandleRef.current = session.requestAnimationFrame(onXRFrame);

    if (!refSpace) return;
    const pose = frame.getViewerPose(refSpace);
    if (!pose) return;

    lastPoseRef.current = pose.transform;
    xrPoseEngine.updatePose(pose.transform.position, pose.transform.orientation);
  }, []);

  const endSession = useCallback(() => {
    sessionRef.current?.end().catch(() => {
      // Session might already be ending; ignore.
    });
  }, []);

  const recenter = useCallback(() => {
    const pose = lastPoseRef.current;
    if (pose) {
      xrPoseEngine.recenter(pose.position, pose.orientation);
    } else {
      xrPoseEngine.recenter();
    }
  }, []);

  const startSession = useCallback(async () => {
    setError(null);
    const nav = navigator as unknown as NavigatorXR;

    if (!nav.xr) {
      setError('navigator.xr is not available.');
      return;
    }
    if (!overlayRef.current || !canvasRef.current) {
      setError('Overlay/canvas root not ready yet — please try again.');
      return;
    }

    try {
      const session = await nav.xr.requestSession('immersive-ar', {
        optionalFeatures: ['dom-overlay', 'local-floor'],
        domOverlay: { root: overlayRef.current },
      });

      sessionRef.current = session;

      // WebXR requires a WebGL baseLayer even if we don't render a visible
      // 3D scene — it's how the session drives its render/pose loop.
      let baseLayer: unknown;
      try {
        const glContext = canvasRef.current.getContext('webgl', {
          xrCompatible: true,
        }) as (WebGLRenderingContext & { makeXRCompatible?: () => Promise<void> }) | null;

        if (!glContext) {
          throw new Error('Could not get WebGL context from canvas.');
        }

        if (typeof glContext.makeXRCompatible === 'function') {
          await glContext.makeXRCompatible();
        }

        baseLayer = new XRWebGLLayer(session, glContext);
      } catch (glError) {
        // If WebGL/baseLayer setup fails, end the session cleanly instead
        // of leaving it half-started (which is what was likely causing the
        // immediate crash/tab-kill before).
        await session.end().catch(() => {});
        sessionRef.current = null;
        const msg = glError instanceof Error ? glError.message : String(glError);
        throw new Error(`WebGL/XRWebGLLayer setup failed: ${msg}`);
      }

      session.updateRenderState({ baseLayer });

      // 'local-floor' gives a stable floor-level origin; fall back to
      // 'local' if the device/browser doesn't support it.
      let refSpace: XRReferenceSpaceLike;
      try {
        refSpace = await session.requestReferenceSpace('local-floor');
      } catch {
        refSpace = await session.requestReferenceSpace('local');
      }
      refSpaceRef.current = refSpace;

      xrPoseEngine.start();

      session.addEventListener('end', () => {
        sessionRef.current = null;
        refSpaceRef.current = null;
        if (rafHandleRef.current !== null) {
          session.cancelAnimationFrame(rafHandleRef.current);
          rafHandleRef.current = null;
        }
        xrPoseEngine.stop();
        setSessionActive(false);
      });

      rafHandleRef.current = session.requestAnimationFrame(onXRFrame);
      setSessionActive(true);
    } catch (e) {
      if (e instanceof DOMException) {
        setError(`${e.name}: ${e.message}`);
      } else if (e instanceof Error) {
        setError(`${e.name}: ${e.message}`);
      } else {
        setError(`Failed to start AR session: ${String(e)}`);
      }
    }
  }, [onXRFrame]);

  useEffect(() => {
    return () => {
      sessionRef.current?.end().catch(() => {});
    };
  }, []);

  return (
    <>
      {/* Hidden 1x1 canvas — purely to satisfy WebXR's baseLayer
          requirement. Never resized/shown; no 3D scene is drawn to it. */}
      <canvas ref={canvasRef} width={2} height={2} style={{ display: 'none' }} />

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

      <div
        ref={overlayRef}
        className="fixed inset-0"
        style={{
          background: 'transparent',
          pointerEvents: sessionActive ? 'auto' : 'none',
        }}
      >
        {sessionActive && (
          <>
            {/* recenterOverride: XRHub's own recenter (WebXR pose-based)
                takes priority over VRHub's built-in gyroscope recenter
                button, so both the camera-background AND the world-lock
                origin reset together. */}
            <VRHub transparentBg recenterOverride={recenter} />
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
