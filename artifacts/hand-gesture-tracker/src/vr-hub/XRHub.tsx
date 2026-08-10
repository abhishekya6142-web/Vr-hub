import { useCallback, useEffect, useRef, useState } from 'react';
import VRHub from './VRHub';
import { xrPoseEngine } from './xr-pose-engine';
import { xrCameraSource } from './xr-camera-source';

type XRSessionMode = 'immersive-ar';

interface XRRigidTransformLike {
  position: { x: number; y: number; z: number };
  orientation: { x: number; y: number; z: number; w: number };
}

interface XRViewLike {
  transform: XRRigidTransformLike;
  camera?: unknown;
}

interface XRViewerPoseLike {
  transform: XRRigidTransformLike;
  views: XRViewLike[];
}

interface XRReferenceSpaceLike {
  addEventListener?: (type: string, cb: () => void) => void;
}

interface XRAnchorLike {
  anchorSpace: XRReferenceSpaceLike;
  delete: () => void;
}

interface XRFrameLike {
  getViewerPose: (refSpace: XRReferenceSpaceLike) => XRViewerPoseLike | undefined;
  createAnchor?: (pose: XRRigidTransformLike, space: XRReferenceSpaceLike) => Promise<XRAnchorLike>;
  getPose: (space: XRReferenceSpaceLike, baseSpace: XRReferenceSpaceLike) => { transform: XRRigidTransformLike } | undefined;
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
  enabledFeatures?: string[];
}

interface XRWebGLLayerConstructor {
  new (session: XRSessionLike, gl: WebGL2RenderingContext): unknown;
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

  const [jsErrors, setJsErrors] = useState<string[]>([]);
  useEffect(() => {
    function pushErr(msg: string) {
      setJsErrors((prev) => [...prev.slice(-4), msg]);
    }
    function onError(event: ErrorEvent) {
      pushErr(`JS ERROR: ${event.message} @ ${event.filename?.split('/').pop()}:${event.lineno}`);
    }
    function onRejection(event: PromiseRejectionEvent) {
      const reason = event.reason;
      const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
      pushErr(`UNHANDLED PROMISE: ${msg}`);
    }
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

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

    rafHandleRef.current = session.requestAnimationFrame(onXRFrame);

    if (!refSpace) return;
    const pose = frame.getViewerPose(refSpace);
    if (!pose) return;

    lastPoseRef.current = pose.transform;
    xrPoseEngine.updatePose(frame, refSpace, pose.transform.position, pose.transform.orientation);

    if (xrCameraSource.isReady() && pose.views.length > 0) {
      xrCameraSource.processFrame(pose.views[0]);
    }
  }, []);

  const endSession = useCallback(() => {
    sessionRef.current?.end().catch(() => {});
  }, []);

  const recenter = useCallback(() => {
    xrPoseEngine.recenter();
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
        optionalFeatures: ['dom-overlay', 'local-floor', 'hand-tracking', 'camera-access', 'anchors'],
        domOverlay: { root: overlayRef.current },
      });

      sessionRef.current = session;

      let baseLayer: unknown;
      let glContext: (WebGL2RenderingContext & { makeXRCompatible?: () => Promise<void> }) | null = null;
      try {
        glContext = canvasRef.current.getContext('webgl2', {
          xrCompatible: true,
        }) as (WebGL2RenderingContext & { makeXRCompatible?: () => Promise<void> }) | null;

        if (!glContext) {
          throw new Error('Could not get WebGL2 context from canvas (device/browser may not support WebGL2).');
        }

        if (typeof glContext.makeXRCompatible === 'function') {
          await glContext.makeXRCompatible();
        }

        baseLayer = new XRWebGLLayer(session, glContext);
      } catch (glError) {
        await session.end().catch(() => {});
        sessionRef.current = null;
        const msg = glError instanceof Error ? glError.message : String(glError);
        throw new Error(`WebGL/XRWebGLLayer setup failed: ${msg}`);
      }

      session.updateRenderState({ baseLayer });

      let refSpace: XRReferenceSpaceLike;
      try {
        refSpace = await session.requestReferenceSpace('local');
      } catch {
        refSpace = await session.requestReferenceSpace('local-floor');
      }
      refSpaceRef.current = refSpace;

      xrPoseEngine.start();

      let cameraAccessGranted = false;
      if (Array.isArray(session.enabledFeatures)) {
        cameraAccessGranted = session.enabledFeatures.includes('camera-access');
      } else {
        cameraAccessGranted = true;
      }

      if (cameraAccessGranted && glContext) {
        xrCameraSource.init(session, glContext);
      }

      session.addEventListener('end', () => {
        sessionRef.current = null;
        refSpaceRef.current = null;
        if (rafHandleRef.current !== null) {
          session.cancelAnimationFrame(rafHandleRef.current);
          rafHandleRef.current = null;
        }
        xrPoseEngine.stop();
        xrCameraSource.reset();
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
            <VRHub transparentBg recenterOverride={recenter} />
            <button
              type="button"
              onClick={endSession}
              className="fixed top-4 right-4 z-[9999] rounded-full bg-black/70 px-4 py-2 text-xs font-semibold text-white shadow-lg"
            >
              Exit AR
            </button>

            {jsErrors.length > 0 && (
              <div
                style={{
                  position: 'fixed',
                  top: 16,
                  left: 16,
                  right: 90,
                  zIndex: 999999,
                  background: 'rgba(120,0,0,0.9)',
                  color: '#fff',
                  fontSize: 11,
                  fontFamily: 'monospace',
                  padding: '8px 10px',
                  borderRadius: 8,
                  maxHeight: '40vh',
                  overflowY: 'auto',
                }}
              >
                <div style={{ fontWeight: 'bold', marginBottom: 4 }}>JS ERRORS:</div>
                {jsErrors.map((e, i) => (
                  <div key={i} style={{ marginBottom: 4, wordBreak: 'break-word' }}>
                    {e}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

export default XRHub;
