import { useEffect, useRef, useState } from 'react';
import { Dwellable } from './Dwellable';
import { useDwellEngine } from './dwell-engine';
import { APP_ICONS } from './icons';
import { APPS, type AppDef } from './apps';
import { SpatialAnchor } from './SpatialAnchor';

type HomeScreenProps = {
  onOpenApp: (app: AppDef, iconRect: DOMRect | null) => void;
};

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function AppIcon({ app, onOpenApp }: { app: AppDef; onOpenApp: HomeScreenProps['onOpenApp'] }) {
  const iconRef = useRef<HTMLDivElement>(null);

  return (
    <Dwellable
      className="flex-col gap-2"
      onSelect={() => onOpenApp(app, iconRef.current?.getBoundingClientRect() ?? null)}
    >
      <div className="flex flex-col items-center gap-1.5">
        <div
          ref={iconRef}
          className={`flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br ${app.gradient} text-white shadow-lg shadow-black/40 transition-transform duration-200 sm:h-14 sm:w-14`}
        >
          {APP_ICONS[app.id]({ className: 'h-5 w-5 sm:h-6 sm:w-6' })}
        </div>
        <span className="text-[11px] font-medium text-white/80 sm:text-xs">{app.name}</span>
      </div>
    </Dwellable>
  );
}

// Renders as a fill-parent panel now (the parent <Panel> from
// react-resizable-panels controls actual size/position on screen), rather
// than a fixed-size, self-centered card. The 3D spatial-anchor tilt effect
// and clock/icon-grid content are unchanged.
export function HomeScreen({ onOpenApp }: HomeScreenProps) {
  const now = useClock();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  const { registerScrollTarget } = useDwellEngine();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    return registerScrollTarget(el);
  }, [registerScrollTarget]);

  return (
    <div className="flex h-full w-full items-center justify-center" style={{ perspective: '1400px' }}>
      <SpatialAnchor>
        <div
          ref={scrollRef}
          className="relative flex h-full w-full flex-col items-center justify-center gap-4 overflow-hidden rounded-[2.5rem] border border-white/10 bg-neutral-900/85 px-8 py-6 shadow-2xl shadow-black/70 backdrop-blur-[2px] transition-opacity duration-300"
          style={{ transform: 'rotateY(0deg) scale(1)', transformStyle: 'preserve-3d' }}
        >
          <div
            className="absolute inset-0 rounded-[2.5rem]"
            style={{
              background:
                'radial-gradient(ellipse 60% 100% at 0% 50%, rgba(0,0,0,0.35), transparent 60%), radial-gradient(ellipse 60% 100% at 100% 50%, rgba(0,0,0,0.35), transparent 60%)',
              pointerEvents: 'none',
            }}
          />

          <div className="relative text-center">
            <div className="font-mono text-3xl font-light tracking-tight text-white drop-shadow-lg sm:text-4xl">
              {time}
            </div>
            <div className="mt-1 text-xs font-medium text-white/60">{date}</div>
          </div>

          <div className="relative grid grid-cols-4 gap-x-4 gap-y-4 sm:gap-x-6 sm:gap-y-5">
            {APPS.map((app) => (
              <AppIcon key={app.id} app={app} onOpenApp={onOpenApp} />
            ))}
          </div>
        </div>
      </SpatialAnchor>
    </div>
  );
}
