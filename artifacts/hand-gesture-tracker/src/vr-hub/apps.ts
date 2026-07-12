export type AppId = 'search' | 'youtube' | 'calendar' | 'calculator';

export type AppDef = {
  id: AppId;
  name: string;
  type: 'iframe' | 'calculator';
  url?: string;
  externalUrl?: string;
  gradient: string;
};

export const APPS: AppDef[] = [
  {
    id: 'search',
    name: 'Google Search',
    type: 'iframe',
    url: 'https://www.google.com/search?igu=1&q=hello',
    externalUrl: 'https://www.google.com/',
    gradient: 'from-sky-400 to-blue-600',
  },
  {
    id: 'youtube',
    name: 'YouTube',
    // YouTube deprecated the `listType=search` embed trick, so arbitrary
    // text search can't be embedded without the YouTube Data API (which
    // needs an API key). Default view plays a fixed embeddable video;
    // searching opens real YouTube search results in a new tab. See
    // YoutubeApp.tsx.
    type: 'iframe',
    url: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    externalUrl: 'https://www.youtube.com/',
    gradient: 'from-red-500 to-rose-700',
  },
  {
    id: 'calendar',
    name: 'Calendar',
    type: 'iframe',
    url: 'https://calendar.google.com/calendar/embed?mode=WEEK',
    externalUrl: 'https://calendar.google.com/',
    gradient: 'from-emerald-400 to-teal-600',
  },
  {
    id: 'calculator',
    name: 'Calculator',
    type: 'calculator',
    gradient: 'from-neutral-500 to-neutral-800',
  },
];

export function getApp(id: AppId): AppDef {
  const app = APPS.find((a) => a.id === id);
  if (!app) throw new Error(`Unknown app id: ${id}`);
  return app;
}
