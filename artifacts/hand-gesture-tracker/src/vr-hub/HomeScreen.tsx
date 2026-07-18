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
      <div className="flex flex-col items-center gap-2">
        <div
          ref={iconRef}
          className={`flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br ${app.gradient} text-white shadow-lg shadow-black/40 transition-transform duration-200`}
        >
          {APP_ICONS[app.id]({ className: 'h-7 w-7' })}
        </div>
        <span className="text-xs font-medium text-white/80">{app.name}</span>
      </div>
    </Dwellable>
  );
}

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
    <div className="fixed inset-0 z-30 flex items-center justify-center p-4 pb-24">
      <SpatialAnchor>
        <div
          ref={scrollRef}
          className="flex h-[70vh] w-[92vw] max-w-3xl flex-col items-center gap-10 overflow-y-auto rounded-2xl border border-white/10 bg-neutral-900/85 px-6 pb-10 pt-12 shadow-2xl shadow-black/70 backdrop-blur-[2px] transition-opacity duration-300 sm:h-[75vh] sm:w-[80vw] sm:pt-16"
        >
          <div className="text-center">
            <div className="font-mono text-6xl font-light tracking-tight text-white drop-shadow-lg sm:text-7xl">
              {time}
            </div>
            <div className="mt-2 text-sm font-medium text-white/60">{date}</div>
          </div>

          <div className="grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4">
            {APPS.map((app) => (
              <AppIcon key={app.id} app={app} onOpenApp={onOpenApp} />
            ))}
          </div>
        </div>
      </SpatialAnchor>
    </div>
  );
}
