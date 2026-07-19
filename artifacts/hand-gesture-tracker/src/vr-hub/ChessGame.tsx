import { useEffect, useRef, useState } from 'react';
import { Chess, type Square } from 'chess.js';
import { Clock } from 'lucide-react';
import { useDwellEngine } from './dwell-engine';
import { getBestMove } from './chessAI';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const STARTING_TIME_SECONDS = 10 * 60;

const PIECE_SYMBOLS: Record<string, string> = {
  wp: '♙', wn: '♘', wb: '♗', wr: '♖', wq: '♕', wk: '♔',
  bp: '♟', bn: '♞', bb: '♝', br: '♜', bq: '♛', bk: '♚',
};

function squareFromRowCol(row: number, col: number): Square {
  const file = FILES[col];
  const rank = 8 - row;
  return `${file}${rank}` as Square;
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

type DragState = {
  fromSquare: Square;
  pointerX: number;
  pointerY: number;
} | null;

export function ChessGame() {
  const { activeMarkers } = useDwellEngine();
  const gameRef = useRef(new Chess());
  const [, forceRender] = useState(0);
  const [drag, setDrag] = useState<DragState>(null);
  const [thinking, setThinking] = useState(false);
  const [lastMove, setLastMove] = useState<{ from: Square; to: Square } | null>(null);

  const [whiteTime, setWhiteTime] = useState(STARTING_TIME_SECONDS);
  const [blackTime, setBlackTime] = useState(STARTING_TIME_SECONDS);

  const boardRef = useRef<HTMLDivElement>(null);
  const squareElsRef = useRef<Map<Square, HTMLDivElement>>(new Map());

  const dragRef = useRef(drag);
  dragRef.current = drag;
  const wasPinchingRef = useRef(false);
  const thinkingRef = useRef(thinking);
  thinkingRef.current = thinking;

  function rerender() {
    forceRender((n) => n + 1);
  }

  const game = gameRef.current;
  const gameOver = game.isGameOver();

  // Turn timer — only ticks the clock for whoever's turn it currently is,
  // and stops entirely once the game has ended.
  useEffect(() => {
    if (gameOver) return;
    const interval = setInterval(() => {
      if (game.turn() === 'w') {
        setWhiteTime((t) => Math.max(0, t - 1));
      } else {
        setBlackTime((t) => Math.max(0, t - 1));
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [gameOver, game]);

  function maybeTriggerAiMove() {
    if (game.isGameOver()) return;
    if (game.turn() !== 'b') return;

    setThinking(true);
    setTimeout(() => {
      const aiMove = getBestMove(game, 'medium');
      if (aiMove) {
        const moveResult = game.move(aiMove);
        if (moveResult) {
          setLastMove({ from: moveResult.from as Square, to: moveResult.to as Square });
        }
      }
      setThinking(false);
      rerender();
    }, 50);
  }

  function measureAllSquares(): Map<Square, DOMRect> {
    const rects = new Map<Square, DOMRect>();
    squareElsRef.current.forEach((el, sq) => {
      rects.set(sq, el.getBoundingClientRect());
    });
    return rects;
  }

  useEffect(() => {
    const marker = activeMarkers[0] ?? null;
    const isPinching = !!marker;

    if (thinkingRef.current || gameOver) {
      wasPinchingRef.current = isPinching;
      return;
    }

    if (!dragRef.current) {
      if (isPinching && !wasPinchingRef.current && marker) {
        const rects = measureAllSquares();
        for (const [sq, rect] of rects.entries()) {
          if (
            marker.x >= rect.left &&
            marker.x <= rect.right &&
            marker.y >= rect.top &&
            marker.y <= rect.bottom
          ) {
            const piece = game.get(sq);
            if (piece && piece.color === 'w' && game.turn() === 'w') {
              setDrag({ fromSquare: sq, pointerX: marker.x, pointerY: marker.y });
            }
            break;
          }
        }
      }
    } else if (marker) {
      setDrag((prev) => (prev ? { ...prev, pointerX: marker.x, pointerY: marker.y } : prev));
    } else if (wasPinchingRef.current) {
      const current = dragRef.current;
      if (current) {
        const rects = measureAllSquares();
        let dropSquare: Square | null = null;
        for (const [sq, rect] of rects.entries()) {
          if (
            current.pointerX >= rect.left &&
            current.pointerX <= rect.right &&
            current.pointerY >= rect.top &&
            current.pointerY <= rect.bottom
          ) {
            dropSquare = sq;
            break;
          }
        }

        if (dropSquare && dropSquare !== current.fromSquare) {
          try {
            const result = game.move({
              from: current.fromSquare,
              to: dropSquare,
              promotion: 'q',
            });
            if (result) {
              setLastMove({ from: current.fromSquare, to: dropSquare });
              rerender();
              maybeTriggerAiMove();
            }
          } catch {
            // Illegal move — piece visually snaps back since state didn't change.
          }
        }
      }
      setDrag(null);
    }

    wasPinchingRef.current = isPinching;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMarkers, gameOver]);

  function registerSquareEl(sq: Square, el: HTMLDivElement | null) {
    if (el) {
      squareElsRef.current.set(sq, el);
    } else {
      squareElsRef.current.delete(sq);
    }
  }

  function resetGame() {
    gameRef.current = new Chess();
    setDrag(null);
    setThinking(false);
    setLastMove(null);
    setWhiteTime(STARTING_TIME_SECONDS);
    setBlackTime(STARTING_TIME_SECONDS);
    rerender();
  }

  const board = game.board();
  const draggedPiece = drag ? game.get(drag.fromSquare) : null;
  const inCheck = game.isCheck();

  let statusLabel = 'Your move';
  if (game.isCheckmate()) {
    statusLabel = game.turn() === 'w' ? 'Checkmate — you lost' : 'Checkmate — you won! 🎉';
  } else if (game.isStalemate() || game.isDraw()) {
    statusLabel = 'Draw';
  } else if (inCheck) {
    statusLabel = game.turn() === 'w' ? 'Check! Your move' : 'Check!';
  } else if (thinking) {
    statusLabel = 'AI thinking...';
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-neutral-900 p-3">
      {/* Top bar: player clocks + turn indicator, mirroring the reference
          UI's layout but simplified for the pinch-driven single-player
          vs-AI mode. */}
      <div className="flex w-full max-w-sm items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-2">
        <div className="flex flex-col items-start">
          <span className="text-[10px] uppercase tracking-wider text-white/40">You (White)</span>
          <div className={`flex items-center gap-1.5 font-mono text-sm ${whiteTime < 30 ? 'text-red-400' : 'text-white/80'}`}>
            <Clock className="h-3 w-3" />
            {formatTime(whiteTime)}
          </div>
        </div>
        <div
          className={`h-2.5 w-2.5 rounded-full ${
            game.turn() === 'w' ? 'bg-white' : 'bg-white/20'
          }`}
        />
        <div className="flex flex-col items-end">
          <span className="text-[10px] uppercase tracking-wider text-white/40">AI (Black)</span>
          <div className={`flex items-center gap-1.5 font-mono text-sm ${blackTime < 30 ? 'text-red-400' : 'text-white/80'}`}>
            {formatTime(blackTime)}
            <Clock className="h-3 w-3" />
          </div>
        </div>
      </div>

      <div className="text-sm font-medium text-amber-300">{statusLabel}</div>

      <div
        ref={boardRef}
        className="relative grid aspect-square w-full max-w-sm grid-cols-8 grid-rows-8 overflow-hidden rounded-lg border border-white/10"
      >
        {board.map((rowArr, row) =>
          rowArr.map((cell, col) => {
            const sq = squareFromRowCol(row, col);
            const isLight = (row + col) % 2 === 0;
            const isBeingDragged = drag?.fromSquare === sq;
            const isLastMoveSquare = lastMove && (lastMove.from === sq || lastMove.to === sq);
            const pieceKey = cell ? `${cell.color}${cell.type}` : null;
            const isKingInCheck = inCheck && cell?.type === 'k' && cell.color === game.turn();

            return (
              <div
                key={sq}
                ref={(el) => registerSquareEl(sq, el)}
                className={`flex items-center justify-center text-3xl transition-colors duration-150 ${
                  isLight ? 'bg-[#e8d3a3]' : 'bg-[#8a5a3b]'
                } ${isLastMoveSquare ? 'ring-2 ring-inset ring-amber-400/70' : ''} ${
                  isKingInCheck ? 'bg-red-500/60' : ''
                }`}
              >
                {pieceKey && !isBeingDragged && (
                  <span className={cell!.color === 'w' ? 'text-white drop-shadow' : 'text-black'}>
                    {PIECE_SYMBOLS[pieceKey]}
                  </span>
                )}
              </div>
            );
          }),
        )}

        {drag && draggedPiece && (
          <div
            className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 text-4xl"
            style={{ left: drag.pointerX, top: drag.pointerY }}
          >
            <span className={draggedPiece.color === 'w' ? 'text-white drop-shadow-lg' : 'text-black'}>
              {PIECE_SYMBOLS[`${draggedPiece.color}${draggedPiece.type}`]}
            </span>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={resetGame}
        className="rounded-full bg-white/10 px-5 py-2 text-sm font-medium text-white/80 transition-colors duration-200 hover:bg-white/20"
      >
        New Game
      </button>
    </div>
  );
                }
