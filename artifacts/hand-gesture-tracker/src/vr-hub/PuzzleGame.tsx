import { useEffect, useRef, useState } from 'react';
import { useDwellEngine } from './dwell-engine';

const GRID_SIZE = 4;
const TOTAL_TILES = GRID_SIZE * GRID_SIZE - 1;

type TileValue = number | null;

function createSolvedBoard(): TileValue[] {
  const board: TileValue[] = Array.from({ length: TOTAL_TILES }, (_, i) => i + 1);
  board.push(null);
  return board;
}

function createShuffledBoard(): TileValue[] {
  const board = createSolvedBoard();
  let blankIndex = board.indexOf(null);

  for (let i = 0; i < 300; i++) {
    const neighbors = getAdjacentIndices(blankIndex);
    const swapWith = neighbors[Math.floor(Math.random() * neighbors.length)];
    [board[blankIndex], board[swapWith]] = [board[swapWith], board[blankIndex]];
    blankIndex = swapWith;
  }

  return board;
}

function getAdjacentIndices(index: number): number[] {
  const row = Math.floor(index / GRID_SIZE);
  const col = index % GRID_SIZE;
  const neighbors: number[] = [];
  if (row > 0) neighbors.push(index - GRID_SIZE);
  if (row < GRID_SIZE - 1) neighbors.push(index + GRID_SIZE);
  if (col > 0) neighbors.push(index - 1);
  if (col < GRID_SIZE - 1) neighbors.push(index + 1);
  return neighbors;
}

function isSolved(board: TileValue[]): boolean {
  for (let i = 0; i < TOTAL_TILES; i++) {
    if (board[i] !== i + 1) return false;
  }
  return board[TOTAL_TILES] === null;
}

type DragState = {
  tileIndex: number;
  pointerX: number;
  pointerY: number;
  // Pickup ke waqt pointer aur tile ke CENTER ke beech ka offset. Isse
  // "teleport" bug fix hota hai — pehle floating tile turant apna center
  // pointer ki exact position pe snap kar deta tha (chahe tumne tile ke
  // corner pe pinch kiya ho), so ek chhota sa visible jump hota tha. Ab
  // tile apni pickup-time relative position pointer ke saath maintain
  // karta hai, jaise finger ke neeche wahi grip point rahe jaha se utha
  // tha.
  grabOffsetX: number;
  grabOffsetY: number;
} | null;

export function PuzzleGame() {
  const { activeMarkers } = useDwellEngine();
  const [board, setBoard] = useState<TileValue[]>(() => createShuffledBoard());
  const [solved, setSolved] = useState(false);
  const [drag, setDrag] = useState<DragState>(null);

  const boardRef = useRef<HTMLDivElement>(null);
  const tileElsRef = useRef<Map<number, HTMLDivElement>>(new Map());

  const dragRef = useRef(drag);
  dragRef.current = drag;
  const wasPinchingRef = useRef(false);

  // Re-measures every tile's current on-screen rect right now, rather than
  // relying on rects captured once at mount time. Called at the moment a
  // pinch is detected (pickup) and at the moment it's released (drop), so
  // hit-testing always uses fresh coordinates.
  function measureAllTiles(): Map<number, DOMRect> {
    const rects = new Map<number, DOMRect>();
    tileElsRef.current.forEach((el, index) => {
      rects.set(index, el.getBoundingClientRect());
    });
    return rects;
  }

  useEffect(() => {
    const marker = activeMarkers[0] ?? null;
    const isPinching = !!marker;

    if (!dragRef.current) {
      if (isPinching && !wasPinchingRef.current && marker) {
        const rects = measureAllTiles();
        for (const [index, rect] of rects.entries()) {
          if (
            marker.x >= rect.left &&
            marker.x <= rect.right &&
            marker.y >= rect.top &&
            marker.y <= rect.bottom &&
            board[index] !== null
          ) {
            // Tile ka center nikalo aur pointer se uska offset store karo,
            // taaki floating tile turant apna center pointer pe snap na
            // kare — jahan se pinch kiya wahi grip point maintain rahe.
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            setDrag({
              tileIndex: index,
              pointerX: marker.x,
              pointerY: marker.y,
              grabOffsetX: centerX - marker.x,
              grabOffsetY: centerY - marker.y,
            });
            break;
          }
        }
      }
    } else if (marker) {
      setDrag((prev) => (prev ? { ...prev, pointerX: marker.x, pointerY: marker.y } : prev));
    } else if (wasPinchingRef.current) {
      const current = dragRef.current;
      if (current) {
        const rects = measureAllTiles();
        let dropIndex: number | null = null;
        for (const [index, rect] of rects.entries()) {
          if (
            current.pointerX >= rect.left &&
            current.pointerX <= rect.right &&
            current.pointerY >= rect.top &&
            current.pointerY <= rect.bottom
          ) {
            dropIndex = index;
            break;
          }
        }

        setBoard((prevBoard) => {
          if (dropIndex === null) return prevBoard;
          const from = current.tileIndex;
          const isBlankAtDrop = prevBoard[dropIndex] === null;
          const adjacent = getAdjacentIndices(from).includes(dropIndex);
          if (!isBlankAtDrop || !adjacent) return prevBoard;

          const next = [...prevBoard];
          [next[from], next[dropIndex]] = [next[dropIndex], next[from]];
          return next;
        });
      }
      setDrag(null);
    }

    wasPinchingRef.current = isPinching;
  }, [activeMarkers, board]);

  useEffect(() => {
    setSolved(isSolved(board));
  }, [board]);

  function registerTileEl(index: number, el: HTMLDivElement | null) {
    if (el) {
      tileElsRef.current.set(index, el);
    } else {
      tileElsRef.current.delete(index);
    }
  }

  function reshuffle() {
    setBoard(createShuffledBoard());
    setSolved(false);
    setDrag(null);
  }

  const draggedTileValue = drag ? board[drag.tileIndex] : null;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 overflow-hidden bg-neutral-900 p-3">
      {solved && (
        <div className="shrink-0 rounded-full bg-emerald-500/20 px-4 py-1.5 text-sm font-semibold text-emerald-300">
          Solved! 🎉
        </div>
      )}

      {/* Grid ab width AND height dono constraints ke andar rehta hai —
          pehle sirf "w-full max-w-sm" + aspect-square tha, jo chhoti
          window me (jaha available height, width se kam ho sakti hai)
          apni height ko available space se bada khींch leta tha, aur
          overflow-hidden use crop kar deta tha (top/bottom tiles kat
          jaate the).
          
          Fix: wrapper flex box available height/width dekh ke grid ko
          hamesha ek perfect square rakhta hai jo dono directions me fit
          ho — grid khud "aspect-square" + "h-full" + "max-w-full" se
          apni size clamp karta hai, JS/container-query ki zaroorat nahi. */}
      <div className="flex min-h-0 flex-1 items-center justify-center self-stretch">
        <div
          ref={boardRef}
          className="relative grid aspect-square h-full max-h-full max-w-full grid-cols-4 grid-rows-4 gap-1.5 rounded-xl bg-black/30 p-1.5"
        >
          {board.map((value, index) => {
            const isBeingDragged = drag?.tileIndex === index;
            return (
              <div
                key={index}
                ref={(el) => registerTileEl(index, el)}
                className={`flex aspect-square items-center justify-center rounded-lg text-xl font-bold transition-colors duration-150 ${
                  value === null
                    ? 'bg-transparent'
                    : isBeingDragged
                      ? 'bg-amber-500/30 text-amber-200'
                      : 'bg-amber-500 text-black shadow-md shadow-black/40'
                }`}
              >
                {value !== null && !isBeingDragged ? value : ''}
              </div>
            );
          })}

          {drag && draggedTileValue !== null && (
            <div
              className="pointer-events-none fixed z-50 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-lg bg-amber-400 text-xl font-bold text-black shadow-xl shadow-black/50"
              style={{ left: drag.pointerX + drag.grabOffsetX, top: drag.pointerY + drag.grabOffsetY }}
            >
              {draggedTileValue}
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={reshuffle}
        className="shrink-0 rounded-full bg-white/10 px-5 py-2 text-sm font-medium text-white/80 transition-colors duration-200 hover:bg-white/20"
      >
        Shuffle
      </button>
    </div>
  );
}
