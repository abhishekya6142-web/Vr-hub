import { useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { Dwellable } from './Dwellable';
import { IframeApp } from './IframeApp';
import type { AppDef } from './apps';

type VideoResult = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
};

const DEFAULT_VIDEO_ID = 'dQw4w9WgXcQ'; // a famously always-embeddable official video
const API_KEY = import.meta.env.VITE_YOUTUBE_API_KEY as string | undefined;

export function YoutubeApp({ app }: { app: AppDef }) {
  const [inputValue, setInputValue] = useState('');
  const [results, setResults] = useState<VideoResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playingVideoId, setPlayingVideoId] = useState<string | null>(null);

  const runSearch = async () => {
    const query = inputValue.trim();
    if (!query) return;

    if (!API_KEY) {
      setError('No YouTube API key configured (VITE_YOUTUBE_API_KEY).');
      return;
    }

    setLoading(true);
    setError(null);
    setPlayingVideoId(null);

    try {
      const url = new URL('https://www.googleapis.com/youtube/v3/search');
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('type', 'video');
      url.searchParams.set('maxResults', '12');
      url.searchParams.set('q', query);
      url.searchParams.set('key', API_KEY);

      const res = await fetch(url.toString());
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message || `YouTube API error (${res.status})`);
      }
      const data = await res.json();

      const videos: VideoResult[] = (data.items || [])
        .filter((item: any) => item.id?.videoId)
        .map((item: any) => ({
          videoId: item.id.videoId,
          title: item.snippet.title,
          channelTitle: item.snippet.channelTitle,
          thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
        }));

      setResults(videos);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  };

  const activeVideoId = playingVideoId ?? DEFAULT_VIDEO_ID;
  const playerApp: AppDef = {
    ...app,
    url: `https://www.youtube.com/embed/${activeVideoId}`,
  };

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/5 px-3 py-2">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch();
          }}
          placeholder="Search YouTube..."
          className="flex-1 rounded-full bg-white/10 px-4 py-2 text-sm text-white placeholder:text-white/40 outline-none ring-1 ring-white/10 focus:ring-teal-400/60"
        />
        <Dwellable onSelect={runSearch}>
          <button
            type="button"
            onClick={runSearch}
            aria-label="Search"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-teal-500 text-black transition-colors duration-200 hover:bg-teal-400"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          </button>
        </Dwellable>
        {results && (
          <Dwellable onSelect={() => setResults(null)}>
            <button
              type="button"
              onClick={() => setResults(null)}
              className="whitespace-nowrap rounded-full bg-white/10 px-3 py-2 text-xs text-white/70 transition-colors duration-200 hover:bg-white/20"
            >
              Back to video
            </button>
          </Dwellable>
        )}
      </div>

      <div className="flex-1 overflow-hidden">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 bg-neutral-900 px-8 text-center">
            <p className="max-w-sm text-sm text-white/70">{error}</p>
            <Dwellable onSelect={() => setError(null)}>
              <button
                type="button"
                onClick={() => setError(null)}
                className="text-xs text-white/50 underline underline-offset-2 hover:text-white/70"
              >
                Dismiss
              </button>
            </Dwellable>
          </div>
        ) : results ? (
          <div className="grid h-full grid-cols-2 gap-3 overflow-y-auto p-3 sm:grid-cols-3">
            {results.map((video) => (
              <Dwellable
                key={video.videoId}
                className="flex-col"
                onSelect={() => {
                  setPlayingVideoId(video.videoId);
                  setResults(null);
                }}
              >
                <div className="flex flex-col overflow-hidden rounded-lg bg-white/5 transition-transform duration-200">
                  <img
                    src={video.thumbnailUrl}
                    alt={video.title}
                    className="aspect-video w-full object-cover"
                  />
                  <div className="flex flex-col gap-0.5 p-2">
                    <span className="line-clamp-2 text-xs font-medium leading-snug text-white/90">
                      {video.title}
                    </span>
                    <span className="text-[10px] text-white/50">{video.channelTitle}</span>
                  </div>
                </div>
              </Dwellable>
            ))}
          </div>
        ) : (
          <IframeApp app={playerApp} key={playerApp.url} />
        )}
      </div>
    </div>
  );
}
