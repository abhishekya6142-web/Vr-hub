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

function WindowGrabber({ onDragStart }: { onDragStart?: (e: React.PointerEvent) => void }) {
  return (
    <div
      className="absolute -bottom-20 left-1/2 z-50 flex h-16 w-64 -translate-x-1/2 cursor-grab items-center justify-center active:cursor-grabbing group"
      style={{ touchAction: 'none' }}
      onPointerDown={onDragStart}
    >
      <div className="h-2 w-32 rounded-full bg-white/50 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-2xl transition-all duration-300 group-hover:w-40 group-hover:bg-white/80 group-active:scale-105 group-active:bg-white" />
    </div>
  );
}

function AppIcon({
  app,
  onOpenApp,
}: {
  app: AppDef;
  onOpenApp: HomeScreenProps['onOpenApp'];
}) {
  const iconRef = useRef<HTMLDivElement>(null);

  return (
    <Dwellable
      // Generous invisible hitbox (padding) around the icon for easy hand-tracking selection
      className="group relative flex flex-col items-center justify-start rounded-[32px] p-3 transition-all duration-400 ease-out hover:z-10 active:scale-[0.92] sm:p-4"
      onSelect={() => onOpenApp(app, iconRef.current?.getBoundingClientRect() ?? null)}
      style={{ transformStyle: 'preserve-3d' }}
    >
      <div
        className="pointer-events-none flex flex-col items-center justify-center gap-2 sm:gap-3 transition-transform duration-500 group-hover:[transform:translateZ(30px)]"
        style={{ transformStyle: 'preserve-3d' }}
      >
        <div
          ref={iconRef}
          // Slightly reduced dimensions (72/84px) to ensure all rows fit without vertical clipping
          className={`relative flex h-[72px] w-[72px] items-center justify-center overflow-hidden rounded-full bg-gradient-to-br ${app.gradient} shadow-[0_12px_32px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.3)] transition-all duration-400 group-hover:shadow-[0_24px_48px_rgba(0,0,0,0.5),0_0_24px_rgba(255,255,255,0.2)] sm:h-[84px] sm:w-[84px]`}
        >
          {/* Organic Spatial Glass Reflections */}
          <div className="absolute inset-0 rounded-full bg-gradient-to-b from-white/40 via-white/5 to-transparent mix-blend-overlay" />
          <div className="absolute inset-[1px] rounded-full border-[1px] border-white/30 mix-blend-overlay" />
          
          {/* Icon Graphic */}
          <div className="relative z-10 transition-transform duration-400 group-hover:scale-110">
            {APP_ICONS[app.id]({ 
              className: 'h-9 w-9 text-white drop-shadow-[0_3px_8px_rgba(0,0,0,0.5)] sm:h-10 sm:w-10' 
            })}
          </div>
        </div>

        {/* Crisp, floating label underneath */}
        <span 
          className="max-w-[120px] text-center text-[12px] font-medium tracking-wide text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)] transition-all duration-400 group-hover:text-white group-hover:drop-shadow-[0_4px_12px_rgba(0,0,0,1)] sm:text-[13px]"
          style={{ transform: 'translateZ(5px)' }}
        >
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

  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragStartRef = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });

  const handleDragStart = (e: React.PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      offsetX: dragOffset.x,
      offsetY: dragOffset.y,
    };

    const handleMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - dragStartRef.current.x;
      const dy = moveEvent.clientY - dragStartRef.current.y;
      setDragOffset({
        x: dragStartRef.current.offsetX + dx,
        y: dragStartRef.current.offsetY + dy,
      });
    };

    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  // ------------------------------------------------------------------
  // 🍯 DYNAMIC HONEYCOMB LAYOUT ALGORITHM
  // ------------------------------------------------------------------
  // Dynamically chunks the ENTIRE APPS array into an alternating 3-4-3-4 pattern.
  // This guarantees every registered app appears, seamlessly scaling to new rows.
  const honeycombRows: AppDef[][] = [];
  const pattern = [3, 4];
  let currentIndex = 0;
  let patternIndex = 0;

  while (currentIndex < APPS.length) {
    const chunkSize = pattern[patternIndex % pattern.length];
    honeycombRows.push(APPS.slice(currentIndex, currentIndex + chunkSize));
    currentIndex += chunkSize;
    patternIndex++;
  }
  // ------------------------------------------------------------------

  return (
    <div
      // Removed overflow-hidden here to ensure expanded rows are never clipped
      className="relative flex h-full w-full items-center justify-center"
      style={{ perspective: '1200px' }}
    >
      {/* Side controls floated deeply in the Z-axis */}
      <div 
        className="absolute left-4 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-3 rounded-full border border-white/10 bg-black/20 p-2 shadow-[0_16px_40px_rgba(0,0,0,0.3)] backdrop-blur-3xl sm:left-8 sm:gap-4"
        style={{ transform: 'translateZ(40px)' }}
      >
        <button className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-lg shadow-[inset_0_1px_4px_rgba(255,255,255,0.2)] transition-all hover:scale-110 hover:bg-white/20 sm:h-11 sm:w-11">👤</button>
        <button className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-lg shadow-[inset_0_1px_4px_rgba(255,255,255,0.2)] transition-all hover:scale-110 hover:bg-white/20 sm:h-11 sm:w-11">📱</button>
        <button className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-lg shadow-[inset_0_1px_4px_rgba(255,255,255,0.2)] transition-all hover:scale-110 hover:bg-white/20 sm:h-11 sm:w-11">🏔️</button>
      </div>

      {/* Main World-Locked Spatial Container */}
      <div
        ref={scrollRef}
        className="relative flex h-full w-full flex-col items-center justify-center transition-opacity duration-300"
        style={{
          transform: `translate3d(${dragOffset.x}px, ${dragOffset.y}px, 0) scale(1)`,
          transformStyle: 'preserve-3d',
        }}
      >
        {/* Floating Spatial Clock */}
        <div 
          className="relative mb-6 text-center sm:mb-10" 
          style={{ transform: 'translateZ(20px)' }}
        >
          <div className="font-mono text-4xl font-light tracking-tight text-white drop-shadow-[0_6px_16px_rgba(0,0,0,0.8)] sm:text-5xl">
            {time}
          </div>
          <div className="mt-1 text-xs font-medium tracking-wide text-white/90 drop-shadow-[0_4px_12px_rgba(0,0,0,0.8)] sm:mt-2 sm:text-sm">
            {date}
          </div>
        </div>

        {/* Dynamic Honeycomb Grid Container */}
        <div
          className="flex flex-col items-center justify-center"
          style={{ transformStyle: 'preserve-3d' }}
        >
          {honeycombRows.map((rowApps, rowIndex) => (
            <div 
              key={rowIndex}
              // Negative top margin physically pulls the alternating rows into the gaps of the row above, forming the hex interlock.
              className={`flex flex-row justify-center gap-x-2 sm:gap-x-4 ${rowIndex > 0 ? '-mt-4 sm:-mt-6' : ''}`}
              style={{ transformStyle: 'preserve-3d' }}
            >
              {rowApps.map((app) => (
                <AppIcon key={app.id} app={app} onOpenApp={onOpenApp} />
              ))}
            </div>
          ))}
        </div>

        <WindowGrabber onDragStart={handleDragStart} />
      </div>
    </div>
  );
}
