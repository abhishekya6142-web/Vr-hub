// vr-hub/HandInteractionModeSelector.tsx
//
// Hand Tracking settings mein daalne ke liye selector. Teen modes mein
// se sirf ek active hota hai; selected option cyan border/tick se
// obvious dikhta hai. Selection hand-interaction-mode.ts mein persist
// hota hai (localStorage) aur reload ke baad restore hota hai.
//
// Har option dwell/pinch engine mein register hota hai, isliye AR
// panel ke andar ye haath se pinch karke bhi select hota hai (sirf touch
// onClick par depend nahi). DwellProvider ke bahar mount ho to bhi
// crash nahi karta — tab sirf touch/click kaam karta hai.
//
// Use: settings screen ke Hand Tracking section mein
//   import { HandInteractionModeSelector } from './HandInteractionModeSelector';
//   <HandInteractionModeSelector />

import { useEffect, useRef } from 'react';
import {
  HAND_INTERACTION_MODES,
  useHandInteractionMode,
  type HandInteractionMode,
} from './hand-interaction-mode';
import { useOptionalDwellEngine } from './dwell-engine';

function ModeOption({
  id,
  label,
  description,
  selected,
  onPick,
}: {
  id: HandInteractionMode;
  label: string;
  description: string;
  selected: boolean;
  onPick: (id: HandInteractionMode) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const dwell = useOptionalDwellEngine();

  const registerRef = useRef(dwell?.register);
  registerRef.current = dwell?.register;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    const register = registerRef.current;
    if (!register) return;
    return register({
      id: `hand-mode-${id}`,
      getRect: () => ref.current?.getBoundingClientRect() ?? null,
      onSelect: () => onPickRef.current(id),
      disabled: () => false,
    });
  }, [id]);

  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onPick(id)}
      className={`flex w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-colors ${
        selected ? 'border-cyan-400 bg-cyan-500/15' : 'border-white/15 bg-neutral-900/60'
      }`}
    >
      <span
        className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          selected ? 'border-cyan-400' : 'border-white/40'
        }`}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-cyan-400" />}
      </span>
      <span className="flex flex-col">
        <span className="text-sm font-semibold text-white">{label}</span>
        <span className="text-xs text-white/60">{description}</span>
      </span>
    </button>
  );
}

export function HandInteractionModeSelector() {
  const [mode, setMode] = useHandInteractionMode();

  return (
    <div className="flex flex-col gap-2" role="radiogroup" aria-label="Hand interaction mode">
      <div className="text-xs font-semibold uppercase tracking-wide text-white/50">Interaction mode</div>
      {HAND_INTERACTION_MODES.map((m) => (
        <ModeOption
          key={m.id}
          id={m.id}
          label={m.label}
          description={m.description}
          selected={mode === m.id}
          onPick={setMode}
        />
      ))}
    </div>
  );
}

export default HandInteractionModeSelector;
