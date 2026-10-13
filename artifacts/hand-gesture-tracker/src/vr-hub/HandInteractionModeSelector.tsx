// vr-hub/HandInteractionModeSelector.tsx
//
// Hand Tracking settings mein teen interaction modes mein se ek chunne
// ka selector (light / white-grey-black theme). Sirf ek mode active
// hota hai; selected option par kaala border + bhara hua radio dikhta
// hai. Selection hand-interaction-mode.ts mein persist hota hai.
//
// usePinchTarget(): koi bhi element dwell/pinch engine mein register
// karta hai, taaki AR mein haath ki pinch se bhi click ho (sirf touch
// onClick par depend na rahe). DwellProvider ke bahar mount ho to
// crash nahi karta — tab sirf touch/click kaam karta hai.

import { useEffect, useRef, type RefObject } from 'react';
import {
  HAND_INTERACTION_MODES,
  useHandInteractionMode,
  type HandInteractionMode,
} from './hand-interaction-mode';
import { useOptionalDwellEngine } from './dwell-engine';

export function usePinchTarget(id: string, ref: RefObject<HTMLElement | null>, onSelect: () => void) {
  const dwell = useOptionalDwellEngine();
  const registerRef = useRef(dwell?.register);
  registerRef.current = dwell?.register;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const register = registerRef.current;
    if (!register) return;
    return register({
      id,
      getRect: () => ref.current?.getBoundingClientRect() ?? null,
      onSelect: () => onSelectRef.current(),
      disabled: () => false,
    });
  }, [id, ref]);
}

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
  usePinchTarget(`hand-mode-${id}`, ref, () => onPick(id));

  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onPick(id)}
      className={`flex w-full items-center gap-4 rounded-3xl px-5 py-4 text-left transition-colors ${
        selected ? 'bg-neutral-200 ring-2 ring-neutral-900' : 'bg-neutral-100'
      }`}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-lg font-medium text-neutral-900">{label}</span>
        <span className="text-sm text-neutral-600">{description}</span>
      </span>
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${
          selected ? 'border-neutral-900' : 'border-neutral-400'
        }`}
      >
        {selected && <span className="h-3 w-3 rounded-full bg-neutral-900" />}
      </span>
    </button>
  );
}

export function HandInteractionModeSelector() {
  const [mode, setMode] = useHandInteractionMode();

  return (
    <div className="flex flex-col gap-3" role="radiogroup" aria-label="Hand interaction mode">
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
