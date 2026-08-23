import { useEffect, useRef, useState, useCallback } from 'react';
import { Mic, Loader2, Play, Pause, Volume2, VolumeX, Youtube } from 'lucide-react';
import { Dwellable } from './Dwellable';
import type { AppDef } from './apps';

// FIX: headset mein physical keyboard nahi hota, so text-typing search
// use nahi ho sakta. Web Speech API (built into Chrome/Android WebView,
// koi extra key/cost nahi) se voice search implement kiya — user pinch
// karke mic dabata hai, bolta hai, aur wahi text query ban jaata hai.
type SpeechRecognitionResultLike = {
  results: { [index: number]: { [index: number]: { transcript: string } } };
};

function useVoiceSearch(onResult: (transcript: string) => void) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(true);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const w = window as any;
    const SpeechRecognitionCtor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setSupported(false);
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.lang = 'en-IN';

    recognition.onresult = (event: SpeechRecognitionResultLike) => {
      const transcript = event.results[0][0].transcript;
      onResult(transcript);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;

    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(() => {
    if (!recognitionRef.current || listening) return;
    try {
      setListening(true);
      recognitionRef.current.start();
    } catch {
      setListening(false);
    }
  }, [listening]);

  return { start, listening, supported };
}

type VideoResult = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
};

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

// FIX: naya home/landing screen — jab tak koi video select nahi hota,
// yehi dikhega. Pehle DEFAULT_VIDEO_ID fallback ki wajah se app open
// hote hi seedha ek hardcoded video play ho jaata tha.
//
// FIX 2: headset mein keyboard use nahi ho sakta, so text-typing hata
// ke voice search (mic button, pinch se activate) laga diya. Bolte hi
// transcript search query ban jaati hai aur turant search chal jaati hai.
function YoutubeHome({
  listening,
  supported,
  onMicPress,
  heardText,
}: {
  listening: boolean;
  supported: boolean;
  onMicPress: () => void;
  heardText: string;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-neutral-900 px-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/5">
        <Youtube className="h-8 w-8 text-red-500" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-white/80">
          {listening ? 'Listening...' : supported ? 'Tap mic and say what to search' : 'Voice search not supported'}
        </p>
        <p className="text-xs text-white/40 min-h-[1rem]">
          {heardText ? `"${heardText}"` : supported ? 'e.g. "cat videos"' : 'This browser has no speech recognition'}
        </p>
      </div>

      <Dwellable onSelect={onMicPress} disabled={!supported || listening}>
        <button
          type="button"
          onClick={onMicPress}
          disabled={!supported || listening}
          className={`flex h-16 w-16 items-center justify-center rounded-full transition-colors duration-200 disabled:opacity-40 ${
            listening ? 'bg-red-500 animate-pulse' : 'bg-teal-500 hover:bg-teal-400'
          }`}
        >
          <Mic className="h-7 w-7 text-black" />
        </button>
      </Dwellable>
    </div>
  );
}

export function YoutubeApp({ app }: { app: AppDef }) {
  const [results, setResults] = useState<VideoResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [heardText, setHeardText] = useState('');
  // FIX: ab null ka matlab hai "kuch bhi playing nahi" — home screen
  // dikhao. Pehle null → DEFAULT_VIDEO_ID pe fallback hota tha jo
  // auto-play ka root cause tha.
  const [playingVideoId, setPlayingVideoId] = useState<string | null>(null);

  // FIX: query ab direct parameter ke roop mein aati hai (voice
  // transcript se), state ke through nahi — isse "type hi nahi kar
  // sakte" wala poora text-input flow hata diya gaya.
  const runSearch = useCallback(async (rawQuery: string) => {
    const query = rawQuery.trim();
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
  }, []);

  const handleVoiceResult = useCallback(
    (transcript: string) => {
      setHeardText(transcript);
      runSearch(transcript);
    },
    [runSearch],
  );

  const { start: startListening, listening, supported } = useVoiceSearch(handleVoiceResult);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/5 px-3 py-2">
        {/* FIX: text input hata diya (koi keyboard nahi) — YouTube label
            ke saath ab mic button hai top bar mein bhi, taaki results/
            player screen se bhi seedha nayi voice search chala sakein. */}
        <span className="text-sm font-medium text-white/70">YouTube</span>
        <div className="flex-1" />
        {heardText && !loading && (
          <span className="max-w-[10rem] truncate text-[11px] text-white/40">"{heardText}"</span>
        )}
        <Dwellable onSelect={startListening} disabled={!supported || listening}>
          <button
            type="button"
            onClick={startListening}
            disabled={!supported || listening}
            aria-label="Voice search"
            className={`flex h-9 w-9 items-center justify-center rounded-full text-black transition-colors duration-200 disabled:opacity-40 ${
              listening ? 'bg-red-500 animate-pulse' : 'bg-teal-500 hover:bg-teal-400'
            }`}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
          </button>
        </Dwellable>
        {/* FIX: "Back to video" ab sirf tab dikhta hai jab koi video
            actually playing ho — nahi to "Back to video" dikhta tha
            even before user ne kabhi kuch play kiya ho. */}
        {results && playingVideoId && (
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
        ) : playingVideoId ? (
          <YoutubePlayer videoId={playingVideoId} key={playingVideoId} />
        ) : (
          <YoutubeHome
            listening={listening}
            supported={supported}
            onMicPress={startListening}
            heardText={heardText}
          />
        )}
      </div>
    </div>
  );
                }
