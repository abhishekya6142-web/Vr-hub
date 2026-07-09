import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useDwellEngine } from './dwell-engine';

type DwellableProps = {
  onSelect: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
};

// Wraps any element to make it pinch-dwell-selectable: hold a pinch marker
// over it for ~1s and it "clicks". Renders a filling ring around itself as
// visual feedback while the dwell is in progress.
export function Dwellable({ onSelect, disabled, className, children }: DwellableProps) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const { register, progress } = useDwellEngine();
  const pct = progress[id] ?? 0;

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const disabledRef = useRef(!!disabled);
  disabledRef.current = !!disabled;

  useEffect(() => {
    return register({
      id,
      getRect: () => ref.current?.getBoundingClientRect() ?? null,
      onSelect: () => onSelectRef.current(),
      disabled: () => disabledRef.current,
    });
  }, [id, register]);

  const circumference = 2 * Math.PI * 26;
  const dashoffset = circumference * (1 - pct);

  return (
    <div
      ref={ref}
      className={`relative inline-flex items-center justify-center ${disabled ? 'pointer-events-none opacity-40' : ''} ${className ?? ''}`}
    >
      {children}
      {pct > 0 && (
        <svg
          className="pointer-events-none absolute left-1/2 top-1/2 h-[calc(100%+16px)] w-[calc(100%+16px)] -translate-x-1/2 -translate-y-1/2"
          viewBox="0 0 60 60"
        >
          <circle cx="30" cy="30" r="26" fill="none" stroke="rgba(45,212,191,0.2)" strokeWidth="4" />
          <circle
            cx="30"
            cy="30"
            r="26"
            fill="none"
            stroke="#2dd4bf"
            strokeWidth="4"
            strokeDasharray={circumference}
            strokeDashoffset={dashoffset}
            strokeLinecap="round"
            transform="rotate(-90 30 30)"
            style={{ transition: 'stroke-dashoffset 60ms linear' }}
          />
        </svg>
      )}
    </div>
  );
}
