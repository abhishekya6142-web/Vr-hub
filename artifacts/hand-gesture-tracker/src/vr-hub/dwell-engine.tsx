import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

// How long a pinch marker must sit over a target before it "clicks".
export const DWELL_MS = 1000;
// Brief lockout after a select fires, so the same dwell doesn't immediately
// re-trigger while the user is still pinching in place.
const COOLDOWN_MS = 700;

// A held pinch must last this long before it can turn into a drag-scroll,
// so a quick pinch-and-release (icon/button select) never scrolls.
const DRAG_HOLD_MS = 300;
// ...and the marker must have moved at least this many px from where the
// pinch started, so a stationary held pinch (still dwelling on a target)
// doesn't get reinterpreted as a scroll.
const DRAG_MOVE_THRESHOLD_PX = 15;
// Multiplier applied to the raw per-frame pointer delta before it's applied
// as a scroll offset. >1 makes scrolling feel more responsive than a 1:1
// hand-movement-to-pixel mapping.
const SCROLL_SENSITIVITY = 1.6;

export type PinchMarker = { x: number; y: number };

export type ScrollDragState = {
  active: boolean;
  direction: 'up' | 'down' | null;
};

const IDLE_SCROLL_DRAG: ScrollDragState = { active: false, direction: null };

type Target = {
  id: string;
  getRect: () => DOMRect | null;
  onSelect: () => void;
  disabled: () => boolean;
};

type PinchSession = {
  active: boolean;
  startTime: number;
  startY: number;
  lastY: number;
  dragMode: boolean;
};

const IDLE_SESSION: PinchSession = { active: false, startTime: 0, startY: 0, lastY: 0, dragMode: false };

type DwellContextValue = {
  register: (target: Target) => () => void;
  progress: Record<string, number>;
  reportMarkers: (markers: PinchMarker[]) => void;
  registerScrollTarget: (el: HTMLElement) => () => void;
  scrollDrag: ScrollDragState;
};

const DwellContext = createContext<DwellContextValue | null>(null);

export function DwellProvider({ children }: { children: ReactNode }) {
  const targetsRef = useRef<Map<string, Target>>(new Map());
  const stateRef = useRef<Map<string, { progress: number; cooldownUntil: number }>>(new Map());
  const lastTimeRef = useRef<number>(performance.now());
  const lastSerializedRef = useRef<string>('{}');
  const [progress, setProgress] = useState<Record<string, number>>({});

  // The scrollable element belonging to whichever view is currently on
  // screen (home screen grid or the open app's content). Only one view is
  // ever mounted at a time, so a single ref is enough.
  const scrollTargetRef = useRef<HTMLElement | null>(null);
  const sessionRef = useRef<PinchSession>({ ...IDLE_SESSION });
  const [scrollDrag, setScrollDrag] = useState<ScrollDragState>(IDLE_SCROLL_DRAG);
  const scrollDragRef = useRef<ScrollDragState>(IDLE_SCROLL_DRAG);

  const setScrollDragIfChanged = useCallback((next: ScrollDragState) => {
    const prev = scrollDragRef.current;
    if (prev.active !== next.active || prev.direction !== next.direction) {
      scrollDragRef.current = next;
      setScrollDrag(next);
    }
  }, []);

  const register = useCallback((target: Target) => {
    targetsRef.current.set(target.id, target);
    return () => {
      targetsRef.current.delete(target.id);
      stateRef.current.delete(target.id);
    };
  }, []);

  const registerScrollTarget = useCallback((el: HTMLElement) => {
    scrollTargetRef.current = el;
    return () => {
      if (scrollTargetRef.current === el) scrollTargetRef.current = null;
    };
  }, []);

  const reportMarkers = useCallback(
    (markers: PinchMarker[]) => {
      const now = performance.now();
      const dt = now - lastTimeRef.current;
      lastTimeRef.current = now;

      // --- Pinch-hold drag-scroll detection ---
      // Uses the first pinch marker only; a second hand doesn't affect
      // scrolling. Runs before the dwell hit-test below so dwell can be
      // suspended for the frames where a drag is actually happening.
      const marker = markers[0] ?? null;
      const session = sessionRef.current;

      if (!marker) {
        if (session.active) sessionRef.current = { ...IDLE_SESSION };
        setScrollDragIfChanged(IDLE_SCROLL_DRAG);
      } else if (!session.active) {
        sessionRef.current = { active: true, startTime: now, startY: marker.y, lastY: marker.y, dragMode: false };
      } else {
        const deltaY = marker.y - session.lastY;
        session.lastY = marker.y;

        if (!session.dragMode) {
          const heldLongEnough = now - session.startTime > DRAG_HOLD_MS;
          const movedEnough = Math.abs(marker.y - session.startY) > DRAG_MOVE_THRESHOLD_PX;
          if (heldLongEnough && movedEnough) session.dragMode = true;
        }

        if (session.dragMode) {
          const target = scrollTargetRef.current;
          if (target && deltaY !== 0) {
            target.scrollBy(0, -deltaY * SCROLL_SENSITIVITY);
          }
          const direction: ScrollDragState['direction'] = deltaY < 0 ? 'up' : deltaY > 0 ? 'down' : scrollDragRef.current.direction;
          setScrollDragIfChanged({ active: true, direction });
        } else {
          setScrollDragIfChanged(IDLE_SCROLL_DRAG);
        }
      }

      // While a drag-scroll is in progress, treat this frame as having no
      // pinch markers for hit-testing purposes, so passing over an icon or
      // button while scrolling can't accidentally start/continue a dwell.
      const hitTestMarkers = sessionRef.current.dragMode ? [] : markers;

      const next: Record<string, number> = {};
      targetsRef.current.forEach((target, id) => {
        const st = stateRef.current.get(id) ?? { progress: 0, cooldownUntil: 0 };
        const disabled = target.disabled();
        const rect = disabled ? null : target.getRect();
        // A zero-size rect means the element is hidden (e.g. `display: none`
        // while real-world mode hides the OS UI) — never treat that as
        // hoverable, even if a marker coordinate coincidentally lands on
        // its collapsed (0,0) origin.
        const hovered =
          !!rect &&
          rect.width > 0 &&
          rect.height > 0 &&
          hitTestMarkers.some(
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
    },
    [setScrollDragIfChanged],
  );

  return (
    <DwellContext.Provider
      value={{ register, progress, reportMarkers, registerScrollTarget, scrollDrag }}
    >
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
