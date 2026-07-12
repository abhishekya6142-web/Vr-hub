import { useEffect, useState, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';

type ScreenOrientationWithLock = ScreenOrientation & {
  lock?: (orientation: string) => Promise<void>;
};

function isPortrait() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(orientation: portrait)').matches;
}

// This app is designed for landscape use (the pinch-tracking camera view
// and OS-style window layout need the extra horizontal room). Real
// orientation locking only works in a handful of browsers and only once
// the page is fullscreen/installed as a PWA, so this is best-effort: try
// to lock, and regardless, block interaction with a "rotate your device"
// prompt whenever we detect portrait.
export function OrientationGate({ children }: { children: ReactNode }) {
  const [portrait, setPortrait] = useState(isPortrait);

  useEffect(() => {
    const mq = window.matchMedia('(orientation: portrait)');
    const handleChange = () => setPortrait(mq.matches);
    mq.addEventListener('change', handleChange);
    window.addEventListener('resize', handleChange);
    return () => {
      mq.removeEventListener('change', handleChange);
      window.removeEventListener('resize', handleChange);
    };
  }, []);

  useEffect(() => {
    const orientation = screen.orientation as ScreenOrientationWithLock | undefined;
    orientation?.lock?.('landscape').catch(() => {
      // Locking is only permitted in fullscreen/installed contexts in
      // supporting browsers; silently ignore rejection elsewhere.
    });
  }, []);

  return (
    <>
      {children}
      {portrait && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-5 bg-neutral-950 px-8 text-center">
          <RotateCcw className="h-12 w-12 animate-[spin_2.5s_linear_infinite] text-teal-400" />
          <p className="text-base font-medium text-white/90">Rotate your device to landscape</p>
          <p className="max-w-xs text-sm text-white/50">
            This app is designed for landscape mode for the best hand-tracking view.
          </p>
        </div>
      )}
    </>
  );
}
