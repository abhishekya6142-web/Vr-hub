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
      className="absolute -bottom-16 left-1/2 z-50 flex h-14 w-64 -translate-x-1/2 cursor-grab items-center justify-center active:cursor-grabbing group"
      style={{ touchAction: 'none' }}
      onPointerDown={onDragStart}
    >
      <div className="h-1.5 w-28 rounded-full bg-white/45 shadow-[0_2px_12px_rgba(0,0,0,0.35)] backdrop-blur-xl transition-all duration-200 group-hover:w-32 group-hover:bg-white/70 group-active:scale-110 group-active:bg-white" />
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
  const row = Math.floor(index / 4);

  // Subtle depth layering: middle row sits slightly forward, like floating visionOS tiles.
  const depth = row === 1 ? 28 : row === 0 ? 16 : 8;
  const rowScale = row === 1 ? 1.02 : row === 0 ? 0.98 : 0.96;

  return (
    <Dwellable
      className="group flex h-[112px] w-full max-w-[150px] flex-col items-center justify-start rounded-[32px] p-1 transition-transform duration-300 ease-out hover:scale-[1.08] active:scale-[0.96]"
      onSelect={() => onOpenApp(app, iconRef.current?.getBoundingClientRect() ?? null)}
    >
      <div
        className="flex flex-col items-center gap-2 pointer-events-none"
        style={{
          transform: `translateZ(${depth}px) scale(${rowScale})`,
          transformStyle: 'preserve-3d',
        }}
      >
        <div
          ref={iconRef}
          className={`relative flex h-[72px] w-[72px] items-center justify-center overflow-hidden rounded-full bg-gradient-to-br ${app.gradient} border border-white/30 shadow-[0_12px_30px_rgba(0,0,0,0.42),0_3px_8px_rgba(0,0,0,0.24),inset_0_1px_2px_rgba(255,255,255,0.45)] backdrop-blur-sm transition-all duration-300 group-hover:border-white/55 group-hover:shadow-[0_18px_38px_rgba(0,0,0,0.48),0_0_24px_rgba(255,255,255,0.16),inset_0_1px_2px_rgba(255,255,255,0.55)] sm:h-[78px] sm:w-[78px]`}
        >
          <div className="absolute inset-0 rounded-full bg-gradient-to-b from-white/28 via-white/5 to-transparent" />
          <div className="absolute inset-[2px] rounded-full border border-white/10" />
          <div className="relative z-10">
            {APP_ICONS[app.id]({ className: 'h-9 w-9 text-white drop-shadow-[0_2px_5px_rgba(0,0,0,0.35)] sm:h-10 sm:w-10' })}
          </div>
        </div>
        <span className="max-w-[132px] text-center text-[12px] font-medium leading-tight tracking-[0.01em] text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.95)] sm:text-[13px]">
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
      style={{ perspective: '1600px' }}
    >
      {/* VisionOS-inspired floating side controls */}
      <div className="absolute left-[-16px] top-1/2 z-20 flex -translate-y-1/2 flex-col gap-3 rounded-full border border-white/18 bg-white/[0.11] p-2 shadow-[0_14px_40px_rgba(0,0,0,0.32)] backdrop-blur-xl sm:left-[-30px]">
        <button className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/15 text-lg shadow-inner transition-transform hover:scale-110 hover:bg-white/25">👤</button>
        <button className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/15 text-lg shadow-inner transition-transform hover:scale-110 hover:bg-white/25">📱</button>
        <button className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/15 text-lg shadow-inner transition-transform hover:scale-110 hover:bg-white/25">🏔️</button>
      </div>

      <div
        ref={scrollRef}
        className="relative flex h-full w-full flex-col items-center justify-center px-16 pb-8 pt-4 transition-opacity duration-300 sm:px-20"
        style={{
          transform: `translate3d(${dragOffset.x}px, ${dragOffset.y}px, 0) rotateY(0deg) scale(1)`,
          transformStyle: 'preserve-3d',
        }}
      >
        {/* Compact spatial clock */}
        <div className="relative mb-7 text-center sm:mb-8">
          <div className="font-mono text-3xl font-light tracking-tight text-white drop-shadow-[0_4px_12px_rgba(0,0,0,0.9)] sm:text-4xl">
            {time}
          </div>
          <div className="mt-1 text-xs font-medium text-white/85 drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)] sm:text-sm">
            {date}
          </div>
        </div>

        {/* True 4 × 3 visionOS-style home grid */}
        <div
          className="grid w-full max-w-[780px] grid-cols-3 justify-items-center gap-x-7 gap-y-8 sm:grid-cols-4 sm:gap-x-12 sm:gap-y-10"
          style={{ transformStyle: 'preserve-3d' }}
        >
          {APPS.map((app, index) => (
            <AppIcon key={app.id} app={app} index={index} onOpenApp={onOpenApp} />
          ))}
        </div>

        {/* Page indicator */}
        <div className="mt-7 flex items-center gap-2.5 sm:mt-8">
          <div className="h-2 w-2 rounded-full bg-white shadow-[0_0_10px_rgba(255,255,255,0.9)]" />
          <div className="h-1.5 w-1.5 rounded-full bg-white/35" />
          <div className="h-1.5 w-1.5 rounded-full bg-white/25" />
        </div>

        <WindowGrabber onDragStart={handleDragStart} />
      </div>
    </div>
  );
}
