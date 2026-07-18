import { Home } from 'lucide-react';
import { Dwellable } from './Dwellable';
import { APP_ICONS } from './icons';
import type { AppDef } from './apps';

type DockProps = {
  openApp: AppDef | null;
  onHome: () => void;
};

// Fixed bottom taskbar: home button and the currently-open app's icon (if
// any). Stays visible whether or not an app window is open.
export function Dock({ openApp, onHome }: DockProps) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-between gap-4 border-t border-white/10 bg-neutral-950/80 px-6 py-3 backdrop-blur-md">
      <Dwellable onSelect={onHome}>
        <button
          type="button"
          onClick={onHome}
          aria-label="Home"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-teal-300 transition-colors duration-200 hover:bg-white/20"
        >
          <Home className="h-5 w-5" />
        </button>
      </Dwellable>

      <div className="flex flex-1 items-center justify-center">
        {openApp && (
          <div className="flex items-center gap-2 rounded-full bg-white/5 px-3 py-1.5 transition-opacity duration-200">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br ${openApp.gradient} text-white`}
            >
              {APP_ICONS[openApp.id]({ className: 'h-3.5 w-3.5' })}
            </span>
            <span className="text-xs text-white/70">{openApp.name}</span>
          </div>
        )}
      </div>

      <div className="w-11" />
    </div>
  );
}
