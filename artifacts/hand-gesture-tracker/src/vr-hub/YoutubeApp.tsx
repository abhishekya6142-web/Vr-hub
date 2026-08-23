import { useEffect, useRef, useState, useCallback } from 'react';
import { Mic, Loader2, Play, Pause, Volume2, VolumeX, Youtube, GripVertical } from 'lucide-react';
import { Dwellable } from './Dwellable';
import { useDwellEngine } from './dwell-engine';
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

      <div className="flex flex-col gap-4 border-t border-white/10 bg-neutral-900 px-8 py-6">
        <div className="flex items-center gap-4">
          <span className="w-16 shrink-0 text-lg tabular-nums text-white/60">
            {formatTime(currentTime)}
          </span>
          <div className="relative flex h-8 flex-1 items-center gap-1">
            {Array.from({ length: 20 }).map((_, i) => {
              const segFraction = (i + 0.5) / 20;
              const filled = segFraction <= progressFraction;
              return (
                <Dwellable key={i} onSelect={() => seekToFraction((i + 0.5) / 20)} className="h-full flex-1">
                  <div
                    className={`h-2.5 w-full rounded-full transition-colors duration-150 ${
                      filled ? 'bg-teal-400' : 'bg-white/15'
                    }`}
                  />
                </Dwellable>
              );
            })}
          </div>
          <span className="w-16 shrink-0 text-right text-lg tabular-nums text-white/60">
            {formatTime(duration)}
          </span>
        </div>

        <div className="flex items-center justify-center gap-6">
          <Dwellable onSelect={() => seekBy(-10)}>
            <button
              type="button"
              className="rounded-full bg-white/10 px-6 py-4 text-lg font-medium text-white/80 transition-colors duration-200 hover:bg-white/20"
            >
              -10s
            </button>
          </Dwellable>

          <Dwellable onSelect={togglePlay} disabled={!ready}>
            <button
              type="button"
              className="flex h-20 w-20 items-center justify-center rounded-full bg-teal-500 text-black transition-colors duration-200 hover:bg-teal-400 disabled:opacity-40"
              disabled={!ready}
            >
              {isPlaying ? <Pause className="h-9 w-9" /> : <Play className="h-9 w-9 pl-1" />}
            </button>
          </Dwellable>

          <Dwellable onSelect={() => seekBy(10)}>
            <button
              type="button"
              className="rounded-full bg-white/10 px-6 py-4 text-lg font-medium text-white/80 transition-colors duration-200 hover:bg-white/20"
            >
              +10s
            </button>
          </Dwellable>

          <Dwellable onSelect={toggleMute}>
            <button
              type="button"
              className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors duration-200 hover:bg-white/20"
            >
              {isMuted ? <VolumeX className="h-7 w-7" /> : <Volume2 className="h-7 w-7" />}
            </button>
          </Dwellable>
        </div>
      </div>
    </div>
  );
}

// FIX: home screen ab shuru mein hi trending/popular videos ka grid
// dikhata hai (YouTube Data API ke chart=mostPopular endpoint se) — koi
// login/account nahi chahiye, general public trending content hai. Voice
// search mic top-bar mein chhota rehta hai search ke liye. Purana
// mic-first landing screen hata diya gaya.
function YoutubeHome({
  onSelectVideo,
}: {
  onSelectVideo: (videoId: string) => void;
}) {
  const [trending, setTrending] = useState<VideoResult[] | null>(null);
  const [trendingError, setTrendingError] = useState<string | null>(null);
  const { registerScrollTarget } = useDwellEngine();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchTrending() {
      if (!API_KEY) {
        setTrendingError('No YouTube API key configured (VITE_YOUTUBE_API_KEY).');
        return;
      }
      try {
        const url = new URL('https://www.googleapis.com/youtube/v3/videos');
        url.searchParams.set('part', 'snippet');
        url.searchParams.set('chart', 'mostPopular');
        url.searchParams.set('maxResults', '16');
        url.searchParams.set('regionCode', 'IN');
        url.searchParams.set('key', API_KEY);

        const res = await fetch(url.toString());
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error?.message || `YouTube API error (${res.status})`);
        }
        const data = await res.json();
        if (cancelled) return;

        const videos: VideoResult[] = (data.items || [])
          .filter((item: any) => item.id)
          .map((item: any) => ({
            videoId: item.id,
            title: item.snippet.title,
            channelTitle: item.snippet.channelTitle,
            thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
          }));
        setTrending(videos);
      } catch (err) {
        if (!cancelled) setTrendingError(err instanceof Error ? err.message : 'Failed to load trending videos.');
      }
    }

    fetchTrending();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    return registerScrollTarget(el);
  }, [registerScrollTarget]);

  if (trendingError) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-transparent px-8 text-center">
        <p className="max-w-lg text-xl text-white/70">{trendingError}</p>
      </div>
    );
  }

  if (!trending) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-transparent">
        <Loader2 className="h-10 w-10 animate-spin text-white/40" />
        <p className="text-lg text-white/50">Loading trending videos...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div ref={scrollRef} className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto p-3 sm:grid-cols-4">
        {trending.map((video) => (
          <div key={video.videoId} className="flex flex-col overflow-hidden rounded-lg bg-white/5 transition-transform duration-200">
            <Dwellable onSelect={() => onSelectVideo(video.videoId)} className="w-full">
              <img
                src={video.thumbnailUrl}
                alt={video.title}
                className="aspect-video w-full object-cover"
              />
            </Dwellable>
            <div className="flex flex-col gap-0.5 p-2">
              <span className="line-clamp-2 text-xs font-medium leading-snug text-white/90">
                {video.title}
              </span>
              <span className="text-[10px] text-white/50">{video.channelTitle}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Scroll-only rail, jaisa results grid mein hai — click nahi
          karta, sirf pinch-hold-drag se list scroll hoti hai. */}
      <div className="flex w-12 shrink-0 flex-col items-center justify-center gap-2 border-l border-white/10 bg-white/5">
        <GripVertical className="h-5 w-5 text-white/25" />
        <span className="text-[9px] uppercase tracking-wide text-white/25 [writing-mode:vertical-rl]">
          Scroll
        </span>
      </div>
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
  // FIX: video player pe hote waqt "Back to results" ka koi button hi
  // nahi tha (purana button ki condition results && playingVideoId
  // kabhi ek saath true hoti hi nahi thi, kyunki video khulte hi results
  // null ho jaate the). Last search ke results yahan alag se yaad rakhte
  // hain taaki player screen se wapas usi list pe ja saken.
  const [lastResults, setLastResults] = useState<VideoResult[] | null>(null);

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
      setLastResults(videos);
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

  // FIX: pinch-hold-drag se results grid scroll ho sake, isliye grid ko
  // dwell-engine ke scroll-target ke roop mein register kiya (jaisa
  // VRHub apne horizontal panel-row ke liye karta hai). Ek time pe sirf
  // ek hi scroll-target active rehta hai, so jab tak ye grid dikh rahi
  // hai, VRHub ka apna row-scroll temporarily is grid ke liye override
  // ho jaata hai — yehi chahiye tha, kyunki ek time pe user sirf ek hi
  // cheez scroll karega.
  const { registerScrollTarget } = useDwellEngine();
  const gridScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!results) return;
    const el = gridScrollRef.current;
    if (!el) return;
    return registerScrollTarget(el);
  }, [results, registerScrollTarget]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-3 border-b border-white/10 bg-white/5 px-6 py-4">
        {/* FIX: text input hata diya (koi keyboard nahi) — YouTube label
            ke saath ab mic button hai top bar mein bhi, taaki results/
            player screen se bhi seedha nayi voice search chala sakein. */}
        <span className="text-2xl font-medium text-white/70">YouTube</span>
        <div className="flex-1" />
        {heardText && !loading && (
          <span className="max-w-[16rem] truncate text-lg text-white/40">"{heardText}"</span>
        )}
        <Dwellable onSelect={startListening} disabled={!supported || listening}>
          <button
            type="button"
            onClick={startListening}
            disabled={!supported || listening}
            aria-label="Voice search"
            className={`flex h-16 w-16 items-center justify-center rounded-full text-black transition-colors duration-200 disabled:opacity-40 ${
              listening ? 'bg-red-500 animate-pulse' : 'bg-teal-500 hover:bg-teal-400'
            }`}
          >
            {loading ? <Loader2 className="h-7 w-7 animate-spin" /> : <Mic className="h-7 w-7" />}
          </button>
        </Dwellable>
        {/* FIX: video player pe "Back to results" — ab sahi condition
            (playingVideoId + lastResults maujood) use karta hai, taaki
            player screen se wapas last-searched list pe ja saken. */}
        {playingVideoId && lastResults && (
          <Dwellable onSelect={() => { setPlayingVideoId(null); setResults(lastResults); }}>
            <button
              type="button"
              onClick={() => { setPlayingVideoId(null); setResults(lastResults); }}
              className="whitespace-nowrap rounded-full bg-white/10 px-5 py-3 text-lg text-white/70 transition-colors duration-200 hover:bg-white/20"
            >
              Back to results
            </button>
            </Dwellable>
        )}
      </div>

      <div className="flex-1 overflow-hidden">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-6 bg-transparent px-8 text-center">
            <p className="max-w-lg text-xl text-white/70">{error}</p>
            <Dwellable onSelect={() => setError(null)}>
              <button
                type="button"
                onClick={() => setError(null)}
                className="text-lg text-white/50 underline underline-offset-2 hover:text-white/70"
              >
                Dismiss
              </button>
            </Dwellable>
          </div>
        ) : results ? (
          <div className="flex h-full">
            {/* FIX: results grid ko dwell-engine scroll-target se
                register kiya (upar) taaki pinch-hold-drag se scroll ho
                sake. Iske saath ek dedicated scroll-rail (khaali strip,
                koi thumbnail nahi) right side pe rakha — laser/pinch
                yahan le jaake sirf up/down drag karne se scroll hoga,
                bina kisi video ko galti se select kiye. */}
            <div ref={gridScrollRef} className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto p-3 sm:grid-cols-4">
              {results.map((video) => (
                <div key={video.videoId} className="flex flex-col overflow-hidden rounded-lg bg-white/5 transition-transform duration-200">
                  {/* FIX: Dwellable hitbox ab sirf thumbnail image tak
                      simit hai (title/channel-name area ke bina), taaki
                      card ke bade combined area par scroll-drag shuru
                      karte hi galti se video select na ho jaye — sirf
                      thumbnail ke upar dwell karne se hi select hoga. */}
                  <Dwellable
                    onSelect={() => {
                      setPlayingVideoId(video.videoId);
                      setResults(null);
                    }}
                    className="w-full"
                  >
                    <img
                      src={video.thumbnailUrl}
                      alt={video.title}
                      className="aspect-video w-full object-cover"
                    />
                  </Dwellable>
                  <div className="flex flex-col gap-0.5 p-2">
                    <span className="line-clamp-2 text-xs font-medium leading-snug text-white/90">
                      {video.title}
                    </span>
                    <span className="text-[10px] text-white/50">{video.channelTitle}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Scroll-only rail — click/select nahi karta, sirf pinch-hold
                karke isके andar upar/neeche drag karo to grid scroll hogi
                (dwell-engine ka drag-scroll pura panel-width pe kaam
                karta hai jab tak koi Dwellable target hover na ho, so
                yahan koi Dwellable nahi rakha — isliye ye zone hamesha
                "safe" hai, kabhi galti se click nahi hoga). */}
            <div className="flex w-12 shrink-0 flex-col items-center justify-center gap-2 border-l border-white/10 bg-white/5">
              <GripVertical className="h-5 w-5 text-white/25" />
              <span className="text-[9px] uppercase tracking-wide text-white/25 [writing-mode:vertical-rl]">
                Scroll
              </span>
            </div>
          </div>
        ) : playingVideoId ? (
          <YoutubePlayer videoId={playingVideoId} key={playingVideoId} />
        ) : (
          <YoutubeHome onSelectVideo={(id) => setPlayingVideoId(id)} />
        )}
      </div>
    </div>
  );
}
    
