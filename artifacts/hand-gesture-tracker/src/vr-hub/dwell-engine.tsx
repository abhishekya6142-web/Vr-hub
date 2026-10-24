import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

// How long a pinch marker must sit over a target before it "clicks".
export const DWELL_MS = 450;
// Brief lockout after a select fires, so the same dwell doesn't immediately
// re-trigger while the user is still pinching in place.
const COOLDOWN_MS = 600;

// A held pinch must last this long before it can turn into a drag-scroll,
// so a quick pinch-and-release (icon/button select) never scrolls.
const DRAG_HOLD_MS = 300;
// ...and the marker must have moved at least this many px from where the
// pinch started, so a stationary held pinch (still dwelling on a target)
// doesn't get reinterpreted as a scroll.
const DRAG_MOVE_THRESHOLD_PX = 45;
// pinch-click mode mein scroll shuru karne ke liye hold ki zarurat nahi —
// bas itna sa vertical move (px). Click-vs-scroll ka faisla HandTracker ke
// click-delay window mein hota hai.
const PINCH_CLICK_DRAG_MOVE_PX = 24;
// Multiplier applied to the raw per-frame pointer delta before it's applied
// as a scroll offset. >1 makes scrolling feel more responsive than 1:1.
const SCROLL_SENSITIVITY = 1.6;

// SMOOTH SCROLL (naya): hand detection ~10-20 Hz par aata hai, isliye har
// report par seedha scrollBy karne se scroll 60Hz screen par jhatke se
// (stepwise) hota tha. Ab har report ka delta "pending" mein jama hota hai
// aur display frames (rAF) par exponential easing se dheere-dheere lagta
// hai. TAU = easing ka time-constant: chhota = tez response / thoda jhatka,
// bada = zyada smooth / thoda lag. 40-70 ke beech theek rehta hai.
const SCROLL_SMOOTH_TAU_MS = 55;
// rAF itni der se zyada na chale (jaise kuch XR modes mein) to smoothing
// chhod kar seedha scrollBy kar do — scroll kabhi atakna nahi chahiye.
const SCROLL_RAF_STALL_MS = 120;

// --- Index-finger point-and-swipe (panel switch) ---
// Ye gesture PINCH ke bina kaam karta hai — sirf index finger khula
// rakh ke usse left/right move karo, panels switch ho jaate hain.
const SWIPE_MIN_DISTANCE_PX = 120;
const SWIPE_MAX_TIME_MS = 600;
// Ek swipe trigger hone ke baad itni der tak dobara trigger nahi hoga.
const SWIPE_COOLDOWN_MS = 500;

// pinch-click mode mein do pinch-clicks ke beech minimum gap (noisy frame
// se enter->exit->enter ho jaaye to ek pinch do click na bane).
const PINCH_CLICK_DEBOUNCE_MS = 350;

export type PinchMarker = { x: number; y: number };
export type SwitchDirection = 'left' | 'right';

// Target kaise select hota hai.
//   'dwell'       — purana behavior: pinch marker target par DWELL_MS ruke to select.
//   'pinch-click' — dwell-select band. Select sirf activateAt() se hota hai
//                   (pinch ENTER par ek baar). Drag-scroll aur activeMarkers
//                   pehle jaise kaam karte hain.
export type SelectMode = 'dwell' | 'pinch-click';

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

// swipe-gesture ke liye chhota session tracker (horizontal, discrete trigger).
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
  // Raw, most-recent pinch marker positions (puzzle game jaise custom drag ke liye).
  activeMarkers: PinchMarker[];
  // index-finger (non-pinch) pointing positions — swipe-to-switch ke liye.
  reportPointMarkers: (markers: PinchMarker[]) => void;
  // Panels switch karne wala component (jaise VRHub ka row) yahan handler register karta hai.
  registerSwitchHandler: (handler: (direction: SwitchDirection) => void) => () => void;
  // select mode switch (dwell <-> pinch-click). Ref-based, koi re-render nahi.
  setSelectMode: (mode: SelectMode) => void;
  // Given screen point par jo registered target hai (sabse chhota containing
  // rect) use ek baar activate karta hai. Return: true agar kuch activate hua.
  activateAt: (point: PinchMarker) => boolean;
  // Activate kiye bina batata hai ki point par kaun sa target hai (hover feedback).
  peekTargetAt: (point: PinchMarker) => DOMRect | null;
};

const DwellContext = createContext<DwellContextValue | null>(null);

export function DwellProvider({ children }: { children: ReactNode }) {
  const targetsRef = useRef<Map<string, Target>>(new Map());
  const stateRef = useRef<Map<string, { progress: number; cooldownUntil: number }>>(new Map());
  const lastTimeRef = useRef<number>(performance.now());
  const lastSerializedRef = useRef<string>('{}');
  const [progress, setProgress] = useState<Record<string, number>>({});

  // select mode + pinch-click debounce state.
  const selectModeRef = useRef<SelectMode>('dwell');
  const lastPinchClickRef = useRef<number>(0);

  // The scrollable element belonging to whichever view is currently on screen.
  const scrollTargetRef = useRef<HTMLElement | null>(null);
  const sessionRef = useRef<PinchSession>({ ...IDLE_SESSION });
  const [scrollDrag, setScrollDrag] = useState<ScrollDragState>(IDLE_SCROLL_DRAG);
  const scrollDragRef = useRef<ScrollDragState>(IDLE_SCROLL_DRAG);

  const [activeMarkers, setActiveMarkers] = useState<PinchMarker[]>([]);
  const activeMarkersEmptyRef = useRef(true);

  // swipe-to-switch state.
  const pointSessionRef = useRef<PointSession>({ ...IDLE_POINT_SESSION });
  const swipeCooldownUntilRef = useRef<number>(0);
  const switchHandlerRef = useRef<((direction: SwitchDirection) => void) | null>(null);

  // --- Smooth scroll state ---
  const pendingScrollRef = useRef(0); // abhi tak lagna baaki scroll (px)
  const scrollRafRef = useRef<number | null>(null);
  const scrollRafScheduledAtRef = useRef(0);
  const lastScrollFrameTsRef = useRef(0);

  const runScrollFrame = useCallback(function run(ts: number): void {
    scrollRafRef.current = null;
    const last = lastScrollFrameTsRef.current || ts - 16;
    lastScrollFrameTsRef.current = ts;
    const dt = Math.min(64, Math.max(1, ts - last));

    const target = scrollTargetRef.current;
    const pending = pendingScrollRef.current;

    if (!target || Math.abs(pending) < 0.3) {
      // Bacha hua chhota hissa seedha laga do aur loop band.
      if (target && pending !== 0) target.scrollBy(0, pending);
      pendingScrollRef.current = 0;
      lastScrollFrameTsRef.current = 0;
      return;
    }

    const step = pending * (1 - Math.exp(-dt / SCROLL_SMOOTH_TAU_MS));
    pendingScrollRef.current = pending - step;
    target.scrollBy(0, step);

    scrollRafRef.current = requestAnimationFrame(run);
    scrollRafScheduledAtRef.current = performance.now();
  }, []);

  const queueScroll = useCallback(
    (deltaPx: number) => {
      pendingScrollRef.current += deltaPx;
      const now = performance.now();

      // rAF schedule hua padha hai par bahut der se chala nahi -> stall
      // (kuch XR modes mein hota hai): smoothing chhodo, seedha apply karo.
      if (scrollRafRef.current !== null && now - scrollRafScheduledAtRef.current > SCROLL_RAF_STALL_MS) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
        lastScrollFrameTsRef.current = 0;
        const target = scrollTargetRef.current;
        const pending = pendingScrollRef.current;
        pendingScrollRef.current = 0;
        if (target && pending !== 0) target.scrollBy(0, pending);
        return;
      }

      if (scrollRafRef.current === null) {
        scrollRafRef.current = requestAnimationFrame(runScrollFrame);
        scrollRafScheduledAtRef.current = now;
      }
    },
    [runScrollFrame],
  );

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

  // Scroll targets ka stack: sabse nayi registration active hoti hai, aur
  // cleanup par pichhli wapas active ho jaati hai.
  const scrollTargetsRef = useRef<HTMLElement[]>([]);
  const registerScrollTarget = useCallback((el: HTMLElement) => {
    const stack = scrollTargetsRef.current;
    const existing = stack.indexOf(el);
    if (existing !== -1) stack.splice(existing, 1);
    stack.push(el);
    scrollTargetRef.current = el;
    return () => {
      const s = scrollTargetsRef.current;
      const i = s.indexOf(el);
      if (i !== -1) s.splice(i, 1);
      scrollTargetRef.current = s.length > 0 ? s[s.length - 1] : null;
    };
  }, []);

  // switch-handler registration — ek single handler store karta hai.
  const registerSwitchHandler = useCallback((handler: (direction: SwitchDirection) => void) => {
    switchHandlerRef.current = handler;
    return () => {
      if (switchHandlerRef.current === handler) switchHandlerRef.current = null;
    };
  }, []);

  // select mode set karo. pinch-click mein jaate hi aadha dwell progress clear.
  const setSelectMode = useCallback((mode: SelectMode) => {
    selectModeRef.current = mode;
    if (mode === 'pinch-click') {
      stateRef.current.forEach((st) => {
        st.progress = 0;
      });
      if (lastSerializedRef.current !== '{}') {
        lastSerializedRef.current = '{}';
        setProgress({});
      }
    }
  }, []);

  // point ke neeche sabse specific (sabse chhota rect) enabled target.
  // Hidden (zero-size) rects kabhi hoverable nahi maane jaate.
  const findTargetAt = useCallback(
    (p: PinchMarker): { id: string; target: Target; rect: DOMRect } | null => {
      let bestId: string | null = null;
      let bestTarget: Target | null = null;
      let bestRect: DOMRect | null = null;
      let bestArea = Infinity;

      const entries = Array.from(targetsRef.current.entries());
      for (let i = 0; i < entries.length; i++) {
        const [id, target] = entries[i];
        if (target.disabled()) continue;
        const rect = target.getRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) continue;
        if (p.x < rect.left || p.x > rect.right || p.y < rect.top || p.y > rect.bottom) continue;
        const area = rect.width * rect.height;
        if (area < bestArea) {
          bestArea = area;
          bestId = id;
          bestTarget = target;
          bestRect = rect;
        }
      }

      if (!bestId || !bestTarget || !bestRect) return null;
      return { id: bestId, target: bestTarget, rect: bestRect };
    },
    [],
  );

  const peekTargetAt = useCallback(
    (point: PinchMarker): DOMRect | null => findTargetAt(point)?.rect ?? null,
    [findTargetAt],
  );

  const activateAt = useCallback(
    (point: PinchMarker): boolean => {
      const now = performance.now();
      if (now - lastPinchClickRef.current < PINCH_CLICK_DEBOUNCE_MS) return false;

      const hit = findTargetAt(point);
      if (!hit) return false; // koi valid target nahi — kuch activate nahi hoga

      const st = stateRef.current.get(hit.id) ?? { progress: 0, cooldownUntil: 0 };
      if (now < st.cooldownUntil) return false;

      st.progress = 0;
      st.cooldownUntil = now + COOLDOWN_MS;
      stateRef.current.set(hit.id, st);
      lastPinchClickRef.current = now;
      hit.target.onSelect();
      return true;
    },
    [findTargetAt],
  );

  // Non-pinching index-finger positions yahan aate hain. Horizontal
  // movement ko "swipe" ki tarah detect karta hai aur registered
  // switch-handler ko ek baar call karta hai jab threshold cross ho.
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

    // Cooldown ke dauran bhi reference point refresh karte raho, taaki
    // cooldown khatam hote hi swipe bilkul fresh se shuru ho.
    if (now < swipeCooldownUntilRef.current) {
      pointSessionRef.current = { active: true, startTime: now, startX: marker.x };
      return;
    }

    const elapsed = now - session.startTime;
    const dx = marker.x - session.startX;

    if (elapsed > SWIPE_MAX_TIME_MS) {
      // Bahut slow move tha — deliberate swipe nahi. Window reset.
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

      // MediaPipe ka frame-to-frame gap vary kar sakta hai (device load,
      // thermal state). Bade gap par dwell progress "jump" na kare, isliye
      // dt ko 100ms par clamp karte hain.
      dt = Math.min(dt, 100);

      // Khali -> khali par state update nahi hota (poora provider baar-baar
      // re-render na ho).
      if (markers.length > 0 || !activeMarkersEmptyRef.current) {
        activeMarkersEmptyRef.current = markers.length === 0;
        setActiveMarkers(markers);
      }

      // --- Pinch-hold drag-scroll detection ---
      // Sirf pehla pinch marker use hota hai.
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
          const instant = selectModeRef.current === 'pinch-click';
          const heldLongEnough = instant || now - session.startTime > DRAG_HOLD_MS;
          const movedEnough =
            Math.abs(marker.y - session.startY) > (instant ? PINCH_CLICK_DRAG_MOVE_PX : DRAG_MOVE_THRESHOLD_PX);
          if (heldLongEnough && movedEnough) session.dragMode = true;
        }

        if (session.dragMode) {
          // Seedha scrollBy nahi — pending mein jama, display frames par smooth apply.
          if (deltaY !== 0) queueScroll(-deltaY * SCROLL_SENSITIVITY);
          const direction: ScrollDragState['direction'] = deltaY < 0 ? 'up' : deltaY > 0 ? 'down' : scrollDragRef.current.direction;
          setScrollDragIfChanged({ active: true, direction });
        } else {
          setScrollDragIfChanged(IDLE_SCROLL_DRAG);
        }
      }

      // pinch-click mode mein dwell-select band hai — select sirf
      // activateAt() se (pinch ENTER par) hota hai. Drag-scroll upar
      // pehle jaisa chalta hai.
      if (selectModeRef.current === 'pinch-click') {
        if (lastSerializedRef.current !== '{}') {
          lastSerializedRef.current = '{}';
          setProgress({});
        }
        return;
      }

      // Drag-scroll ke dauran is frame ko "no pinch markers" maano, taaki
      // scroll karte waqt kisi icon/button par accidentally dwell na ho.
      const hitTestMarkers = sessionRef.current.dragMode ? [] : markers;

      const next: Record<string, number> = {};
      targetsRef.current.forEach((target, id) => {
        const st = stateRef.current.get(id) ?? { progress: 0, cooldownUntil: 0 };
        const disabled = target.disabled();
        const rect = disabled ? null : target.getRect();
        // Zero-size rect = hidden element (display: none) — kabhi hoverable nahi.
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
    [setScrollDragIfChanged, queueScroll],
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
        setSelectMode,
        activateAt,
        peekTargetAt,
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

// useDwellEngine ka non-throwing version — HandTracker jaise components ke
// liye jo DwellProvider ke bahar bhi mount ho sakte hain.
export function useOptionalDwellEngine() {
  return useContext(DwellContext);
      }
                                                   
