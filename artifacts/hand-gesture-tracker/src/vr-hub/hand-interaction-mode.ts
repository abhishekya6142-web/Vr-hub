// vr-hub/hand-interaction-mode.ts
//
// Hand-tracking interaction mode ka shared, persisted store.
//
//   'laser'  — Laser Pointer: haath se nikalti visible laser beam, beam
//              ka tip jis element par ho use pinch se activate karo.
//   'direct' — Direct Hand: koi laser nahi. Thumb/index ke beech ka
//              pinch-point hi cursor hai; jis element ke upar pinch
//              karo wahi activate hota hai.
//   'center' — Center Point + Pinch: screen ke bilkul beech ek fixed
//              reticle. Target reticle decide karta hai; pinch haath
//              kahin bhi ho, sirf activation gesture hai.
//
// Ye ek chhota module-level store hai (React Context nahi), taaki
// HandTracker ka per-frame loop mode ko ek ref se padh sake bina
// re-render ya re-init ke. Mode badalne par WebXR session, MediaPipe
// landmarker, RAF loop ya subscriptions kuch bhi restart nahi hota.

import { useEffect, useState } from 'react';

export type HandInteractionMode = 'laser' | 'direct' | 'center';

export const HAND_INTERACTION_MODES: {
  id: HandInteractionMode;
  label: string;
  description: string;
}[] = [
  { id: 'laser', label: 'Laser Pointer', description: 'Hand-controlled visible laser beam.' },
  { id: 'direct', label: 'Direct Hand', description: 'Interact without a visible laser.' },
  {
    id: 'center',
    label: 'Center Point + Pinch',
    description: 'Fixed center reticle; pinch anywhere to activate its current target.',
  },
];

const STORAGE_KEY = 'mvision.handInteractionMode';
const DEFAULT_MODE: HandInteractionMode = 'laser';

function isMode(v: unknown): v is HandInteractionMode {
  return v === 'laser' || v === 'direct' || v === 'center';
}

function readStored(): HandInteractionMode {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (isMode(v)) return v;
  } catch {
    // localStorage unavailable (private mode etc.) — default use karo.
  }
  return DEFAULT_MODE;
}

let current: HandInteractionMode = readStored();
const listeners = new Set<(mode: HandInteractionMode) => void>();

export function getHandInteractionMode(): HandInteractionMode {
  return current;
}

export function setHandInteractionMode(mode: HandInteractionMode) {
  if (mode === current) return;
  current = mode;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore
  }
  listeners.forEach((cb) => cb(mode));
}

export function subscribeHandInteractionMode(cb: (mode: HandInteractionMode) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// React hook — settings UI ke liye. HandTracker ka per-frame loop isse
// use NAHI karta (wo seedha subscribe karke ref update karta hai).
export function useHandInteractionMode(): [HandInteractionMode, (mode: HandInteractionMode) => void] {
  const [mode, setMode] = useState<HandInteractionMode>(current);
  useEffect(() => {
    setMode(current);
    return subscribeHandInteractionMode(setMode);
  }, []);
  return [mode, setHandInteractionMode];
}
