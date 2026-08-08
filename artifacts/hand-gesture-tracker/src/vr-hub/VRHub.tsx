import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import HandTracker from '@/HandTracker';
import { DwellProvider, useDwellEngine } from './dwell-engine';
import { HomeScreen } from './HomeScreen';
import { AppWindow } from './AppWindow';
import { OrientationGate } from './OrientationGate';
import { ScrollDragIndicator } from './ScrollDragIndicator';
import { RealWorldToggle } from './RealWorldToggle';
import { SpatialAnchor } from './SpatialAnchor';
import { spatialTrackingEngine } from './spatial-tracking-engine';
import { getApp, getWindowPreset, type AppDef } from './apps';
import { xrPoseEngine, type WorldLockedTransform } from './xr-pose-engine';

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
    minWidth: `${preset.minWidth}vw`,
    minHeight: `${preset.minHeight}vh`,
    maxWidth: `none`,
    maxHeight: `none`,
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
  const [realWorld, setRealWorld] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const homeSlotRef = useRef<HTMLDivElement>(null);

  // World Lock State
  const [xrPose, setXrPose] = useState<WorldLockedTransform | null>(null);

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

  const isAR = xrPose !== null && xrPose.cameraMatrix3d !== 'none';

  return (
    <OrientationGate>
      <div className={`fixed inset-0 overflow-hidden ${transparentBg ? 'bg-transparent' : 'bg-black'}`}>
        {!disableHandTracker && <HandTracker onPinchMarkers={reportMarkers} />}

        <div className={realWorld ? 'hidden' : 'contents'}>
          
          {/* ==================================================== */}
          {/* TRUE 3D WORLD LOCK AR ARCHITECTURE                   */}
          {/* ==================================================== */}
          <div
            style={isAR ? {
              position: 'fixed', inset: 0, zIndex: 30,
              perspective: '1000px', // Match 1 Meter = 1000px scale
              transformStyle: 'preserve-3d',
              pointerEvents: 'none',
            } : { display: 'contents' }}
          >
            {/* 1. The Camera (Moves backward opposite to your head) */}
            <div
              style={isAR ? {
                position: 'absolute', inset: 0,
                transformStyle: 'preserve-3d',
                transform: xrPose.cameraMatrix3d,
              } : { display: 'contents' }}
            >
              {/* 2. The Anchor Scene (Locked exactly where you started looking) */}
              <div
                style={isAR ? {
                  position: 'absolute',
                  left: '50%', top: '50%',
                  transformStyle: 'preserve-3d',
                  transform: xrPose.sceneMatrix3d,
                } : { display: 'contents' }}
              >
                {/* 3. The Physical UI Wrapper */}
                <div
                  style={isAR ? {
                    position: 'absolute',
                    width: '100vw', height: '100vh',
                    transformStyle: 'preserve-3d',
                    transform: 'translate(-50%, -50%) translateZ(-500px)',
                    pointerEvents: 'auto',
                  } : { display: 'contents' }}
                >
                  
                  {/* REAL UI STARTS HERE */}
                  {/* FIX (panel not visible without manual scroll): AR
                      mode ab horizontally scrollable row use nahi karta.
                      Panels ek fixed, non-scrolling row mein render hote
                      hain jo humesha Home ke turant bagal mein (left ya
                      right) dikhta hai — scroll karke dhundhne ki zaroorat
                      nahi. overflow-x-auto/scroll-snap AR mode mein hata
                      diya; non-AR mode bilkul waisa hi scrollable rehta
                      hai jaisa pehle tha. */}
                  <div
                    ref={rowRef}
                    className={
                      isAR
                        ? 'relative flex w-full h-full items-center justify-center gap-6 px-[4vw] pb-24'
                        : 'fixed inset-0 z-30 flex items-center gap-6 overflow-x-auto px-[10vw] pb-24'
                    }
                    style={isAR ? undefined : { scrollSnapType: 'x proximity' }}
                  >
                    {openPanels.filter((p) => p.side === 'left').map((panel) => (
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

                    {openPanels.filter((p) => p.side === 'right').map((panel) => (
                      <div key={panel.app.id} className="shrink-0" style={{ ...presetToStyle(panel.app), scrollSnapAlign: 'center' }}>
                        <SpatialAnchor parallaxAmount={getWindowPreset(panel.app).parallaxAmount}>
                          <AppWindow app={panel.app} originRect={panel.originRect} closing={panel.closing} onClose={() => handleClose(panel.app.id)} />
                        </SpatialAnchor>
                      </div>
                    ))}
                  </div>

                  {notice && (
                    <div className={`top-6 left-1/2 -translate-x-1/2 rounded-full bg-neutral-900/95 px-5 py-2.5 text-sm font-medium text-white shadow-xl shadow-black/50 ${isAR ? 'absolute' : 'fixed z-50'}`}>
                      {notice}
                    </div>
                  )}

                  <ScrollDragIndicator />
                  
                </div>
              </div>
            </div>
          </div>
          {/* ==================================================== */}

          <button
            type="button"
            onClick={() => (recenterOverride ? recenterOverride() : xrPoseEngine.recenter())}
            className="fixed bottom-24 right-4 z-50 rounded-full border border-white/20 bg-neutral-900/85 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-black/50"
          >
            Recenter
          </button>
        </div>

        <RealWorldToggle realWorld={realWorld} onToggle={() => setRealWorld((v) => !v)} />
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
