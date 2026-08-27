import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

// How long a pinch marker must sit over a target before it "clicks".
// FIX: 1000ms se 700ms — user ko icon par itni der tak hath rok kar
// nahi rakhna padega, click jaldi register hoga.
export const DWELL_MS = 450;
// Brief lockout after a select fires, so the same dwell doesn't immediately
// re-trigger while the user is still pinching in place.
const COOLDOWN_MS = 600;

// A held pinch must last this long before it can turn into a drag-scroll,
// so a quick pinch-and-release (icon/button select) never scrolls.
const DRAG_HOLD_MS = 300;
// ...and the marker must have moved at least this many px from where the
// pinch started, so a stationary held pinch (still dwelling on a target)
// doesn't get reinterpreted as a scroll. Raised from 15 to 45 — natural
// hand tremor while dwelling on a button was crossing the old threshold
// and cancelling the dwell-select before it could complete.
const DRAG_MOVE_THRESHOLD_PX = 45;
// Multiplier applied to the raw per-frame pointer delta before it's applied
// as a scroll offset. >1 makes scrolling feel more responsive than a 1:1
// hand-movement-to-pixel mapping.
const SCROLL_SENSITIVITY = 1.6;

// --- NAYA: Index-finger point-and-swipe (panel switch) ---
// Ye gesture PINCH ke bina kaam karta hai — sirf index finger khula
// rakh ke usse left/right move karo, panels switch ho jaate hain.
//
// Swipe count hone ke liye finger apni starting position se itni door
// (px mein) itne time ke andar move hona chahiye — isse ek "deliberate"
// swipe motion ban jaata hai, dheere-dheere drift nahi.
const SWIPE_MIN_DISTANCE_PX = 120;
const SWIPE_MAX_TIME_MS = 600;
// Ek swipe trigger hone ke baad itni der tak dobara trigger nahi hoga,
// taaki ek hi haath ki motion se baar-baar switch na ho jaaye.
const SWIPE_COOLDOWN_MS = 500;

export type PinchMarker = { x: number; y: number };
export type SwitchDirection = 'left' | 'right';

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

// NAYA: swipe-gesture ke liye ek chhota session tracker, pinch-session
// jaisa hi pattern, bas horizontal aur "discrete trigger" (continuous
// drag nahi, ek "switch" ek baar mein).
type PointSession = {
  active: boolean;
  startTime: number;
  startX: number;
};

const IDLE_POINT_SESSION: PointSession = { active: false, startTime: 0, startX: 0 };

type DwellContextValue = {
  register: (target: Target) => () => void;
  progress: Record<string, number>;
  reportMarkers: (markers: PinchMarker[]) => void;
  registerScrollTarget: (el: HTMLElement) => () => void;
  scrollDrag: ScrollDragState;
  // Exposes the raw, most-recent pinch marker positions so components that
  // need custom drag behavior (like the puzzle game) can read pinch
  // location directly, instead of only reacting to dwell-select hits.
  activeMarkers: PinchMarker[];
  // NAYA: index-finger (non-pinch) pointing positions — swipe-to-switch
  // gesture ke liye.
  reportPointMarkers: (markers: PinchMarker[]) => void;
  // NAYA: jo component panels switch karna chahta hai (jaise VRHub ka
  // horizontal row), wo yahan apna handler register karega. Sirf ek
  // handler active rehta hai ek time par (jaisa registerScrollTarget
  // ke saath hota hai).
  registerSwitchHandler: (handler: (direction: SwitchDirection) => void) => () => void;
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

  const [activeMarkers, setActiveMarkers] = useState<PinchMarker[]>([]);

  // NAYA: swipe-to-switch state.
  const pointSessionRef = useRef<PointSession>({ ...IDLE_POINT_SESSION });
  const swipeCooldownUntilRef = useRef<number>(0);
  const switchHandlerRef = useRef<((direction: SwitchDirection) => void) | null>(null);

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

  // NAYA: switch-handler registration — jaisa registerScrollTarget karta
  // hai, waise hi ek single handler store karta hai.
  const registerSwitchHandler = useCallback((handler: (direction: SwitchDirection) => void) => {
    switchHandlerRef.current = handler;
    return () => {
      if (switchHandlerRef.current === handler) switchHandlerRef.current = null;
    };
  }, []);

  // NAYA: har frame ke non-pinching index-finger positions yahan aate
  // hain. Horizontal movement ko "swipe" ki tarah detect karta hai aur
  // registered switch-handler ko ek baar call karta hai jab threshold
  // cross ho.
  const reportPointMarkers = useCallback((markers: PinchMarker[]) => {
    const now = performance.now();
    const marker = markers[0] ?? null;
    const session = pointSessionRef.current;

    if (!marker) {
      if (session.active) pointSessionRef.current = { ...IDLE_POINT_SESSION };
      return;
    }

    if (!session.active) {
      pointSessionRef.current = { active: true, startTime: now, startX: marker.x };
      return;
    }

    // Cooldown ke dauran bhi reference point ko refresh karte raho, taaki
    // cooldown khatam hote hi swipe bilkul fresh se (0 se) shuru ho —
    // purani dx carry-forward na ho aur turant dobara trigger na ho jaaye.
    if (now < swipeCooldownUntilRef.current) {
      pointSessionRef.current = { active: true, startTime: now, startX: marker.x };
      return;
    }

    const elapsed = now - session.startTime;
    const dx = marker.x - session.startX;

    if (elapsed > SWIPE_MAX_TIME_MS) {
      // Bahut slow move tha — deliberate swipe nahi maana. Window ko
      // yahin se reset karke dobara track shuru karo.
      pointSessionRef.current = { active: true, startTime: now, startX: marker.x };
      return;
    }

    if (Math.abs(dx) >= SWIPE_MIN_DISTANCE_PX) {
      const direction: SwitchDirection = dx > 0 ? 'right' : 'left';
      switchHandlerRef.current?.(direction);
      swipeCooldownUntilRef.current = now + SWIPE_COOLDOWN_MS;
      pointSessionRef.current = { active: true, startTime: now, startX: marker.x };
    }
  }, []);

  const reportMarkers = useCallback(
    (markers: PinchMarker[]) => {
      const now = performance.now();
      let dt = now - lastTimeRef.current;
      lastTimeRef.current = now;

      // FIX (robustness — variable-frequency MediaPipe source): pehle
      // reportMarkers ~20-30fps par kaafi regular interval se call
      // hota tha (XR-frame-bound). Ab MediaPipe processing ek
      // independent async loop se aata hai jiska frame-to-frame gap
      // vary kar sakta hai (device load, thermal state, etc. ke
      // hisaab se ~20-100ms tak). Agar kisi wajah se ek bada gap aa
      // jaaye (jaise background tab switch, GC pause, ya MediaPipe
      // khud ek frame slow ho), to bina clamp ke dt bahut bada ho
      // sakta hai — jisse dwell progress ek hi update mein 0 se 1 tak
      // "jump" kar sakta hai (achanak-click) ya ulta bahut lamba gap
      // dwell ko bhi tod sakta hai. 100ms se zyada dt ko 100ms tak
      // clamp karte hain — DWELL_MS=450 ke against ye kaafi chhota
      // hissa hai (~22%), toh single-frame jump ka risk khatam ho
      // jaata hai bina normal dwell feel ko change kiye.
      dt = Math.min(dt, 100);

      setActiveMarkers(markers);

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
      value={{
        register,
        progress,
        reportMarkers,
        registerScrollTarget,
        scrollDrag,
        activeMarkers,
        reportPointMarkers,
        registerSwitchHandler,
      }}
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
