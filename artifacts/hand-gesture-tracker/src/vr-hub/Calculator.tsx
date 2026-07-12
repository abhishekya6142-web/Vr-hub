import { useEffect, useRef, useState } from 'react';
import { Dwellable } from './Dwellable';
import { useDwellEngine } from './dwell-engine';

type Op = '+' | '-' | '×' | '÷';

function compute(a: number, b: number, op: Op): number {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '×':
      return a * b;
    case '÷':
      return b === 0 ? NaN : a / b;
  }
}

function formatResult(n: number): string {
  if (!Number.isFinite(n)) return 'Error';
  const rounded = Math.round(n * 1e9) / 1e9;
  return String(rounded);
}

export function Calculator() {
  const [display, setDisplay] = useState('0');
  const [prev, setPrev] = useState<number | null>(null);
  const [op, setOp] = useState<Op | null>(null);
  const [overwrite, setOverwrite] = useState(true);

  const { registerScrollTarget } = useDwellEngine();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Registers this window's content as the active pinch-drag-scroll target
  // while the calculator is open, so a held-pinch drag scrolls it if its
  // content ever overflows (e.g. very small/landscape-constrained windows).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    return registerScrollTarget(el);
  }, [registerScrollTarget]);

  function inputDigit(d: string) {
    setDisplay((cur) => (overwrite ? d : cur === '0' ? d : cur + d));
    setOverwrite(false);
  }

  function inputDot() {
    setDisplay((cur) => {
      if (overwrite) return '0.';
      return cur.includes('.') ? cur : `${cur}.`;
    });
    setOverwrite(false);
  }

  function chooseOp(nextOp: Op) {
    const current = parseFloat(display);
    if (prev !== null && op && !overwrite) {
      const result = compute(prev, current, op);
      setDisplay(formatResult(result));
      setPrev(result);
    } else {
      setPrev(current);
    }
    setOp(nextOp);
    setOverwrite(true);
  }

  function equals() {
    if (prev === null || !op) return;
    const current = parseFloat(display);
    const result = compute(prev, current, op);
    setDisplay(formatResult(result));
    setPrev(null);
    setOp(null);
    setOverwrite(true);
  }

  function clearAll() {
    setDisplay('0');
    setPrev(null);
    setOp(null);
    setOverwrite(true);
  }

  function toggleSign() {
    setDisplay((cur) => (cur.startsWith('-') ? cur.slice(1) : cur === '0' ? cur : `-${cur}`));
  }

  function percent() {
    setDisplay((cur) => formatResult(parseFloat(cur) / 100));
  }

  const buttons: Array<{ label: string; onPress: () => void; kind?: 'op' | 'accent' | 'default' }> = [
    { label: 'C', onPress: clearAll, kind: 'op' },
    { label: '±', onPress: toggleSign, kind: 'op' },
    { label: '%', onPress: percent, kind: 'op' },
    { label: '÷', onPress: () => chooseOp('÷'), kind: 'op' },
    { label: '7', onPress: () => inputDigit('7') },
    { label: '8', onPress: () => inputDigit('8') },
    { label: '9', onPress: () => inputDigit('9') },
    { label: '×', onPress: () => chooseOp('×'), kind: 'op' },
    { label: '4', onPress: () => inputDigit('4') },
    { label: '5', onPress: () => inputDigit('5') },
    { label: '6', onPress: () => inputDigit('6') },
    { label: '-', onPress: () => chooseOp('-'), kind: 'op' },
    { label: '1', onPress: () => inputDigit('1') },
    { label: '2', onPress: () => inputDigit('2') },
    { label: '3', onPress: () => inputDigit('3') },
    { label: '+', onPress: () => chooseOp('+'), kind: 'op' },
    { label: '0', onPress: () => inputDigit('0') },
    { label: '.', onPress: inputDot },
    { label: '=', onPress: equals, kind: 'accent' },
  ];

  return (
    <div ref={scrollRef} className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div className="flex min-h-[72px] items-end justify-end rounded-xl bg-black/40 px-4 py-3">
        <span className="truncate font-mono text-3xl font-semibold text-white">{display}</span>
      </div>
      <div className="grid flex-1 grid-cols-4 gap-2">
        {buttons.map((btn) => (
          <Dwellable key={btn.label} onSelect={btn.onPress} className="h-full w-full">
            <button
              type="button"
              onClick={btn.onPress}
              className={`h-full w-full rounded-xl text-lg font-semibold transition-colors duration-200 active:scale-95 ${
                btn.kind === 'accent'
                  ? 'col-span-2 bg-teal-500 text-black hover:bg-teal-400'
                  : btn.kind === 'op'
                    ? 'bg-white/10 text-teal-300 hover:bg-white/20'
                    : 'bg-white/5 text-white hover:bg-white/15'
              }`}
            >
              {btn.label}
            </button>
          </Dwellable>
        ))}
      </div>
    </div>
  );
}
