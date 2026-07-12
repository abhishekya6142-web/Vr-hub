import { ChevronDown, ChevronUp } from 'lucide-react';
import { useDwellEngine } from './dwell-engine';

// Small "you're in scroll mode, not select mode" affordance. Fades in the
// moment a held pinch turns into a drag-scroll, and highlights whichever
// direction is currently active, so the distinction from dwell-select is
// obvious at a glance.
export function ScrollDragIndicator() {
  const { scrollDrag } = useDwellEngine();

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none fixed right-3 top-1/2 z-50 flex -translate-y-1/2 flex-col items-center gap-1.5 rounded-full border border-white/10 bg-black/60 px-2 py-3 shadow-lg shadow-black/40 backdrop-blur-sm transition-opacity duration-200 ${
        scrollDrag.active ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <ChevronUp
        className={`h-4 w-4 transition-colors duration-150 ${
          scrollDrag.direction === 'up' ? 'text-teal-300' : 'text-white/25'
        }`}
      />
      <div className="h-6 w-px bg-white/15" />
      <ChevronDown
        className={`h-4 w-4 transition-colors duration-150 ${
          scrollDrag.direction === 'down' ? 'text-teal-300' : 'text-white/25'
        }`}
      />
    </div>
  );
}
