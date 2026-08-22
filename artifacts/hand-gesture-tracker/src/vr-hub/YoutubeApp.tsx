import { useEffect, useRef, useState, useCallback } from 'react';
import { Search, Loader2, Play, Pause, Volume2, VolumeX } from 'lucide-react';
import { Dwellable } from './Dwellable';
import type { AppDef } from './apps';

type VideoResult = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
};

const DEFAULT_VIDEO_ID = 'dQw4w9WgXcQ';
const API_KEY = import.meta.env.VITE_YOUTUBE_API_KEY as string | undefined;

let ytApiPromise: Promise<void> | null = null;
function loadYouTubeIframeApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  const w = window as any;
  if (w.YT && w.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise((resolve) => {
    const previousCallback = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      previousCallback?.();
      resolve();
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(script);
  });
  return ytApiPromise;
}

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.floor(totalSeconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function YoutubePlayer({ videoId }: { videoId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const pollRef = useRef<number | null>(null);

  const [ready, setReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // FIX (video chhota/squished dikh raha tha, black bars side mein):
  // YouTube IFrame API by default player ko FIXED 640x390px pe banata
  // hai — apne parent container ko "fill" karne ki koshish nahi karta
  // khud se. Isliye player ready hone ke baad, aur jab bhi container ka
  // size badle (ResizeObserver se), hum explicitly player.setSize() call
  // karte hain container ke actual current width/height ke saath — ye
  // YouTube API ka apna official tareeka hai player ko resize karne ka.
  const syncPlayerSize = useCallback(() => {
    const container = containerRef.current;
    const player = playerRef.current;
    if (!container || !player?.setSize) return;
    const { clientWidth, clientHeight } = container;
    if (clientWidth > 0 && clientHeight > 0) {
      player.setSize(clientWidth, clientHeight);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    loadYouTubeIframeApi().then(() => {
      if (cancelled || !containerRef.current) return;
      const w = window as any;

      playerRef.current = new w.YT.Player(containerRef.current, {
        videoId,
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          rel: 0,
          modestbranding: 1,
          controls: 0,
          disablekb: 1,
        },
        events: {
          onReady: () => {
            if (cancelled) return;
            setReady(true);
            setDuration(playerRef.current?.getDuration?.() ?? 0);
            // FIX: player bante hi container ka actual size de do,
            // default 640x390 pe mat rehne do.
            syncPlayerSize();
          },
          onStateChange: (event: any) => {
            if (cancelled) return;
            const w2 = window as any;
            setIsPlaying(event.data === w2.YT.PlayerState.PLAYING);
          },
        },
      });
    });

    return () => {
      cancelled = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
      try {
        playerRef.current?.destroy?.();
      } catch {
        // ignore
      }
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // FIX: panel ka size AR mein depth/distance ke hisaab se badal sakta
  // hai (ya window resize ho sakta hai) — ResizeObserver se container
  // ke size-change ko track karke player ko har baar re-sync karte hain,
  // taaki video hamesha poora container fill kare.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => syncPlayerSize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [syncPlayerSize]);

  useEffect(() => {
    if (!ready) return;
    pollRef.current = window.setInterval(() => {
      const player = playerRef.current;
      if (!player?.getCurrentTime) return;
      setCurrentTime(player.getCurrentTime());
      const d = player.getDuration?.();
      if (d && d !== duration) setDuration(d);
    }, 400);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const togglePlay = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (isPlaying) player.pauseVideo();
    else player.playVideo();
  }, [isPlaying]);

  const toggleMute = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (isMuted) {
      player.unMute();
      setIsMuted(false);
    } else {
      player.mute();
      setIsMuted(true);
    }
  }, [isMuted]);

  const seekBy = useCallback((deltaSeconds: number) => {
    const player = playerRef.current;
    if (!player?.getCurrentTime) return;
    const next = Math.max(0, Math.min(duration || Infinity, player.getCurrentTime() + deltaSeconds));
    player.seekTo(next, true);
    setCurrentTime(next);
  }, [duration]);

  const seekToFraction = useCallback((fraction: number) => {
    const player = playerRef.current;
    if (!player?.seekTo || !duration) return;
    const next = Math.max(0, Math.min(duration, duration * fraction));
    player.seekTo(next, true);
    setCurrentTime(next);
  }, [duration]);

  const progressFraction = duration > 0 ? currentTime / duration : 0;

  return (
    <div className="flex h-full w-full flex-col bg-black">
      <div className="relative flex-1 overflow-hidden">
        {/* FIX: containerRef ab explicitly absolute+inset-0 hai (pehle
            sirf h-full w-full tha, jo kaafi nahi tha kyunki YT Player
            khud apna default-sized iframe andar inject karta hai —
            setSize() call ke saath ye ab poora fill karta hai). */}
        <div ref={containerRef} className="absolute inset-0 h-full w-full" />
      </div>

      <div className="flex flex-col gap-2 border-t border-white/10 bg-neutral-900 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="w-10 shrink-0 text-[11px] tabular-nums text-white/60">
            {formatTime(currentTime)}
          </span>
          <div className="relative flex h-6 flex-1 items-center gap-[2px]">
            {Array.from({ length: 20 }).map((_, i) => {
              const segFraction = (i + 0.5) / 20;
              const filled = segFraction <= progressFraction;
              return (
                <Dwellable key={i} onSelect={() => seekToFraction((i + 0.5) / 20)} className="h-full flex-1">
                  <div
                    className={`h-1.5 w-full rounded-full transition-colors duration-150 ${
                      filled ? 'bg-teal-400' : 'bg-white/15'
                    }`}
                  />
                </Dwellable>
              );
            })}
          </div>
          <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-white/60">
            {formatTime(duration)}
          </span>
        </div>

        <div className="flex items-center justify-center gap-3">
          <Dwellable onSelect={() => seekBy(-10)}>
            <button
              type="button"
              className="rounded-full bg-white/10 px-3 py-2 text-xs font-medium text-white/80 transition-colors duration-200 hover:bg-white/20"
            >
              -10s
            </button>
          </Dwellable>

          <Dwellable onSelect={togglePlay} disabled={!ready}>
            <button
              type="button"
              className="flex h-11 w-11 items-center justify-center rounded-full bg-teal-500 text-black transition-colors duration-200 hover:bg-teal-400 disabled:opacity-40"
              disabled={!ready}
            >
              {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 pl-0.5" />}
            </button>
          </Dwellable>

          <Dwellable onSelect={() => seekBy(10)}>
            <button
              type="button"
              className="rounded-full bg-white/10 px-3 py-2 text-xs font-medium text-white/80 transition-colors duration-200 hover:bg-white/20"
            >
              +10s
            </button>
          </Dwellable>

          <Dwellable onSelect={toggleMute}>
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors duration-200 hover:bg-white/20"
            >
              {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
          </Dwellable>
        </div>
      </div>
    </div>
  );
}

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
          <YoutubePlayer videoId={activeVideoId} key={activeVideoId} />
        )}
      </div>
    </div>
  );
      }
               
