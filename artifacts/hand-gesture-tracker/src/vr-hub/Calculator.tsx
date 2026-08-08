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
  // Commas add karne ke liye formatter taaki image jaisa '1,545.67' dikhe
  const rounded = Math.round(n * 1e9) / 1e9;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 9 }).format(rounded);
}

export function Calculator() {
  const [display, setDisplay] = useState('0');
  const [prev, setPrev] = useState<number | null>(null);
  const [op, setOp] = useState<Op | null>(null);
  const [overwrite, setOverwrite] = useState(true);
  const [equation, setEquation] = useState<string>(''); // Upar choti history dikhane ke liye

  const { registerScrollTarget } = useDwellEngine();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    return registerScrollTarget(el);
  }, [registerScrollTarget]);

  // Raw display value nikalne ke liye kyuki string mein commas ho sakte hain
  const getRawValue = (str: string) => str.replace(/,/g, '');

  function inputDigit(d: string) {
    setDisplay((cur) => {
      const rawCur = getRawValue(cur);
      const newDisplay = overwrite ? d : rawCur === '0' ? d : rawCur + d;
      // Commas waapas lagane ke liye sirf number part format karenge, dot handle karte hue
      if (newDisplay.includes('.')) return newDisplay; 
      return formatResult(parseFloat(newDisplay));
    });
    setOverwrite(false);
  }

  function inputDot() {
    setDisplay((cur) => {
      if (overwrite) return '0.';
      return cur.includes('.') ? cur : `${cur}.`;
    });
    setOverwrite(false);
  }

  function backspace() {
    if (overwrite) return;
    setDisplay((cur) => {
      const raw = getRawValue(cur);
      const newRaw = raw.length > 1 ? raw.slice(0, -1) : '0';
      if (newRaw.endsWith('.')) return newRaw;
      return formatResult(parseFloat(newRaw));
    });
  }

  function chooseOp(nextOp: Op) {
    const current = parseFloat(getRawValue(display));
    if (prev !== null && op && !overwrite) {
      const result = compute(prev, current, op);
      setDisplay(formatResult(result));
      setPrev(result);
      setEquation(`${formatResult(result)} ${nextOp}`);
    } else {
      setPrev(current);
      setEquation(`${formatResult(current)} ${nextOp}`);
    }
    setOp(nextOp);
    setOverwrite(true);
  }

  function equals() {
    if (prev === null || !op) return;
    const current = parseFloat(getRawValue(display));
    const result = compute(prev, current, op);
    setEquation(`${formatResult(prev)} ${op} ${formatResult(current)} =`);
    setDisplay(formatResult(result));
    setPrev(null);
    setOp(null);
    setOverwrite(true);
  }

  function clearAll() {
    setDisplay('0');
    setPrev(null);
    setOp(null);
    setEquation('');
    setOverwrite(true);
  }

  function toggleSign() {
    setDisplay((cur) => (cur.startsWith('-') ? cur.slice(1) : cur === '0' ? cur : `-${cur}`));
  }

  function percent() {
    setDisplay((cur) => formatResult(parseFloat(getRawValue(cur)) / 100));
  }

  // Vision Pro image ke hisaab se 5 Columns aur 4 Rows wala Grid pattern
  const buttons: Array<{ label: string; onPress: () => void; kind?: 'op' | 'action' | 'default' }> = [
    // Row 1
    { label: '7', onPress: () => inputDigit('7') },
    { label: '8', onPress: () => inputDigit('8') },
    { label: '9', onPress: () => inputDigit('9') },
    { label: 'C', onPress: clearAll, kind: 'action' },
    { label: '÷', onPress: () => chooseOp('÷'), kind: 'op' },
    
    // Row 2
    { label: '4', onPress: () => inputDigit('4') },
    { label: '5', onPress: () => inputDigit('5') },
    { label: '6', onPress: () => inputDigit('6') },
    { label: '⌫', onPress: backspace, kind: 'action' },
    { label: '×', onPress: () => chooseOp('×'), kind: 'op' },

    // Row 3
    { label: '1', onPress: () => inputDigit('1') },
    { label: '2', onPress: () => inputDigit('2') },
    { label: '3', onPress: () => inputDigit('3') },
    { label: '%', onPress: percent, kind: 'action' },
    { label: '-', onPress: () => chooseOp('-'), kind: 'op' },

    // Row 4
    { label: '±', onPress: toggleSign, kind: 'action' },
    { label: '0', onPress: () => inputDigit('0') },
    { label: '.', onPress: inputDot },
    { label: '=', onPress: equals, kind: 'op' }, // Image mein '=' orange color ka hai
    { label: '+', onPress: () => chooseOp('+'), kind: 'op' },
  ];

    return (
    <div className="flex h-full w-full items-center justify-center p-3 sm:p-5">
      
      {/* 👇 YAHAN CHANGE KIYA HAI: bg-black/60, shadow aur extra blur hata diya taaki yeh parent ke glass ke sath blend ho jaye */}
      <div 
        ref={scrollRef} 
        className="flex h-full w-full max-w-[750px] flex-col gap-2 sm:gap-4 overflow-hidden p-2 sm:p-4"
      >
        
        {/* Top Display Screen */}
        <div className="flex shrink-0 min-h-[60px] sm:min-h-[80px] flex-col items-end justify-end px-2">
          <span className="mb-1 text-xs sm:text-sm font-medium tracking-wide text-white/50">
            {equation || '\u00A0'}
          </span>
          <span className="text-right font-sans text-4xl sm:text-5xl font-light tracking-tight text-white leading-none">
            {display}
          </span>
        </div>

        {/* 5x4 Button Grid */}
        <div className="grid flex-1 grid-cols-5 gap-2 sm:gap-3 mt-2">
          {buttons.map((btn, idx) => (
            <Dwellable key={idx} onSelect={btn.onPress} className="h-full w-full">
              <button
                type="button"
                onClick={btn.onPress}
                className={`flex h-full w-full items-center justify-center rounded-xl sm:rounded-2xl text-xl sm:text-2xl font-normal transition-all duration-200 active:scale-95 ${
                  btn.kind === 'op'
                    ? 'bg-orange-500/90 text-white shadow-[0_0_15px_rgba(249,115,22,0.3)] hover:bg-orange-400'
                    : btn.kind === 'action'
                      ? 'bg-white/20 text-white hover:bg-white/30 backdrop-blur-md' // Action buttons pe thoda glass effect
                      : 'bg-white/10 text-white hover:bg-white/20 backdrop-blur-md' // Number buttons pe thoda glass effect
                }`}
              >
                {btn.label}
              </button>
            </Dwellable>
          ))}
        </div>
      </div>
    </div>
  );
}
