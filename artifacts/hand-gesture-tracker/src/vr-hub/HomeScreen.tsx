import { useEffect, useRef, useState } from 'react';
import { Dwellable } from './Dwellable';
import { useDwellEngine } from './dwell-engine';
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

// 1. Updated AppIcon for Vision Pro style (Perfect Circles)
function AppIcon({ app, onOpenApp }: { app: AppDef; onOpenApp: HomeScreenProps['onOpenApp'] }) {
  const iconRef = useRef<HTMLDivElement>(null);

  return (
    <Dwellable
      className="flex-col items-center justify-center transition-transform duration-300 hover:scale-110"
      onSelect={() => onOpenApp(app, iconRef.current?.getBoundingClientRect() ?? null)}
    >
      <div className="flex flex-col items-center gap-3">
        {/* Circular Glass Icon */}
        <div
          ref={iconRef}
          className={`flex h-16 w-16 sm:h-20 sm:w-20 items-center justify-center rounded-full bg-gradient-to-br ${app.gradient} text-white shadow-xl shadow-black/40 border border-white/20 backdrop-blur-md`}
        >
          {APP_ICONS[app.id]({ className: 'h-8 w-8 sm:h-10 sm:w-10 drop-shadow-md' })}
        </div>
        
        {/* Text Label with strong drop-shadow so it's readable on any real-world background */}
        <span className="text-[12px] font-medium text-white sm:text-sm drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)] tracking-wide">
          {app.name}
        </span>
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

  // 2. Honeycomb staggered grid calculation (Rows of 3, 4, 5, 4, 3)
  const rows: AppDef[][] = [];
  let i = 0;
  const pattern = [3, 4, 5, 4, 3]; // This creates the Vision Pro zig-zag grid
  let patternIdx = 0;
  
  while (i < APPS.length) {
    const chunkSize = pattern[patternIdx % pattern.length];
    rows.push(APPS.slice(i, i + chunkSize));
    i += chunkSize;
    patternIdx++;
  }

  return (
    <div className="flex h-full w-full items-center justify-center relative" style={{ perspective: '1400px' }}>
      
      {/* 3. Floating Left Sidebar (Vision Pro style Glass Pill) */}
      <div className="absolute left-[-20px] sm:left-[-60px] top-1/2 -translate-y-1/2 flex flex-col gap-4 p-2.5 bg-white/10 backdrop-blur-3xl rounded-full border border-white/20 shadow-2xl z-10">
        <button className="w-10 h-10 rounded-full bg-white/20 hover:bg-white/40 transition-colors flex items-center justify-center text-xl shadow-inner border border-white/10">👤</button>
        <button className="w-10 h-10 rounded-full bg-white/40 hover:bg-white/60 transition-colors flex items-center justify-center text-xl shadow-inner border border-white/30">📱</button>
        <button className="w-10 h-10 rounded-full bg-white/20 hover:bg-white/40 transition-colors flex items-center justify-center text-xl shadow-inner border border-white/10">🏔️</button>
      </div>

      {/* Main Container - Removed the dark rectangular panel background */}
      <div
        ref={scrollRef}
        className="relative flex h-full w-full flex-col items-center justify-center gap-10 sm:gap-12 transition-opacity duration-300"
        style={{ transform: 'rotateY(0deg) scale(1)', transformStyle: 'preserve-3d' }}
      >
        
        {/* Floating Clock at Top */}
        <div className="relative text-center mb-2">
          <div className="font-mono text-3xl font-light tracking-tight text-white drop-shadow-[0_4px_8px_rgba(0,0,0,0.8)] sm:text-4xl">
            {time}
          </div>
          <div className="mt-1 text-sm font-medium text-white/90 drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">{date}</div>
        </div>

        {/* 4. Honeycomb App Grid (No Background) */}
        <div className="flex flex-col items-center gap-6 sm:gap-8">
          {rows.map((row, rowIndex) => (
            <div key={rowIndex} className="flex justify-center gap-6 sm:gap-8">
              {row.map((app) => (
                <AppIcon key={app.id} app={app} onOpenApp={onOpenApp} />
              ))}
            </div>
          ))}
        </div>

        {/* Pagination Dots at Bottom */}
        <div className="absolute bottom-[-10px] flex gap-3 items-center">
          <div className="w-2.5 h-2.5 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]"></div>
          <div className="w-2 h-2 rounded-full bg-white/40 shadow-md"></div>
        </div>

      </div>
    </div>
  );
}
