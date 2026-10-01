import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import HandTracker from '@/HandTracker';
import { DwellProvider, useDwellEngine } from './dwell-engine';
import { HomeScreen } from './HomeScreen';
import { AppWindow } from './AppWindow';
import { OrientationGate } from './OrientationGate';
import { ScrollDragIndicator } from './ScrollDragIndicator';
import { SpatialAnchor } from './SpatialAnchor';
import { spatialTrackingEngine } from './spatial-tracking-engine';
import { getApp, getWindowPreset, type AppDef } from './apps';
import { xrPoseEngine, type WorldLockedTransform } from './xr-pose-engine';
import { SpatialCompass } from './SpatialCompass';
// NAYA: Accessibility full-screen takeover ke liye shared signal.
// VRHubInner isse subscribe karta hai taaki:
//   1. "exit" voice command sunte hi AccessibilityApp panel ko close
//      kar sake (yahi handleClose() jo X button use karta hai).
//   2. jab AccessibilityApp full-screen mode mein jaaye (Start button
//      dabane ke baad), normal world-locked panel UI (home screen,
//      baaki panels, recenter button) hide ho jaaye, taaki
//      AccessibilityApp poori screen le sake. WebXR session khud kabhi
//      pause/exit NAHI hoti — sirf ye visual panel chrome hide hota
//      hai.
import { accessibilityMode } from './accessibility-mode';

type OpenAppState = {
  app: AppDef;
  originRect: DOMRect | null;
  closing: boolean;
  side: 'left' | 'right';
};

const HOME_PRESET_STYLE: CSSProperties = {
  width: '92vw',
  height: '90vh',
  maxWidth: '96vw',
  maxHeight: '94vh',
};

function presetToStyle(app: AppDef): CSSProperties {
  const preset = getWindowPreset(app);
  return {
    width: `${preset.width}vw`,
    height: `${preset.height}vh`,
  };
}

function VRHubInner({
  transparentBg = false,
  recenterOverride,
  disableHandTracker = false,
}: {
  transparentBg?: boolean;
  recenterOverride?: () => void;
  disableHandTracker?: boolean;
}) {
  const { reportMarkers, registerScrollTarget } = useDwellEngine();
  const [openPanels, setOpenPanels] = useState<OpenAppState[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const rowRef = useRef<HTMLDivElement>(null);
  const homeSlotRef = useRef<HTMLDivElement>(null);

  // World Lock State
  const [xrPose, setXrPose] = useState<WorldLockedTransform | null>(null);

  // NAYA: Accessibility full-screen state — jab true ho, normal panel
  // UI hide karte hain (AccessibilityApp khud fixed full-screen
  // overlay render karta hai apne andar).
  const [accessibilityFullScreen, setAccessibilityFullScreen] = useState(false);

  useEffect(() => {
    if (xrPoseEngine.isActive()) {
      return xrPoseEngine.subscribe(setXrPose);
    }
  }, []);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    return registerScrollTarget(el);
  }, [registerScrollTarget]);

  useEffect(() => {
    homeSlotRef.current?.scrollIntoView({ behavior: 'auto', inline: 'center', block: 'nearest' });
  }, [openPanels.length]);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current);
    noticeTimeoutRef.current = setTimeout(() => setNotice(null), 2200);
  }, []);

  const panelRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const handleOpenApp = useCallback((app: AppDef, originRect: DOMRect | null) => {
    setOpenPanels((prev) => {
      if (prev.some((p) => p.app.id === app.id)) return prev;
      const leftCount = prev.filter((p) => p.side === 'left').length;
      const rightCount = prev.filter((p) => p.side === 'right').length;
      const side: 'left' | 'right' = leftCount <= rightCount ? 'left' : 'right';
      return [...prev, { app, originRect, closing: false, side }];
    });
    requestAnimationFrame(() => {
      panelRefs.current.get(app.id)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    });
  }, []);

  const handleClose = useCallback((appId: string) => {
    setOpenPanels((prev) => prev.map((p) => (p.app.id === appId ? { ...p, closing: true } : p)));
    const existing = closeTimeoutsRef.current.get(appId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      setOpenPanels((prev) => prev.filter((p) => p.app.id !== appId));
      closeTimeoutsRef.current.delete(appId);
    }, 260);
    closeTimeoutsRef.current.set(appId, t);
  }, []);

  const handleHome = useCallback(() => {
    if (openPanels.length > 0) handleClose(openPanels[0].app.id);
  }, [openPanels, handleClose]);

  // NAYA: Accessibility ka voice "exit" command sunte hi is subscriber
  // se handleClose('accessibility') call hota hai — same jaisa panel
  // ka apna X button karta hai. Full-screen state bhi yahin track
  // karte hain taaki normal panel UI hide/show ho sake.
  useEffect(() => {
    const unsubExit = accessibilityMode.onExitRequested(() => {
      handleClose('accessibility');
    });
    const unsubFullScreen = accessibilityMode.onFullScreenChange((fullScreen) => {
      setAccessibilityFullScreen(fullScreen);
    });
    return () => {
      unsubExit();
      unsubFullScreen();
    };
  }, [handleClose]);

  const isAR = xrPose !== null && xrPose.cameraMatrix3d !== 'none';

  const compassPanel = openPanels.find((p) => p.app.id === 'compass');
  const accessibilityPanel = openPanels.find((p) => p.app.id === 'accessibility');
  // FIX: 'accessibility' ko bhi yahan se exclude kiya — pehle ye
  // normal row (worldLockedPanels) mein bhi render ho raha tha AUR
  // apne alag dedicated block mein bhi (neeche), isliye do panels ek
  // saath dikh rahe the aur overlapping z-index/pointer-events ki
  // wajah se Start button click nahi ho raha tha.
  const worldLockedPanels = openPanels.filter((p) => p.app.id !== 'compass' && p.app.id !== 'accessibility');

  if (!isAR) {
    return (
      <OrientationGate>
        <div className={`fixed inset-0 overflow-hidden ${transparentBg ? 'bg-transparent' : 'bg-black'}`}>
          {!disableHandTracker && <HandTracker onPinchMarkers={reportMarkers} />}
          <div className="flex h-full w-full items-center justify-center text-sm text-white/50">
            Waiting for AR tracking...
          </div>
        </div>
      </OrientationGate>
    );
  }

  return (
    <OrientationGate>
      <div className={`fixed inset-0 overflow-hidden ${transparentBg ? 'bg-transparent' : 'bg-black'}`}>
        {!disableHandTracker && <HandTracker onPinchMarkers={reportMarkers} />}

        {/* NAYA: jab Accessibility full-screen mode mein hai, poora
            normal world-locked panel UI (home screen, baaki panels,
            recenter button) hide karte hain — AccessibilityApp khud
            apna fixed full-screen overlay render kar raha hoga (uske
            apne component ke andar, z-index 999999 pe). WebXR session
            yahan bhi pause nahi ho rahi, sirf ye chrome hide ho raha
            hai. */}
        {/* FIX: realWorld feature hata diya — sirf accessibilityFullScreen
            check karte hain. Jab Accessibility "Start" dabta hai, ye
            poora world-locked panel-rendering block (jo har frame CSS
            matrix3d transforms calculate/apply karta hai — yahi asli
            "processing" hai jo Accessibility ke Start hote hi band
            karni thi) completely hide ho jaata hai. WebXR SESSION khud
            (camera source, pose tracking) chalti rehti hai — sirf iska
            visual panel-transform rendering yahan skip hota hai, jisse
            poora CPU/GPU coco-ssd + MediaPipe ko available ho jaata
            hai. */}
        <div className={accessibilityFullScreen ? 'hidden' : 'contents'}>
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 30,
              perspective: '1000px',
              transformStyle: 'preserve-3d',
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                position: 'absolute', inset: 0,
                transformStyle: 'preserve-3d',
                transform: xrPose.cameraMatrix3d,
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: '50%', top: '50%',
                  transformStyle: 'preserve-3d',
                  transform: xrPose.sceneMatrix3d,
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    width: '100vw', height: '100vh',
                    transformStyle: 'preserve-3d',
                    transform: 'translate(-50%, -50%) translateZ(-40px)',
                    pointerEvents: 'auto',
                  }}
                >
                  <div
                    ref={rowRef}
                    className="relative flex w-full h-full items-center justify-center gap-6 px-[4vw] pb-24"
                  >
                    {worldLockedPanels.filter((p) => p.side === 'left').map((panel) => (
                      <div key={panel.app.id} className="shrink-0" style={{ ...presetToStyle(panel.app), scrollSnapAlign: 'center' }}>
                        <SpatialAnchor parallaxAmount={getWindowPreset(panel.app).parallaxAmount}>
                          <AppWindow app={panel.app} originRect={panel.originRect} closing={panel.closing} onClose={() => handleClose(panel.app.id)} />
                        </SpatialAnchor>
                      </div>
                    ))}

                    <div ref={homeSlotRef} className="shrink-0" style={{ ...HOME_PRESET_STYLE, scrollSnapAlign: 'center' }}>
                      <SpatialAnchor>
                        <HomeScreen onOpenApp={(app, rect) => handleOpenApp(app, rect)} />
                      </SpatialAnchor>
                    </div>

                    {worldLockedPanels.filter((p) => p.side === 'right').map((panel) => (
                      <div key={panel.app.id} className="shrink-0" style={{ ...presetToStyle(panel.app), scrollSnapAlign: 'center' }}>
                        <SpatialAnchor parallaxAmount={getWindowPreset(panel.app).parallaxAmount}>
                          <AppWindow app={panel.app} originRect={panel.originRect} closing={panel.closing} onClose={() => handleClose(panel.app.id)} />
                        </SpatialAnchor>
                      </div>
                    ))}
                  </div>

                  {notice && (
                    <div className="top-6 left-1/2 -translate-x-1/2 rounded-full bg-neutral-900/95 px-5 py-2.5 text-sm font-medium text-white shadow-xl shadow-black/50 absolute">
                      {notice}
                    </div>
                  )}

                  <ScrollDragIndicator />
                </div>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => (recenterOverride ? recenterOverride() : xrPoseEngine.recenter())}
            className="fixed bottom-24 right-4 z-50 rounded-full border border-white/20 bg-neutral-900/85 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-black/50"
          >
            Recenter
          </button>
        </div>

        {/* FIX: pehle ye do ALAG JSX blocks the (ek !accessibilityFullScreen
            ke liye, ek accessibilityFullScreen ke liye — even as a
            ternary, React treats <AppWindow> nested inside different
            wrapper-chains as different tree positions and remounts it).
            AppWindow ko turant unmount+remount kar deta tha jab
            accessibilityFullScreen badalta tha, jisse AccessibilityApp
            ka 'started' state turant wapas false ho jaata tha (yahi
            wajah thi ki Start dabane ke turant baad sab reset ho jaata
            tha).
            Ab wrapper hierarchy HAMESHA SAME rehti hai — AppWindow
            hamesha EXACT same nesting/position mein render hota hai,
            sirf uske around ke transform-wrapper divs ke INLINE STYLES
            conditionally badalte hain (transform/position ko 'none'/
            static kar dete hain full-screen mode mein). Isse
            AppWindow/AccessibilityApp component instance kabhi
            remount nahi hota, uska internal state (started, wagaira)
            barkarar rehta hai. */}
        {accessibilityPanel && (
          <div
            style={
              accessibilityFullScreen
                ? { position: 'fixed', inset: 0, zIndex: 999999 }
                : {
                    position: 'fixed', inset: 0, zIndex: 30,
                    perspective: '1000px',
                    transformStyle: 'preserve-3d',
                    pointerEvents: 'none',
                  }
            }
          >
            <div
              style={
                accessibilityFullScreen
                  ? {}
                  : {
                      position: 'absolute', inset: 0,
                      transformStyle: 'preserve-3d',
                      transform: xrPose.cameraMatrix3d,
                    }
              }
            >
              <div
                style={
                  accessibilityFullScreen
                    ? {}
                    : {
                        position: 'absolute',
                        left: '50%', top: '50%',
                        transformStyle: 'preserve-3d',
                        transform: xrPose.sceneMatrix3d,
                      }
                }
              >
                <div
                  style={
                    accessibilityFullScreen
                      ? { position: 'fixed', inset: 0, pointerEvents: 'auto' }
                      : {
                          position: 'absolute',
                          transform: 'translate(-50%, -50%) translateZ(-40px)',
                          pointerEvents: 'auto',
                          ...presetToStyle(accessibilityPanel.app),
                        }
                  }
                >
                  <SpatialAnchor
                    parallaxAmount={accessibilityFullScreen ? 0 : getWindowPreset(accessibilityPanel.app).parallaxAmount}
                  >
                    <AppWindow
                      app={accessibilityPanel.app}
                      originRect={accessibilityPanel.originRect}
                      closing={accessibilityPanel.closing}
                      onClose={() => handleClose('accessibility')}
                    />
                  </SpatialAnchor>
                </div>
              </div>
            </div>
          </div>
        )}

        {compassPanel && (
          <SpatialCompass onClose={() => handleClose('compass')} />
        )}

        {/* TEMP DEBUG: on-screen badge showing VRHubInner's own view
            of accessibilityFullScreen state, to confirm whether the
            accessibility-mode.ts subscription is actually firing here.
            Safe to remove once confirmed working. */}
        {accessibilityPanel && (
          <div className="fixed left-4 bottom-4 z-[999999] rounded bg-black/80 px-2 py-1 text-[10px] text-yellow-300">
            debug(VRHubInner): accessibilityFullScreen={String(accessibilityFullScreen)}
          </div>
        )}
      </div>
    </OrientationGate>
  );
}

export default function VRHub({
  transparentBg = false,
  recenterOverride,
  disableHandTracker = false,
}: {
  transparentBg?: boolean;
  recenterOverride?: () => void;
  disableHandTracker?: boolean;
}) {
  return (
    <DwellProvider>
      <VRHubInner transparentBg={transparentBg} recenterOverride={recenterOverride} disableHandTracker={disableHandTracker} />
    </DwellProvider>
  );
}

export { getApp };
