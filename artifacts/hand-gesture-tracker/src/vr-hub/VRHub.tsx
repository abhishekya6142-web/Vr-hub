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
import { SpatialCompass } from './SpatialCompass';
import { accessibilityMode } from '../accessibility-mode';
import { theatreState } from './theatre-state';

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
  const [realWorld, setRealWorld] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const homeSlotRef = useRef<HTMLDivElement>(null);

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

  // NAYA: Chrome/Android WebXR ka platform behavior hai ki file-picker
  // khulte hi AR session end() ho jaata hai, jisse ye poora VRHub
  // component unmount hota hai — Theatre.tsx ka apna React state
  // (openPanels ke andar) automatically kho jaata. theatreState
  // singleton (VRHub ke bahar) video URL ko bacha ke rakhta hai; yahan
  // mount hote hi check karte hain ki koi pending video hai kya, agar
  // haan to Theatre panel khud-ba-khud reopen kar dete hain — user ko
  // dobara navigate/select nahi karna padta, sirf "Enter AR" dabana
  // padta hai.
  useEffect(() => {
    if (theatreState.hasVideo() && !openPanels.some((p) => p.app.id === 'theatre')) {
      handleOpenApp(getApp('theatre'), null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const handlePinchMarkers = useCallback(
    (markers: { x: number; y: number }[]) => {
      reportMarkers(markers);
      accessibilityMode.reportPinchState(markers.length > 0);
    },
    [reportMarkers],
  );

  const isAR = xrPose !== null && xrPose.cameraMatrix3d !== 'none';

  const compassPanel = openPanels.find((p) => p.app.id === 'compass');
  const worldLockedPanels = openPanels.filter((p) => p.app.id !== 'compass');

  if (!isAR) {
    return (
      <OrientationGate>
        <div className={`fixed inset-0 overflow-hidden ${transparentBg ? 'bg-transparent' : 'bg-black'}`}>
          {!disableHandTracker && <HandTracker onPinchMarkers={handlePinchMarkers} />}
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
        {!disableHandTracker && <HandTracker onPinchMarkers={handlePinchMarkers} />}

        <div className={realWorld ? 'hidden' : 'contents'}>
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

        <RealWorldToggle realWorld={realWorld} onToggle={() => setRealWorld((v) => !v)} />

        {compassPanel && (
          <SpatialCompass onClose={() => handleClose('compass')} />
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
