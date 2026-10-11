import { Settings } from 'lucide-react';
import { HandInteractionModeSelector } from './HandInteractionModeSelector';

// Settings app: pehle sirf ComingSoonApp placeholder tha. Ab ismein
// "Hand Tracking" section hai jahan teen interaction modes mein se ek
// chuna jaata hai (Laser Pointer / Direct Hand / Center Point + Pinch).
// Selection hand-interaction-mode.ts mein persist hota hai, aur mode
// badalne par XR session ya hand tracking restart nahi hota.
export function SettingsApp() {
  return (
    <div className="h-full w-full overflow-y-auto px-6 py-8 text-white">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-neutral-800">
            <Settings className="h-8 w-8 text-white/80" />
          </div>
          <h2 className="text-2xl font-semibold">Settings</h2>
          <p className="text-sm text-white/60">App preferences and controls.</p>
        </div>

        <section className="flex flex-col gap-3 rounded-3xl border border-white/10 bg-neutral-900/70 p-4">
          <h3 className="text-base font-semibold">Hand Tracking</h3>
          <HandInteractionModeSelector />
        </section>
      </div>
    </div>
  );
}
