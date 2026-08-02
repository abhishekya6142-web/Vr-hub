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
  enabledFeatures?: string[];
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
  const [handTrackingSupported, setHandTrackingSupported] = useState<boolean | null>(null);
  const [cameraAccessSupported, setCameraAccessSupported] = useState<boolean | null>(null);
  const [cameraDebug, setCameraDebug] = useState<any>(null);
  const [handTrackerDebug, setHandTrackerDebug] = useState<any>(null);
  const [poseDebug, setPoseDebug] = useState<ReturnType<typeof xrPoseEngine.getDebugState> | null>(null);

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

  useEffect(() => {
    if (!sessionActive) return;
    const id = setInterval(() => {
      setCameraDebug(xrCameraSource.getDebugState());
      setHandTrackerDebug((window as any).__handTrackerDebug ?? null);
      setPoseDebug(xrPoseEngine.getDebugState());
    }, 300);
    return () => clearInterval(id);
  }, [sessionActive]);

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
    xrPoseEngine.updatePose(pose.transform.position, pose.transform.orientation);

    if (xrCameraSource.isReady() && pose.views.length > 0) {
      xrCameraSource.updateFromView(pose.views[0]);
    }
  }, []);

  const endSession = useCallback(() => {
    sessionRef.current?.end().catch(() => {});
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
        optionalFeatures: ['dom-overlay', 'local-floor', 'hand-tracking', 'camera-access'],
        domOverlay: { root: overlayRef.current },
      });

      sessionRef.current = session;

      let baseLayer: unknown;
      let glContext: (WebGLRenderingContext & { makeXRCompatible?: () => Promise<void> }) | null = null;
      try {
        glContext = canvasRef.current.getContext('webgl', {
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
        await session.end().catch(() => {});
        sessionRef.current = null;
        const msg = glError instanceof Error ? glError.message : String(glError);
        throw new Error(`WebGL/XRWebGLLayer setup failed: ${msg}`);
      }

      session.updateRenderState({ baseLayer });

      let refSpace: XRReferenceSpaceLike;
      try {
        refSpace = await session.requestReferenceSpace('local-floor');
      } catch {
        refSpace = await session.requestReferenceSpace('local');
      }
      refSpaceRef.current = refSpace;

      xrPoseEngine.start();

      let cameraAccessGranted = false;
      if (Array.isArray(session.enabledFeatures)) {
        setHandTrackingSupported(session.enabledFeatures.includes('hand-tracking'));
        cameraAccessGranted = session.enabledFeatures.includes('camera-access');
        setCameraAccessSupported(cameraAccessGranted);
      } else {
        setHandTrackingSupported(null);
        setCameraAccessSupported(null);
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

            <div
              style={{
                position: 'fixed',
                bottom: 16,
                left: 16,
                zIndex: 9999,
                background: 'rgba(0,0,0,0.85)',
                fontSize: 11,
                fontWeight: 'bold',
                padding: '8px 12px',
                borderRadius: 8,
                maxWidth: '80vw',
                maxHeight: '55vh',
                overflowY: 'auto',
              }}
            >
              <div style={{ color: handTrackingSupported ? '#4ade80' : '#f87171' }}>
                hand-tracking: {handTrackingSupported === null ? 'unknown' : handTrackingSupported ? 'SUPPORTED' : 'NOT supported'}
              </div>
              <div style={{ color: cameraAccessSupported ? '#4ade80' : '#f87171' }}>
                camera-access: {cameraAccessSupported === null ? 'unknown' : cameraAccessSupported ? 'SUPPORTED' : 'NOT supported'}
              </div>

              {poseDebug && (
                <div style={{ marginTop: 6, borderTop: '1px solid rgba(255,255,255,0.2)', paddingTop: 6 }}>
                  <div style={{ color: poseDebug.hasAnchor ? '#4ade80' : '#f87171' }}>
                    anchor set: {String(poseDebug.hasAnchor)}
                  </div>
                  <div>updates: {poseDebug.updateCount}</div>
                  <div>dx: {(poseDebug.dxMeters * 100).toFixed(1)} cm</div>
                  <div>dy: {(poseDebug.dyMeters * 100).toFixed(1)} cm</div>
                  <div>dz: {(poseDebug.dzMeters * 100).toFixed(1)} cm</div>

                  {/* NAYA: granular raw-field debug */}
                  <div style={{ marginTop: 6, borderTop: '1px dashed rgba(255,255,255,0.3)', paddingTop: 6, color: '#93c5fd' }}>
                    <div>--- RAW (current frame) ---</div>
                    <div>raw.x = {poseDebug.debugRawX} (typeof: {poseDebug.debugRawXType})</div>
                    <div>raw.y = {poseDebug.debugRawY} (typeof: {poseDebug.debugRawYType})</div>
                    <div>raw.z = {poseDebug.debugRawZ} (typeof: {poseDebug.debugRawZType})</div>
                  </div>
                  <div style={{ marginTop: 6, borderTop: '1px dashed rgba(255,255,255,0.3)', paddingTop: 6, color: '#fca5a5' }}>
                    <div>--- ANCHOR (captured once) ---</div>
                    <div>anchor.x = {poseDebug.debugAnchorX} (typeof: {poseDebug.debugAnchorXType})</div>
                    <div>anchor.y = {poseDebug.debugAnchorY} (typeof: {poseDebug.debugAnchorYType})</div>
                    <div>anchor.z = {poseDebug.debugAnchorZ} (typeof: {poseDebug.debugAnchorZType})</div>
                  </div>
                </div>
              )}

              {cameraDebug && (
                <div style={{ marginTop: 6, borderTop: '1px solid rgba(255,255,255,0.2)', paddingTop: 6 }}>
                  <div style={{ color: cameraDebug.ready ? '#4ade80' : '#f87171' }}>pipeline ready: {String(cameraDebug.ready)}</div>
                  <div style={{ color: cameraDebug.lastCameraSeen ? '#4ade80' : '#f87171' }}>view.camera seen: {String(cameraDebug.lastCameraSeen)}</div>
                  <div style={{ color: cameraDebug.lastTextureOk ? '#4ade80' : '#f87171' }}>getCameraImage ok: {String(cameraDebug.lastTextureOk)}</div>
                  <div>frames: {cameraDebug.frameCount}</div>
                  {cameraDebug.lastError && <div style={{ color: '#f87171' }}>err: {cameraDebug.lastError}</div>}
                </div>
              )}
              {handTrackerDebug && (
                <div style={{ marginTop: 6, borderTop: '1px solid rgba(255,255,255,0.2)', paddingTop: 6 }}>
                  <div>branch: {handTrackerDebug.branch}</div>
                  <div>xr canvas: {String(handTrackerDebug.xrCanvasExists)} ({handTrackerDebug.xrCanvasSize})</div>
                  <div>send attempts: {handTrackerDebug.sendAttempts ?? 0}</div>
                  <div>onResults fired: {handTrackerDebug.resultsReceived}</div>
                  <div style={{ color: handTrackerDebug.lastHandsCount > 0 ? '#4ade80' : '#f87171' }}>
                    hands detected: {handTrackerDebug.lastHandsCount}
                  </div>
                </div>
              )}
            </div>

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
      
