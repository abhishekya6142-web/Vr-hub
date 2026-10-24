import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
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
// Accessibility full-screen takeover ke liye shared signal.
// VRHubInner isse subscribe karta hai taaki:
//   1. "exit" voice command sunte hi AccessibilityApp panel close ho sake.
//   2. AccessibilityApp full-screen mode mein jaaye to normal world-locked
//      panel UI (home screen, baaki panels, recenter button) hide ho jaaye.
//      WebXR session khud kabhi pause/exit NAHI hoti.
import { accessibilityMode } from './accessibility-mode';

// OPTIMIZATION (is version mein): pehle har XR frame (30-60/sec) par
// xrPoseEngine ka pose React state (setXrPose) mein jaata tha, jisse poora
// VRHubInner — HomeScreen, har AppWindow, SpatialAnchor, sab — har frame
// dobara render hota tha, sirf ek CSS matrix3d string badalne ke liye.
// Ye main thread ka bahut bada hissa kha leta tha (MediaPipe ke saath
// milkar XR fps 14-18 par). Ab pose seedha DOM elements ke style.transform
// par likha jaata hai (React ko bypass karke). React sirf tab re-render
// hota hai jab "AR chalu / band" (isAR) badalta hai.

type OpenAppState = {
  app: AppDef;
  originRect: DOMRect | null;
  closing: boolean;
  side: 'left' | 'right';
};

type PoseEls = {
  camMain?: HTMLElement | null;
  sceneMain?: HTMLElement | null;
  camAcc?: HTMLElement | null;
  sceneAcc?: HTMLElement | null;
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

// Debug badge: anchorMode + distance + RAW Y positions. Hatane ke liye
// neeche <AnchorDebugBadge /> wali line hata dena.
function AnchorDebugBadge() {
  const [state, setState] = useState(() => xrPoseEngine.getDebugState());

  useEffect(() => {
    const id = setInterval(() => {
      setState({ ...xrPoseEngine.getDebugState() });
    }, 150);
    return () => clearInterval(id);
  }, []);

  const modeColor =
    state.anchorMode === 'real-anchor'
      ? 'text-green-400'
      : state.anchorMode === 'fallback-static'
        ? 'text-red-400'
        : state.anchorMode === 'pending'
          ? 'text-yellow-300'
          : 'text-white/50';

  return (
    <div className="fixed left-4 bottom-4 z-[999999] rounded bg-black/80 px-2 py-1 text-[10px] leading-relaxed text-white/80 whitespace-nowrap">
      <div>
        anchorMode: <span className={modeColor}>{state.anchorMode}</span>
      </div>
      <div>dist: {state.distanceFromAnchorMeters.toFixed(3)}m</div>
      <div className="text-cyan-300">
        rawCamY: {state.rawPos ? state.rawPos.y.toFixed(4) : '—'}
      </div>
      <div className="text-orange-300">
        rawAnchorY: {state.anchorPos ? state.anchorPos.y.toFixed(4) : '—'}
      </div>
      <div className="text-white/50">dy(cam-anchor): {state.dyMeters.toFixed(4)}</div>
    </div>
  );
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

  // World Lock: pose ab ref + seedha DOM style mein (React state nahi).
  // isAR sirf boolean hai — AR start/stop par hi badalta hai.
  const [isAR, setIsAR] = useState(false);
  const poseRef = useRef<WorldLockedTransform | null>(null);
  const elsRef = useRef<PoseEls>({});

  // Accessibility full-screen state — jab true ho, normal panel UI hide
  // karte hain (AccessibilityApp khud fixed full-screen overlay render karta hai).
  const [accessibilityFullScreen, setAccessibilityFullScreen] = useState(false);
  const accFullRef = useRef(false);

  // Latest pose ko registered elements par likho. Accessibility ke wrappers
  // full-screen mein transform-free rehte hain (accFullRef).
  const applyPose = useCallback(() => {
    const t = poseRef.current;
    if (!t) return;
    const e = elsRef.current;
    if (e.camMain) e.camMain.style.transform = t.cameraMatrix3d;
    if (e.sceneMain) e.sceneMain.style.transform = t.sceneMatrix3d;
    if (!accFullRef.current) {
      if (e.camAcc) e.camAcc.style.transform = t.cameraMatrix3d;
      if (e.sceneAcc) e.sceneAcc.style.transform = t.sceneMatrix3d;
    }
  }, []);

  // Callback refs: element mount hote hi current pose turant laga dete hain.
  const camMainRef = useCallback(
    (el: HTMLDivElement | null) => {
      elsRef.current.camMain = el;
      if (el) applyPose();
    },
    [applyPose],
  );
  const sceneMainRef = useCallback(
    (el: HTMLDivElement | null) => {
      elsRef.current.sceneMain = el;
      if (el) applyPose();
    },
    [applyPose],
  );
  const camAccRef = useCallback(
    (el: HTMLDivElement | null) => {
      elsRef.current.camAcc = el;
      if (el) applyPose();
    },
    [applyPose],
  );
  const sceneAccRef = useCallback(
    (el: HTMLDivElement | null) => {
      elsRef.current.sceneAcc = el;
      if (el) applyPose();
    },
    [applyPose],
  );

  useEffect(() => {
    if (!xrPoseEngine.isActive()) return;
    return xrPoseEngine.subscribe((t: WorldLockedTransform) => {
      poseRef.current = t;
      const ar = t.cameraMatrix3d !== 'none';
      setIsAR((prev) => (prev === ar ? prev : ar));
      applyPose();
    });
  }, [applyPose]);

  // Full-screen mode badalne par accessibility wrappers ka transform
  // clear / dobara lagao (React ab 'transform' style khud nahi chhuta).
  useLayoutEffect(() => {
    accFullRef.current = accessibilityFullScreen;
    const e = elsRef.current;
    if (accessibilityFullScreen) {
      if (e.camAcc) e.camAcc.style.transform = '';
      if (e.sceneAcc) e.sceneAcc.style.transform = '';
    } else {
      applyPose();
    }
  }, [accessibilityFullScreen, applyPose]);

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

  // Accessibility ka voice "exit" command sunte hi handleClose('accessibility')
  // call hota hai — same jaisa panel ka apna X button karta hai. Full-screen
  // state bhi yahin track hoti hai.
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

  const compassPanel = openPanels.find((p) => p.app.id === 'compass');
  const accessibilityPanel = openPanels.find((p) => p.app.id === 'accessibility');
  // FIX: 'accessibility' ko normal row se exclude kiya — pehle ye row mein
  // bhi render hota tha aur apne dedicated block mein bhi (do panels ek
  // saath, Start button click nahi hota tha).
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

        {/* Jab Accessibility full-screen mode mein hai, poora normal
            world-locked panel UI (home screen, baaki panels, recenter
            button) hide hota hai — AccessibilityApp apna fixed full-screen
            overlay khud render karta hai (z-index 999999). WebXR session
            pause nahi hoti, sirf ye chrome hide hota hai, jisse poora
            CPU/GPU coco-ssd + MediaPipe ko available ho jaata hai. */}
        {/* Depth: perspective 2200px aur panel row translateZ(-600px) —
            kam depth par chhoti head rotation bhi screen par bahut warp
            karti thi (tracking bug nahi, perspective warping thi). */}
        <div className={accessibilityFullScreen ? 'hidden' : 'contents'}>
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 30,
              perspective: '2200px',
              transformStyle: 'preserve-3d',
              pointerEvents: 'none',
            }}
          >
            {/* transform yahan React se NAHI aata — camMainRef/sceneMainRef
                ke zariye applyPose() seedha style.transform likhta hai. */}
            <div
              ref={camMainRef}
              style={{
                position: 'absolute', inset: 0,
                transformStyle: 'preserve-3d',
              }}
            >
              <div
                ref={sceneMainRef}
                style={{
                  position: 'absolute',
                  left: '50%', top: '50%',
                  transformStyle: 'preserve-3d',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    width: '100vw', height: '100vh',
                    transformStyle: 'preserve-3d',
                    transform: 'translate(-50%, -50%) translateZ(-600px)',
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

        {/* Accessibility panel: wrapper hierarchy HAMESHA SAME rehti hai
            (sirf inline styles conditionally badalte hain) taaki
            AppWindow/AccessibilityApp kabhi remount na ho aur uska
            internal state ('started' wagaira) barkarar rahe. Transform
            yahan bhi React se nahi, camAccRef/sceneAccRef + applyPose()
            se aata hai (full-screen mein khali rehta hai). */}
        {accessibilityPanel && (
          <div
            style={
              accessibilityFullScreen
                ? { position: 'fixed', inset: 0, zIndex: 999999 }
                : {
                    position: 'fixed', inset: 0, zIndex: 30,
                    perspective: '2200px',
                    transformStyle: 'preserve-3d',
                    pointerEvents: 'none',
                  }
            }
          >
            <div
              ref={camAccRef}
              style={
                accessibilityFullScreen
                  ? {}
                  : {
                      position: 'absolute', inset: 0,
                      transformStyle: 'preserve-3d',
                    }
              }
            >
              <div
                ref={sceneAccRef}
                style={
                  accessibilityFullScreen
                    ? {}
                    : {
                        position: 'absolute',
                        left: '50%', top: '50%',
                        transformStyle: 'preserve-3d',
                      }
                }
              >
                <div
                  style={
                    accessibilityFullScreen
                      ? { position: 'fixed', inset: 0, pointerEvents: 'auto' }
                      : {
                          position: 'absolute',
                          transform: 'translate(-50%, -50%) translateZ(-600px)',
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

        {/* Debug: anchorMode + distance + RAW Y positions badge. Hatane ke
            liye bas ye line hata dena. */}
        <AnchorDebugBadge />
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
    
