import { useEffect, useRef, useState } from 'react';
import { Dwellable } from './Dwellable';
import { useDwellEngine } from './dwell-engine';
import { APP_ICONS } from './icons';
import { APPS, type AppDef } from './apps';

type HomeScreenProps = {
  onOpenApp: (app: AppDef, iconRect: DOMRect | null) => void;
};

// --- Helper Hook ---
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// --- 1. Window Grabber Component (Vision Pro Style) ---
function WindowGrabber({ onDragStart }: { onDragStart?: (e: React.PointerEvent) => void }) {
  return (
    // Invisible Hitbox: Bada area taaki 3D space mein pakadna aasan ho
    <div 
      className="absolute -bottom-20 left-1/2 flex h-16 w-64 -translate-x-1/2 cursor-grab items-center justify-center active:cursor-grabbing z-50 group"
      onPointerDown={onDragStart}
    >
      {/* Visible Glass Pill */}
      <div className="h-1.5 w-32 rounded-full bg-white/40 shadow-[0_2px_10px_rgba(0,0,0,0.3)] backdrop-blur-xl transition-all duration-200 group-hover:bg-white/70 group-hover:shadow-[0_4px_16px_rgba(255,255,255,0.2)] group-active:scale-110 group-active:bg-white" />
    </div>
  );
}

// --- 2. App Icon Component (Perfect Circles) ---
function AppIcon({ app, onOpenApp }: { app: AppDef; onOpenApp: HomeScreenProps['onOpenApp'] }) {
  const iconRef = useRef<HTMLDivElement>(null);

  return (
    <Dwellable
      className="flex-col items-center justify-center transition-transform duration-300 hover:scale-110"
      onSelect={() => onOpenApp(app, iconRef.current?.getBoundingClientRect() ?? null)}
    >
      <div className="flex flex-col items-center gap-3">
        <div
          ref={iconRef}
          className={`flex h-16 w-16 sm:h-20 sm:w-20 items-center justify-center rounded-full bg-gradient-to-br ${app.gradient} text-white shadow-xl shadow-black/40 border border-white/20 backdrop-blur-md`}
        >
          {APP_ICONS[app.id]({ className: 'h-8 w-8 sm:h-10 sm:w-10 drop-shadow-md' })}
        </div>
        <span className="text-[12px] font-medium text-white sm:text-sm drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)] tracking-wide">
          {app.name}
        </span>
      </div>
    </Dwellable>
  );
}

// --- 3. Main Home Screen ---
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

  // Honeycomb staggered grid calculation (Rows of 3, 4, 5, 4, 3)
  const rows: AppDef[][] = [];
  let i = 0;
  const pattern = [3, 4, 5, 4, 3]; 
  let patternIdx = 0;
  
  while (i < APPS.length) {
    const chunkSize = pattern[patternIdx % pattern.length];
    rows.push(APPS.slice(i, i + chunkSize));
    i += chunkSize;
    patternIdx++;
  }

  // --- Drag / Move Logic (naya, ab yeh actually kaam karta hai) ---
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragStartRef = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });

  const handleDragStart = (e: React.PointerEvent) => {
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

  return (
    <div className="flex h-full w-full items-center justify-center relative" style={{ perspective: '1400px' }}>
      
      {/* Floating Left Sidebar (Vision Pro style Glass Pill) */}
      <div className="absolute left-[-20px] sm:left-[-60px] top-1/2 -translate-y-1/2 flex flex-col gap-4 p-2.5 bg-white/10 backdrop-blur-3xl rounded-full border border-white/20 shadow-2xl z-10">
        <button className="w-10 h-10 rounded-full bg-white/20 hover:bg-white/40 transition-colors flex items-center justify-center text-xl shadow-inner border border-white/10">👤</button>
        <button className="w-10 h-10 rounded-full bg-white/40 hover:bg-white/60 transition-colors flex items-center justify-center text-xl shadow-inner border border-white/30">📱</button>
        <button className="w-10 h-10 rounded-full bg-white/20 hover:bg-white/40 transition-colors flex items-center justify-center text-xl shadow-inner border border-white/10">🏔️</button>
      </div>

      {/* Main Container - Background Removed */}
      <div
        ref={scrollRef}
        className="relative flex h-full w-full flex-col items-center justify-center gap-10 sm:gap-12 transition-opacity duration-300"
        style={{
          transform: `translate3d(${dragOffset.x}px, ${dragOffset.y}px, 0) rotateY(0deg) scale(1)`,
          transformStyle: 'preserve-3d',
        }}
      >
        
        {/* Floating Clock at Top */}
        <div className="relative text-center mb-2">
          <div className="font-mono text-3xl font-light tracking-tight text-white drop-shadow-[0_4px_8px_rgba(0,0,0,0.8)] sm:text-4xl">
            {time}
          </div>
          <div className="mt-1 text-sm font-medium text-white/90 drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">{date}</div>
        </div>

        {/* Honeycomb App Grid */}
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

        {/* The Dragable Window Grabber Bar */}
        <WindowGrabber onDragStart={handleDragStart} />

      </div>
    </div>
  );
}
