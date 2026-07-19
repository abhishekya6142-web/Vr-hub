import { useCallback, useEffect, useRef, useState } from 'react';
import HandTracker from '@/HandTracker';
import { DwellProvider, useDwellEngine } from './dwell-engine';
import { HomeScreen } from './HomeScreen';
import { Dock } from './Dock';
import { AppWindow } from './AppWindow';
import { OrientationGate } from './OrientationGate';
import { ScrollDragIndicator } from './ScrollDragIndicator';
import { RealWorldToggle } from './RealWorldToggle';
import { getApp, type AppDef } from './apps';

type OpenAppState = {
  app: AppDef;
  originRect: DOMRect | null;
  closing: boolean;
};

// Home always occupies one fixed slot; up to this many additional app
// panels can be open beside it at once (monitor-style multi-panel desk).
const MAX_APP_PANELS = 2;

function VRHubInner() {
  const { reportMarkers } = useDwellEngine();
  const [openPanels, setOpenPanels] = useState<OpenAppState[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Real-world mode hides all OS UI (icons, dock, open app windows) so only
  // the raw camera feed and pinch cursor dots are visible — without closing
  // or unmounting any open panels.
  const [realWorld, setRealWorld] = useState(false);

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
        // Already open — bring to front rather than opening a duplicate.
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
    // With Home always visible as its own fixed slot, the dock's Home
    // button now just closes the first open app panel (if any), giving a
    // quick "get back to just Home" action without hunting for each
    // individual panel's close button.
    if (openPanels.length > 0) handleClose(openPanels[0].app.id);
  }, [openPanels, handleClose]);

  return (
    <OrientationGate>
      <div className="fixed inset-0 overflow-hidden bg-black">
        {/* Camera passthrough + pinch-marker rendering. Renders at full
            natural brightness/color — no filter, tint, or scrim on top of
            it. Any darkening lives on individual UI panels further below,
            never on this layer. */}
        <HandTracker onPinchMarkers={reportMarkers} />

        {/* All OS UI — hidden (but still mounted, so state like open
            panels' contents is preserved) while real-world mode is active. */}
        <div className={realWorld ? 'hidden' : 'contents'}>
          {/* Shared row of panels: Home always occupies the first slot,
              each open app gets an additional slot beside it (monitor-desk
              style), up to MAX_APP_PANELS extra panels. */}
          <div className="fixed inset-0 z-30 flex items-stretch justify-center gap-4 p-4 pb-24">
            <div className="flex min-w-0 flex-1 items-center justify-center">
              <HomeScreen onOpenApp={(app, rect) => handleOpenApp(app, rect)} />
            </div>

            {openPanels.map((panel) => (
              <div key={panel.app.id} className="flex min-w-0 flex-1 items-center justify-center">
                <AppWindow
                  app={panel.app}
                  originRect={panel.originRect}
                  closing={panel.closing}
                  onClose={() => handleClose(panel.app.id)}
                />
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

        {/* Stays visible/selectable in both modes so the user can always
            switch back from real-world mode. */}
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

// Re-exported so app ids stay in one place if other code ever needs to open
// a specific app programmatically.
export { getApp };
