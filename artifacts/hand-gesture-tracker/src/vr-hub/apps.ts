export type AppId = 'search' | 'youtube' | 'calendar' | 'calculator' | 'theatre' | 'games' | 'compass';

export type WindowPreset = {
  width: number; // vw
  height: number; // vh
  minWidth: number; // vw
  minHeight: number; // vh
  maxWidth: number; // vw
  maxHeight: number; // vh
  preferredDistance: number;
  parallaxAmount: number;
  openAnimation: 'scaleUp' | 'scaleUpCinematic' | 'scaleUpCompact';
};

export type AppDef = {
  id: AppId;
  name: string;
  // NAYA: 'voiceSearch' — hand-tracking ke liye keyboard-free search
  // (mic se bolke query lo, phir results iframe mein dikhao).
  type: 'iframe' | 'calculator' | 'theatre' | 'games' | 'compass' | 'voiceSearch';
  url?: string;
  externalUrl?: string;
  gradient: string;
  windowPreset: WindowPreset;
};

const DEFAULT_PRESET: WindowPreset = {
  width: 68,
  height: 92,
  minWidth: 45,
  minHeight: 60,
  maxWidth: 88,
  maxHeight: 95,
  preferredDistance: 2,
  parallaxAmount: 1,
  openAnimation: 'scaleUp',
};

export const APPS: AppDef[] = [
  {
    id: 'search',
    name: 'Google Search',
    // FIX: 'iframe' se 'voiceSearch' — Google ka search box hand-tracking
    // se type nahi ho sakta, isliye ab mic-based voice input use hota
    // hai. url/externalUrl waise hi rehne diye (VoiceSearch apna khud ka
    // igu=1 wala URL banata hai spoken query se).
    type: 'voiceSearch',
    url: 'https://www.google.com/search?igu=1&q=hello',
    externalUrl: 'https://www.google.com/',
    gradient: 'from-sky-400 to-blue-600',
    windowPreset: {
      width: 72,
      height: 105,
      minWidth: 50,
      minHeight: 65,
      maxWidth: 90,
      maxHeight: 106,
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
    // FIX: panel "chhota/unprofessional" lag raha tha — width/height
    // ko max ke bahut close le gaye (96/88, jabki maxWidth/maxHeight
    // 98/94 hai) taaki floating YouTube panel bade screen jaisa lage.
    // preferredDistance thoda kam kiya (3 -> 2.4) taaki bada panel bhi
    // aankhon se zyada door na feel ho.
    windowPreset: {
      width: 96,
      height: 88,
      minWidth: 60,
      minHeight: 50,
      maxWidth: 98,
      maxHeight: 94,
      preferredDistance: 2.4,
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
      width: 68,
      height: 90,
      minWidth: 48,
      minHeight: 60,
      maxWidth: 85,
      maxHeight: 94,
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
      width: 75,
      height: 105,
      minWidth: 65,
      minHeight: 50,
      maxWidth: 85,
      maxHeight: 75,
      preferredDistance: 1.5,
      parallaxAmount: 1.2,
      openAnimation: 'scaleUp',
    },
  },
  {
    id: 'theatre',
    name: 'Theatre',
    type: 'theatre',
    gradient: 'from-purple-500 to-indigo-700',
    windowPreset: {
      width: 85,
      height: 82,
      minWidth: 55,
      minHeight: 50,
      maxWidth: 95,
      maxHeight: 92,
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
      width: 78,
      height: 88,
      minWidth: 55,
      minHeight: 65,
      maxWidth: 90,
      maxHeight: 94,
      preferredDistance: 2,
      parallaxAmount: 1,
      openAnimation: 'scaleUpCompact',
    },
  },
  {
    id: 'compass',
    name: 'Compass',
    type: 'compass',
    gradient: 'from-cyan-400 to-blue-700',
    windowPreset: {
      width: 85,
      height: 85,
      minWidth: 60,
      minHeight: 55,
      maxWidth: 95,
      maxHeight: 92,
      preferredDistance: 2.5,
      parallaxAmount: 0.8,
      openAnimation: 'scaleUpCinematic',
    },
  },
];

export function getApp(id: AppId): AppDef {
  const app = APPS.find((a) => a.id === id);
  if (!app) throw new Error(`Unknown app id: ${id}`);
  return app;
}

export function getWindowPreset(app: AppDef): WindowPreset {
  return app.windowPreset ?? DEFAULT_PRESET;
}
