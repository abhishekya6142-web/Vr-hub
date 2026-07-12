import { Eye, EyeOff } from 'lucide-react';
import { Dwellable } from './Dwellable';

type RealWorldToggleProps = {
  realWorld: boolean;
  onToggle: () => void;
};

// Fixed, always-on-top control that flips between OS mode (icons/dock/app
// windows over the camera passthrough) and real-world mode (plain camera
// feed, everything else hidden). Stays visible and pinch-dwell-selectable
// in both modes so the user can always get back.
export function RealWorldToggle({ realWorld, onToggle }: RealWorldToggleProps) {
  return (
    <div className="fixed right-4 top-4 z-[60]">
      <Dwellable onSelect={onToggle}>
        <button
          type="button"
          onClick={onToggle}
          aria-label={realWorld ? 'Switch to OS mode' : 'Switch to real world mode'}
          className={`flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-wide backdrop-blur-md transition-colors duration-200 ${
            realWorld
              ? 'border-teal-300/40 bg-teal-500/90 text-black hover:bg-teal-400'
              : 'border-white/15 bg-black/50 text-white/80 hover:bg-black/70'
          }`}
        >
          {realWorld ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          {realWorld ? 'Real World' : 'OS Mode'}
        </button>
      </Dwellable>
    </div>
  );
}
