import { APP_ICONS } from './icons';
import type { AppDef } from './apps';

type DockProps = {
  openApp: AppDef | null;
  onHome: () => void;
};

// Fixed bottom taskbar: shows the currently-open app's icon (if any).
export function Dock({ openApp }: DockProps) {
  if (!openApp) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center gap-4 border-t border-white/10 bg-neutral-950/80 px-6 py-3 backdrop-blur-md">
      <div className="flex items-center gap-2 rounded-full bg-white/5 px-3 py-1.5 transition-opacity duration-200">
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br ${openApp.gradient} text-white`}
        >
          {APP_ICONS[openApp.id]({ className: 'h-3.5 w-3.5' })}
        </span>
        <span className="text-xs text-white/70">{openApp.name}</span>
      </div>
    </div>
  );
}
