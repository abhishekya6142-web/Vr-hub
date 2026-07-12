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
};

function VRHubInner() {
  const { reportMarkers } = useDwellEngine();
  const [openApp, setOpenApp] = useState<OpenAppState | null>(null);
  const [closing, setClosing] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Real-world mode hides all OS UI (icons, dock, open app windows) so only
  // the raw camera feed and pinch cursor dots are visible — without closing
  // or unmounting whatever app happens to be open.
  const [realWorld, setRealWorld] = useState(false);

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    };
  }, []);

  const handleOpenApp = useCallback((app: AppDef, originRect: DOMRect | null) => {
    if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    setOpenApp({ app, originRect });
    setClosing(false);
  }, []);

  const handleClose = useCallback(() => {
    setClosing(true);
    if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    closeTimeoutRef.current = setTimeout(() => setOpenApp(null), 260);
  }, []);

  const handleHome = useCallback(() => {
    if (openApp) handleClose();
  }, [openApp, handleClose]);

  return (
    <OrientationGate>
      <div className="fixed inset-0 overflow-hidden bg-black">
        {/* Camera passthrough + pinch-marker rendering. Renders at full
            natural brightness/color — no filter, tint, or scrim on top of
            it. Any darkening lives on individual UI panels (app windows,
            dock) further below, never on this layer. */}
        <HandTracker onPinchMarkers={reportMarkers} />

        {/* All OS UI — hidden (but still mounted, so state like an open
            app's contents is preserved) while real-world mode is active. */}
        <div className={realWorld ? 'hidden' : 'contents'}>
          <div className="absolute inset-0 flex flex-col">
            {!openApp && <HomeScreen onOpenApp={(app, rect) => handleOpenApp(app, rect)} />}
          </div>

          {openApp && (
            <AppWindow
              key={openApp.app.id}
              app={openApp.app}
              originRect={openApp.originRect}
              closing={closing}
              onClose={handleClose}
            />
          )}

          <Dock openApp={openApp?.app ?? null} onHome={handleHome} />
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
