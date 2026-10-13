import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useOptionalDwellEngine } from './dwell-engine';
import { ArrowLeft, Hand, Search } from 'lucide-react';
import {
  HandInteractionModeSelector,
  usePinchTarget,
} from './HandInteractionModeSelector';
import { HAND_INTERACTION_MODES, useHandInteractionMode } from './hand-interaction-mode';

// Settings app — Android Settings jaisa design: bada "Settings" title,
// gol search bar, icon + title + subtitle wali rows, patli dividers.
// White / grey / black theme.
//
// Abhi ek hi real section hai: Hand Tracking (interaction mode). Naya
// section jodne ke liye SECTIONS array mein ek entry + neeche ek page
// add karo.
//
// Rows aur back button dwell/pinch engine mein register hote hain
// (usePinchTarget), isliye AR mein haath ki pinch se bhi khulte hain.

type PageId = 'home' | 'hand';

const SECTIONS: {
  id: Exclude<PageId, 'home'>;
  title: string;
  keywords: string[];
}[] = [
  {
    id: 'hand',
    title: 'Hand Tracking',
    keywords: ['hand', 'tracking', 'laser', 'pointer', 'pinch', 'center', 'direct', 'interaction', 'gesture'],
  },
];

function Divider() {
  return <div className="mx-4 border-t border-neutral-200" />;
}

function SettingsRow({
  id,
  icon,
  title,
  subtitle,
  onOpen,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  subtitle: string;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  usePinchTarget(`settings-row-${id}`, ref, onOpen);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-5 px-5 py-5 text-left"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center text-neutral-900">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="text-xl font-medium text-neutral-900">{title}</span>
        <span className="text-base text-neutral-600">{subtitle}</span>
      </span>
    </button>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  usePinchTarget('settings-back', ref, onBack);

  return (
    <button
      ref={ref}
      type="button"
      aria-label="Back"
      onClick={onBack}
      className="flex h-12 w-12 items-center justify-center rounded-full bg-neutral-100 text-neutral-900"
    >
      <ArrowLeft className="h-6 w-6" />
    </button>
  );
}

export function SettingsApp() {
  const [page, setPage] = useState<PageId>('home');
  const [query, setQuery] = useState('');
  const [mode] = useHandInteractionMode();

  // Pinch-drag scroll isi container ko scroll kare — dwell engine ko
  // batao ki ye active scroll area hai (app band hone par pichhla
  // target apne aap wapas active ho jaata hai).
  const dwell = useOptionalDwellEngine();
  const registerScrollTarget = dwell?.registerScrollTarget;
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !registerScrollTarget) return;
    return registerScrollTarget(el);
  }, [page, registerScrollTarget]);

  const modeLabel = HAND_INTERACTION_MODES.find((m) => m.id === mode)?.label ?? '';

  const visibleSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.filter(
      (s) => s.title.toLowerCase().includes(q) || s.keywords.some((k) => k.includes(q)),
    );
  }, [query]);

  if (page === 'hand') {
    return (
      <div ref={scrollRef} className="h-full w-full overflow-y-auto bg-white text-neutral-900">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-5 pb-10 pt-6">
          <BackButton onBack={() => setPage('home')} />
          <h1 className="text-4xl font-semibold tracking-tight">Hand Tracking</h1>
          <div className="flex flex-col gap-3">
            <div className="px-1 text-sm font-medium text-neutral-600">Interaction mode</div>
            <HandInteractionModeSelector />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full w-full overflow-y-auto bg-white text-neutral-900">
      <div className="mx-auto flex w-full max-w-xl flex-col px-5 pb-10 pt-8">
        <h1 className="mb-6 text-5xl font-semibold tracking-tight">Settings</h1>

        <label className="mb-4 flex h-14 items-center gap-4 rounded-full border border-neutral-400 px-5">
          <Search className="h-5 w-5 shrink-0 text-neutral-700" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings"
            className="min-w-0 flex-1 bg-transparent text-lg text-neutral-900 outline-none placeholder:text-neutral-500"
          />
        </label>

        {visibleSections.length === 0 ? (
          <div className="px-5 py-8 text-base text-neutral-600">No matching settings</div>
        ) : (
          visibleSections.map((s, i) => (
            <div key={s.id}>
              {i > 0 && <Divider />}
              <SettingsRow
                id={s.id}
                icon={<Hand className="h-6 w-6" />}
                title={s.title}
                subtitle={`Interaction mode: ${modeLabel}`}
                onOpen={() => setPage(s.id)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
