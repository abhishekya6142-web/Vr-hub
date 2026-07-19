import { useCallback, useEffect, useRef, useState } from 'react';
import HandTracker from '@/HandTracker';
import { DwellProvider, useDwellEngine } from './dwell-engine';
import { HomeScreen } from './HomeScreen';
import { Dock } from './Dock';
import { AppWindow } from './AppWindow';
import { OrientationGate } from './OrientationGate';
import { ScrollDragIndicator } from './ScrollDragIndicator';
import { RealWorldToggle } from './RealWorldToggle';
import { SpatialAnchor } from './SpatialAnchor';
import { getApp, type AppDef } from './apps';

type OpenAppState = {
  app: AppDef;
  originRect: DOMRect | null;
  closing: boolean;
};

// Home always occupies one fixed slot; up to this many additional app
// panels can be open beside it at once. None of them ever shrink one
// another — each is a fixed-size floating monitor in a horizontally
// scrollable row (pinch-drag or physical swipe to see panels that don't
// fit on screen at once).
const MAX_APP_PANELS = 2;

function VRHubInner() {
  const { reportMarkers, registerScrollTarget } = useDwellEngine();
  const [openPanels, setOpenPanels] = useState<OpenAppState[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [realWorld, setRealWorld] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    return registerScrollTarget(el);
  }, [registerScrollTarget]);

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

  const handleOpenApp = useCallback(
    (app: AppDef, originRect: DOMRect | null) => {
      setOpenPanels((prev) => {
        if (prev.some((p) => p.app.id === app.id)) return prev;
        if (prev.length >= MAX_APP_PANELS) {
          showNotice('Maximum 3 panels open — close one first');
          return prev;
        }
        return [...prev, { app, originRect, closing: false }];
      });
    },
    [showNotice],
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
              row. Home is always first and never resizes when more app
              panels open — new panels are added to the row, not squeezed
              into shared space. Each panel gets its own independent
              SpatialAnchor, so it floats/tilts on its own as the device
              moves, rather than the whole row moving together. */}
          <div
            ref={rowRef}
            className="fixed inset-0 z-30 flex items-center gap-6 overflow-x-auto px-[10vw] pb-24"
            style={{ scrollSnapType: 'x proximity' }}
          >
            <div
              className="h-[70vh] w-[80vw] shrink-0 sm:h-[75vh] sm:w-[55vw]"
              style={{ scrollSnapAlign: 'center' }}
            >
              <SpatialAnchor>
                <HomeScreen onOpenApp={(app, rect) => handleOpenApp(app, rect)} />
              </SpatialAnchor>
            </div>

            {openPanels.map((panel) => (
              <div
                key={panel.app.id}
                className="h-[70vh] w-[80vw] shrink-0 sm:h-[75vh] sm:w-[55vw]"
                style={{ scrollSnapAlign: 'center' }}
              >
                <SpatialAnchor>
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
