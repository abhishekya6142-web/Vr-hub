import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

// How long a pinch marker must sit over a target before it "clicks".
export const DWELL_MS = 1000;
// Brief lockout after a select fires, so the same dwell doesn't immediately
// re-trigger while the user is still pinching in place.
const COOLDOWN_MS = 700;

export type PinchMarker = { x: number; y: number };

type Target = {
  id: string;
  getRect: () => DOMRect | null;
  onSelect: () => void;
  disabled: () => boolean;
};

type DwellContextValue = {
  register: (target: Target) => () => void;
  progress: Record<string, number>;
  reportMarkers: (markers: PinchMarker[]) => void;
};

const DwellContext = createContext<DwellContextValue | null>(null);

export function DwellProvider({ children }: { children: ReactNode }) {
  const targetsRef = useRef<Map<string, Target>>(new Map());
  const stateRef = useRef<Map<string, { progress: number; cooldownUntil: number }>>(new Map());
  const lastTimeRef = useRef<number>(performance.now());
  const lastSerializedRef = useRef<string>('{}');
  const [progress, setProgress] = useState<Record<string, number>>({});

  const register = useCallback((target: Target) => {
    targetsRef.current.set(target.id, target);
    return () => {
      targetsRef.current.delete(target.id);
      stateRef.current.delete(target.id);
    };
  }, []);

  const reportMarkers = useCallback((markers: PinchMarker[]) => {
    const now = performance.now();
    const dt = now - lastTimeRef.current;
    lastTimeRef.current = now;

    const next: Record<string, number> = {};
    targetsRef.current.forEach((target, id) => {
      const st = stateRef.current.get(id) ?? { progress: 0, cooldownUntil: 0 };
      const disabled = target.disabled();
      const rect = disabled ? null : target.getRect();
      const hovered =
        !!rect &&
        markers.some(
          (m) => m.x >= rect.left && m.x <= rect.right && m.y >= rect.top && m.y <= rect.bottom,
        );

      if (now < st.cooldownUntil) {
        st.progress = 0;
      } else if (hovered) {
        st.progress = Math.min(1, st.progress + dt / DWELL_MS);
        if (st.progress >= 1) {
          st.progress = 0;
          st.cooldownUntil = now + COOLDOWN_MS;
          target.onSelect();
        }
      } else {
        st.progress = 0;
      }

      stateRef.current.set(id, st);
      if (st.progress > 0) next[id] = Math.round(st.progress * 100) / 100;
    });

    const serialized = JSON.stringify(next);
    if (serialized !== lastSerializedRef.current) {
      lastSerializedRef.current = serialized;
      setProgress(next);
    }
  }, []);

  return (
    <DwellContext.Provider value={{ register, progress, reportMarkers }}>
      {children}
    </DwellContext.Provider>
  );
}

export function useDwellEngine() {
  const ctx = useContext(DwellContext);
  if (!ctx) {
    throw new Error('useDwellEngine must be used within a DwellProvider');
  }
  return ctx;
}
