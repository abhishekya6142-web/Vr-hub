import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import HandTracker from '@/HandTracker';
import { DwellProvider, useDwellEngine } from './dwell-engine';
import { HomeScreen } from './HomeScreen';
import { Dock } from './Dock';
import { AppWindow } from './AppWindow';
import { OrientationGate } from './OrientationGate';
import { ScrollDragIndicator } from './ScrollDragIndicator';
import { RealWorldToggle } from './RealWorldToggle';
import { SpatialAnchor } from './SpatialAnchor';
import { spatialTrackingEngine } from './spatial-tracking-engine';
import { getApp, getWindowPreset, type AppDef } from './apps';

type OpenAppState = {
  app: AppDef;
  originRect: DOMRect | null;
  closing: boolean;
  side: 'left' | 'right';
};

// Home ka apna "largest" preset — Home apps.ts me nahi hai (wo ek app nahi,
// launcher ki base screen hai), isliye iska preset yahin define hai. Baaki
// sab apps apna preset khud apps.ts se laate hain (getWindowPreset).
const HOME_PRESET_STYLE: CSSProperties = {
  width: '92vw',
  height: '90vh',
  maxWidth: '96vw',
  maxHeight: '94vh',
};

// Preset (vw/vh numbers) ko actual CSSProperties me convert karta hai. Panel
// size ab per-app alag hoti hai — koi ek global fixed size nahi.
function presetToStyle(app: AppDef): CSSProperties {
  const preset = getWindowPreset(app);
  return {
    width: `${preset.width}vw`,
    height: `${preset.height}vh`,
    minWidth: `${preset.minWidth}vw`,
    minHeight: `${preset.minHeight}vh`,
    maxWidth: `${preset.maxWidth}vw`,
    maxHeight: `${preset.maxHeight}vh`,
  };
}

function VRHubInner() {
  const { reportMarkers, registerScrollTarget } = useDwellEngine();
  const [openPanels, setOpenPanels] = useState<OpenAppState[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [realWorld, setRealWorld] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const homeSlotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    return registerScrollTarget(el);
  }, [registerScrollTarget]);

  // Keeps the Home panel centered in view whenever the row's contents
  // change (panels opening/closing shift what's around it), so Home never
  // visually drifts toward an edge — it stays the fixed "home base" of the
  // desk, with app panels floating to either side of it.
  useEffect(() => {
    homeSlotRef.current?.scrollIntoView({
      behavior: 'auto',
      inline: 'center',
      block: 'nearest',
    });
  }, [openPanels.length]);

  useEffect(() => {
    return () => {
      if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current);
      closeTimeoutsRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current);
    noticeTimeoutRef.current = setTimeout(() => setNotice(null), 2200);
  }, []);

  const panelRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const handleOpenApp = useCallback(
    (app: AppDef, originRect: DOMRect | null) => {
      setOpenPanels((prev) => {
        if (prev.some((p) => p.app.id === app.id)) return prev;
        // Auto-balance — jis side (Home ke left ya right) abhi kam panels
        // hain, naya panel usi taraf jaata hai. Home hamesha center me
        // rehta hai (scrollIntoView), panels uske dono taraf spread hote
        // hain instead of hamesha ek hi side pe stack hone ke.
        const leftCount = prev.filter((p) => p.side === 'left').length;
        const rightCount = prev.filter((p) => p.side === 'right').length;
        const side: 'left' | 'right' = leftCount <= rightCount ? 'left' : 'right';
        return [...prev, { app, originRect, closing: false, side }];
      });
      // Naya panel jab khule to usko turant view me le aao — sirf Home ko
      // center karna kaafi nahi tha kyunki left-side panels row ke shuru
      // me render hote hain aur px-[10vw] padding ke bawajood screen ke
      // bahar chale jaate the.
      requestAnimationFrame(() => {
        panelRefs.current.get(app.id)?.scrollIntoView({
          behavior: 'smooth',
          inline: 'center',
          block: 'nearest',
        });
      });
    },
    [],
  );

  const handleClose = useCallback((appId: string) => {
    setOpenPanels((prev) =>
      prev.map((p) => (p.app.id === appId ? { ...p, closing: true } : p)),
    );
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

  return (
    <OrientationGate>
      <div className="fixed inset-0 overflow-hidden bg-black">
        <HandTracker onPinchMarkers={reportMarkers} />

        <div className={realWorld ? 'hidden' : 'contents'}>
          {/* Fixed-size floating monitors in a horizontally scrollable
              row. Home is always kept centered on screen (see the
              scrollIntoView effect above) and never resizes when more app
              panels open — new panels are added to the row, not squeezed
              into shared space. Each panel gets its own independent
              SpatialAnchor (backed by the shared tracking engine), so it
              floats/tilts on its own as the device moves, rather than the
              whole row moving together. Each app's panel now uses its own
              size preset from apps.ts instead of one global size. */}
          <div
            ref={rowRef}
            className="fixed inset-0 z-30 flex items-center gap-6 overflow-x-auto px-[10vw] pb-24"
            style={{ scrollSnapType: 'x proximity' }}
          >
            {openPanels
              .filter((p) => p.side === 'left')
              .map((panel) => (
                <div
                  key={panel.app.id}
                  className="shrink-0"
                  style={{ ...presetToStyle(panel.app), scrollSnapAlign: 'center' }}
                >
                  <SpatialAnchor parallaxAmount={getWindowPreset(panel.app).parallaxAmount}>
                    <AppWindow
                      app={panel.app}
                      originRect={panel.originRect}
                      closing={panel.closing}
                      onClose={() => handleClose(panel.app.id)}
                    />
                  </SpatialAnchor>
                </div>
              ))}

            <div
              ref={homeSlotRef}
              className="shrink-0"
              style={{ ...HOME_PRESET_STYLE, scrollSnapAlign: 'center' }}
            >
              <SpatialAnchor>
                <HomeScreen onOpenApp={(app, rect) => handleOpenApp(app, rect)} />
              </SpatialAnchor>
            </div>

            {openPanels
              .filter((p) => p.side === 'right')
              .map((panel) => (
                <div
                  key={panel.app.id}
                  className="shrink-0"
                  style={{ ...presetToStyle(panel.app), scrollSnapAlign: 'center' }}
                >
                  <SpatialAnchor parallaxAmount={getWindowPreset(panel.app).parallaxAmount}>
                    <AppWindow
                      app={panel.app}
                      originRect={panel.originRect}
                      closing={panel.closing}
                      onClose={() => handleClose(panel.app.id)}
                    />
                  </SpatialAnchor>
                </div>
              ))}
          </div>

          {notice && (
            <div className="fixed top-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-neutral-900/95 px-5 py-2.5 text-sm font-medium text-white shadow-xl shadow-black/50">
              {notice}
            </div>
          )}

          <Dock openApp={openPanels[0]?.app ?? null} onHome={handleHome} />
          <ScrollDragIndicator />

          {/* Recenter ab yahan ek hi jagah hai (pehle har SpatialAnchor
              apna alag button render karta tha). Seedha shared engine ko
              call karta hai — sab panels turant recenter ho jate hain. */}
          <button
            type="button"
            onClick={() => spatialTrackingEngine.recenter()}
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

export default function VRHub() {
  return (
    <DwellProvider>
      <VRHubInner />
    </DwellProvider>
  );
}

export { getApp };
