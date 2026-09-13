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
  index,
  onOpenApp,
}: {
  app: AppDef;
  index: number;
  onOpenApp: HomeScreenProps['onOpenApp'];
}) {
  const iconRef = useRef<HTMLDivElement>(null);

  return (
    <Dwellable
      // The Dwellable acts as a massively oversized hitbox (p-4 to p-6) for stable hand tracking
      className="group relative flex flex-col items-center justify-start rounded-[40px] p-4 transition-all duration-500 ease-out hover:bg-white/[0.03] active:scale-[0.92] sm:p-6"
      onSelect={() => onOpenApp(app, iconRef.current?.getBoundingClientRect() ?? null)}
      style={{ transformStyle: 'preserve-3d' }}
    >
      <div
        className="pointer-events-none flex flex-col items-center justify-center gap-4 transition-transform duration-500 group-hover:[transform:translateZ(40px)]"
        style={{ transformStyle: 'preserve-3d' }}
      >
        <div
          ref={iconRef}
          className={`relative flex h-[88px] w-[88px] items-center justify-center overflow-hidden rounded-full bg-gradient-to-br ${app.gradient} shadow-[0_16px_40px_rgba(0,0,0,0.5),0_4px_12px_rgba(0,0,0,0.3)] transition-all duration-500 group-hover:shadow-[0_30px_60px_rgba(0,0,0,0.6),0_0_30px_rgba(255,255,255,0.2)] sm:h-[104px] sm:w-[104px]`}
        >
          {/* Spatial Glass Reflections */}
          <div className="absolute inset-0 rounded-full bg-gradient-to-b from-white/40 via-white/5 to-transparent mix-blend-overlay" />
          <div className="absolute inset-[1.5px] rounded-full border-[1.5px] border-white/40 mix-blend-overlay" />
          <div className="absolute bottom-0 h-1/2 w-full rounded-full bg-gradient-to-t from-white/20 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
          
          {/* Icon Graphic */}
          <div className="relative z-10 transition-transform duration-500 group-hover:scale-110">
            {APP_ICONS[app.id]({ 
              className: 'h-11 w-11 text-white drop-shadow-[0_4px_10px_rgba(0,0,0,0.4)] sm:h-12 sm:w-12' 
            })}
          </div>
        </div>

        {/* Floating Label */}
        <span 
          className="max-w-[140px] text-center text-[14px] font-semibold tracking-wide text-white drop-shadow-[0_3px_8px_rgba(0,0,0,0.9)] transition-all duration-500 group-hover:text-white group-hover:drop-shadow-[0_6px_16px_rgba(0,0,0,1)] sm:text-[15px]"
          style={{ transform: 'translateZ(10px)' }}
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

  return (
    <div
      className="relative flex h-full w-full items-center justify-center overflow-hidden"
      style={{ perspective: '1200px' }}
    >
      {/* Side controls floated deeply in the Z-axis */}
      <div 
        className="absolute left-4 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-4 rounded-[32px] border border-white/20 bg-white/10 p-3 shadow-[0_20px_50px_rgba(0,0,0,0.4)] backdrop-blur-2xl sm:left-8"
        style={{ transform: 'translateZ(60px)' }}
      >
        <button className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-xl shadow-[inset_0_1px_4px_rgba(255,255,255,0.4)] transition-all hover:scale-110 hover:bg-white/25">👤</button>
        <button className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-xl shadow-[inset_0_1px_4px_rgba(255,255,255,0.4)] transition-all hover:scale-110 hover:bg-white/25">📱</button>
        <button className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-xl shadow-[inset_0_1px_4px_rgba(255,255,255,0.4)] transition-all hover:scale-110 hover:bg-white/25">🏔️</button>
      </div>

      <div
        ref={scrollRef}
        className="relative flex h-full w-full flex-col items-center justify-center px-24 pb-12 pt-8 transition-opacity duration-300"
        style={{
          transform: `translate3d(${dragOffset.x}px, ${dragOffset.y}px, 0) scale(1)`,
          transformStyle: 'preserve-3d',
        }}
      >
        {/* Floating Spatial Clock */}
        <div 
          className="relative mb-12 text-center" 
          style={{ transform: 'translateZ(30px)' }}
        >
          <div className="font-mono text-5xl font-light tracking-tight text-white drop-shadow-[0_8px_24px_rgba(0,0,0,0.8)] sm:text-6xl">
            {time}
          </div>
          <div className="mt-3 text-sm font-medium tracking-wide text-white/90 drop-shadow-[0_4px_12px_rgba(0,0,0,0.8)] sm:text-base">
            {date}
          </div>
        </div>

        {/* 
          Spatial App Layout 
          Using Flex with wrapping allows natural center-staggering.
          Generous gaps and max-width replicate the airy, floating honeycomb feeling.
        */}
        <div
          className="flex w-full max-w-[920px] flex-wrap justify-center gap-x-6 gap-y-8 sm:gap-x-12 sm:gap-y-10"
          style={{ transformStyle: 'preserve-3d' }}
        >
          {APPS.map((app, index) => (
            <AppIcon key={app.id} app={app} index={index} onOpenApp={onOpenApp} />
          ))}
        </div>

        {/* Deeply set page indicators */}
        <div 
          className="mt-14 flex items-center gap-4"
          style={{ transform: 'translateZ(20px)' }}
        >
          <div className="h-2 w-2 rounded-full bg-white shadow-[0_0_12px_rgba(255,255,255,1)]" />
          <div className="h-1.5 w-1.5 rounded-full bg-white/40 hover:bg-white/70 transition-colors" />
          <div className="h-1.5 w-1.5 rounded-full bg-white/40 hover:bg-white/70 transition-colors" />
        </div>

        <WindowGrabber onDragStart={handleDragStart} />
      </div>
    </div>
  );
}
