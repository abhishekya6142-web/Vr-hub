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
          className="flex h-[70vh] w-[92vw] max-w-3xl flex-col items-center gap-4 overflow-y-auto rounded-2xl border border-white/10 bg-neutral-900/85 px-6 pb-6 pt-6 shadow-2xl shadow-black/70 backdrop-blur-[2px] transition-opacity duration-300 sm:h-[75vh] sm:w-[80vw] sm:pt-8"
        >
          <div className="text-center">
            <div className="font-mono text-3xl font-light tracking-tight text-white drop-shadow-lg sm:text-4xl">
              {time}
            </div>
            <div className="mt-1 text-xs font-medium text-white/60">{date}</div>
          </div>

          <div className="grid grid-cols-4 gap-x-4 gap-y-4 sm:gap-x-6 sm:gap-y-5">
            {APPS.map((app) => (
              <AppIcon key={app.id} app={app} onOpenApp={onOpenApp} />
            ))}
          </div>
        </div>
      </SpatialAnchor>
    </div>
  );
}
