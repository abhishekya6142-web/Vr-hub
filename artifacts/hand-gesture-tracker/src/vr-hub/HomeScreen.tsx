import { useEffect, useRef, useState } from 'react';
import { Dwellable } from './Dwellable';
import { APP_ICONS } from './icons';
import { APPS, type AppDef } from './apps';

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

  return (
    <div className="flex h-full w-full flex-col items-center gap-10 overflow-y-auto px-6 pb-28 pt-12 transition-opacity duration-300 sm:pt-16">
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
  );
}
