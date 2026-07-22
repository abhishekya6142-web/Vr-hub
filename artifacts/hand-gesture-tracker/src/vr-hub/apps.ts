export type AppId = 'search' | 'youtube' | 'calendar' | 'calculator' | 'theatre' | 'games';

// Har app ka apna floating-monitor preset — size, depth, parallax strength,
// aur opening animation variant. Naya app add karna ab sirf ek APPS entry
// hai; koi VRHub/AppWindow layout code chhedne ki zaroorat nahi.
export type WindowPreset = {
  // vw/vh units me — VRHub ke row layout ke saath consistent rehne ke liye
  width: number; // vw
  height: number; // vh
  minWidth: number; // vw
  minHeight: number; // vh
  maxWidth: number; // vw
  maxHeight: number; // vh
  // Preferred depth — jitna zyada, utna "door" panel (kam parallax).
  // 1 = sabse paas (zyada parallax), 3 = sabse door (kam parallax).
  preferredDistance: number;
  // SpatialAnchor transform pe multiplier — 1 = normal, <1 = kam movement (door),
  // >1 = zyada movement (paas).
  parallaxAmount: number;
  openAnimation: 'scaleUp' | 'scaleUpCinematic' | 'scaleUpCompact';
};

export type AppDef = {
  id: AppId;
  name: string;
  type: 'iframe' | 'calculator' | 'theatre' | 'games';
  url?: string;
  externalUrl?: string;
  gradient: string;
  windowPreset: WindowPreset;
};

// Default preset — agar kabhi kisi naye app me windowPreset dena bhool jayein,
// to getWindowPreset() isی pe fallback karega instead of crashing.
// Height ~50%, width ~18% badhayi gayi hai (pehle 62/50) taaki content
// (grids, iframes) ko squeeze na hona pade.
const DEFAULT_PRESET: WindowPreset = {
  width: 59,
  height: 88,
  minWidth: 40,
  minHeight: 55,
  maxWidth: 80,
  maxHeight: 92,
  preferredDistance: 2,
  parallaxAmount: 1,
  openAnimation: 'scaleUp',
};

export const APPS: AppDef[] = [
  {
    id: 'search',
    name: 'Google Search',
    type: 'iframe',
    url: 'https://www.google.com/search?igu=1&q=hello',
    externalUrl: 'https://www.google.com/',
    gradient: 'from-sky-400 to-blue-600',
    windowPreset: {
      width: 65,
      height: 95,
      minWidth: 45,
      minHeight: 62,
      maxWidth: 82,
      maxHeight: 95,
      preferredDistance: 2,
      parallaxAmount: 1,
      openAnimation: 'scaleUp',
    },
  },
  {
    id: 'youtube',
    name: 'YouTube',
    type: 'iframe',
    url: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    externalUrl: 'https://www.youtube.com/',
    gradient: 'from-red-500 to-rose-700',
    windowPreset: {
      // Large cinematic 16:9 — height/width dono badhaye, viewport ke andar
      width: 77,
      height: 72,
      minWidth: 50,
      minHeight: 45,
      maxWidth: 88,
      maxHeight: 85,
      preferredDistance: 3, // farthest — cinema screen feel, subtle movement
      parallaxAmount: 0.6,
      openAnimation: 'scaleUpCinematic',
    },
  },
  {
    id: 'calendar',
    name: 'Calendar',
    type: 'iframe',
    url: 'https://calendar.google.com/calendar/embed?mode=WEEK',
    externalUrl: 'https://calendar.google.com/',
    gradient: 'from-emerald-400 to-teal-600',
    windowPreset: {
      // Medium — ab pehle se kaafi zyada usable
      width: 57,
      height: 82,
      minWidth: 40,
      minHeight: 55,
      maxWidth: 75,
      maxHeight: 90,
      preferredDistance: 2,
      parallaxAmount: 1,
      openAnimation: 'scaleUp',
    },
  },
  {
    id: 'calculator',
    name: 'Calculator',
    type: 'calculator',
    gradient: 'from-neutral-500 to-neutral-800',
    windowPreset: {
      // Large portrait — easy to tap, ab zyada vertical space bhi
      width: 40,
      height: 92,
      minWidth: 30,
      minHeight: 65,
      maxWidth: 50,
      maxHeight: 95,
      preferredDistance: 1, // nearest — reachable, strong parallax
      parallaxAmount: 1.3,
      openAnimation: 'scaleUpCompact',
    },
  },
  {
    id: 'theatre',
    name: 'Theatre',
    type: 'theatre',
    gradient: 'from-purple-500 to-indigo-700',
    windowPreset: {
      width: 73,
      height: 74,
      minWidth: 50,
      minHeight: 48,
      maxWidth: 88,
      maxHeight: 88,
      preferredDistance: 3,
      parallaxAmount: 0.6,
      openAnimation: 'scaleUpCinematic',
    },
  },
  {
    id: 'games',
    name: 'Games',
    type: 'games',
    gradient: 'from-amber-400 to-orange-600',
    windowPreset: {
      // Medium square — height kaafi badhayi taaki 15 Puzzle grid pura
      // aaram se fit ho, koi squeeze na ho
      width: 59,
      height: 88,
      minWidth: 44,
      minHeight: 60,
      maxWidth: 73,
      maxHeight: 92,
      preferredDistance: 2,
      parallaxAmount: 1,
      openAnimation: 'scaleUpCompact',
    },
  },
];

export function getApp(id: AppId): AppDef {
  const app = APPS.find((a) => a.id === id);
  if (!app) throw new Error(`Unknown app id: ${id}`);
  return app;
}

// Backward-compat helper — kahin bhi agar windowPreset missing mile (jaise
// kisi naye app me define karna bhool gaye), to crash karne ke bajaye
// DEFAULT_PRESET pe fallback karta hai.
export function getWindowPreset(app: AppDef): WindowPreset {
  return app.windowPreset ?? DEFAULT_PRESET;
}
