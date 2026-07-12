import { useCallback, useEffect, useRef, useState } from 'react';
import HandTracker from '@/HandTracker';
import { DwellProvider, useDwellEngine } from './dwell-engine';
import { HomeScreen } from './HomeScreen';
import { Dock } from './Dock';
import { AppWindow } from './AppWindow';
import { OrientationGate } from './OrientationGate';
import { ScrollDragIndicator } from './ScrollDragIndicator';
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
        {/* Camera passthrough + pinch-marker rendering, unchanged from the
            existing hand-tracking implementation. */}
        <HandTracker onPinchMarkers={reportMarkers} />

        {/* Dark space/tech gradient scrim over the camera feed, giving it a
            "virtual desktop" wallpaper feel while keeping the passthrough
            visible enough to align pinches. */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[#050914]/90 via-[#0a1120]/70 to-[#02201d]/85" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_15%,rgba(45,212,191,0.12),transparent_45%),radial-gradient(circle_at_80%_75%,rgba(56,189,248,0.10),transparent_50%)]" />

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
