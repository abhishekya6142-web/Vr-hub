import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { X } from 'lucide-react';
import { Dwellable } from './Dwellable';
import { IframeApp } from './IframeApp';
import { Calculator } from './Calculator';
import type { AppDef } from './apps';

type AppWindowProps = {
  app: AppDef;
  originRect: DOMRect | null;
  closing: boolean;
  onClose: () => void;
};

// Opens with a scale/fade animation growing from the app icon's screen
// position (a FLIP-style transform: render in place, measure, then animate
// from the icon's rect to identity).
export function AppWindow({ app, originRect, closing, onClose }: AppWindowProps) {
  const winRef = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState(false);
  const [originTransform, setOriginTransform] = useState('scale(0.3)');
  const raf1Ref = useRef<number>(0);
  const raf2Ref = useRef<number>(0);

  useLayoutEffect(() => {
    let cancelled = false;
    const el = winRef.current;
    if (!el || !originRect) {
      setOpened(true);
      return;
    }
    const finalRect = el.getBoundingClientRect();
    const scaleX = Math.max(originRect.width / finalRect.width, 0.05);
    const scaleY = Math.max(originRect.height / finalRect.height, 0.05);
    const dx = originRect.left + originRect.width / 2 - (finalRect.left + finalRect.width / 2);
    const dy = originRect.top + originRect.height / 2 - (finalRect.top + finalRect.height / 2);
    setOriginTransform(`translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`);
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        if (!cancelled) setOpened(true);
      });
      raf2Ref.current = raf2;
    });
    raf1Ref.current = raf1;
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1Ref.current);
      cancelAnimationFrame(raf2Ref.current);
    };
  }, [originRect]);

  const showOpen = opened && !closing;
  const style: CSSProperties = {
    transform: showOpen ? 'translate(0, 0) scale(1, 1)' : originTransform,
    opacity: showOpen ? 1 : 0,
    transition: 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease',
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4 pb-24 backdrop-blur-[2px] transition-opacity duration-300">
      <div
        ref={winRef}
        style={style}
        className="flex h-[70vh] w-[92vw] max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-900/95 shadow-2xl shadow-black/70 sm:h-[75vh] sm:w-[80vw]"
      >
        <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-4 py-2.5">
          <span className="text-sm font-medium text-white/90">{app.name}</span>
          <Dwellable onSelect={onClose}>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors duration-200 hover:bg-red-500/80 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </Dwellable>
        </div>
        <div className="flex-1 overflow-hidden">
          {app.type === 'calculator' ? <Calculator /> : <IframeApp app={app} />}
        </div>
      </div>
    </div>
  );
}
