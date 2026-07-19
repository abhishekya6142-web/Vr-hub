import { useState } from 'react';
import { Grid3x3, Crown, ArrowLeft } from 'lucide-react';
import { Dwellable } from './Dwellable';
import { PuzzleGame } from './PuzzleGame';

type GameId = 'puzzle' | 'chess';

const GAME_LIST: { id: GameId; name: string; icon: (props: { className?: string }) => JSX.Element; gradient: string; available: boolean }[] = [
  {
    id: 'puzzle',
    name: '15 Puzzle',
    icon: (props) => <Grid3x3 {...props} />,
    gradient: 'from-amber-400 to-orange-600',
    available: true,
  },
  {
    id: 'chess',
    name: 'Chaturanga',
    icon: (props) => <Crown {...props} />,
    gradient: 'from-violet-500 to-purple-800',
    available: false, // coming soon
  },
];

export function GamesHub() {
  const [activeGame, setActiveGame] = useState<GameId | null>(null);

  if (activeGame === 'puzzle') {
    return (
      <div className="flex h-full w-full flex-col">
        <div className="flex items-center gap-2 border-b border-white/10 bg-white/5 px-3 py-2">
          <Dwellable onSelect={() => setActiveGame(null)}>
            <button
              type="button"
              onClick={() => setActiveGame(null)}
              className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/80 transition-colors duration-200 hover:bg-white/20"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Games
            </button>
          </Dwellable>
        </div>
        <div className="flex-1 overflow-hidden">
          <PuzzleGame />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-8 bg-neutral-900 p-6">
      <h2 className="text-lg font-semibold text-white/90">Choose a game</h2>
      <div className="grid grid-cols-2 gap-6">
        {GAME_LIST.map((game) => (
          <Dwellable
            key={game.id}
            className="flex-col gap-2"
            disabled={!game.available}
            onSelect={() => setActiveGame(game.id)}
          >
            <div className="flex flex-col items-center gap-2">
              <div
                className={`flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br ${game.gradient} text-white shadow-lg shadow-black/40`}
              >
                {game.icon({ className: 'h-7 w-7' })}
              </div>
              <span className="text-xs font-medium text-white/80">{game.name}</span>
              {!game.available && <span className="text-[10px] text-white/40">Coming soon</span>}
            </div>
          </Dwellable>
        ))}
      </div>
    </div>
  );
}
