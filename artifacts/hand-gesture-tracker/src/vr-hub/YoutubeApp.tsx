import { useEffect, useRef, useState, useCallback } from 'react';
import { Mic, Loader2, Play, Pause, Volume2, VolumeX, GripVertical, ArrowLeft } from 'lucide-react';
import { Dwellable } from './Dwellable';
import { useDwellEngine } from './dwell-engine';
import type { AppDef } from './apps';

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
  }, [onResult]);

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
  durationSec?: number;
  isShortCandidate?: boolean;
};

// Videos with duration <=180 seconds are treated as Short CANDIDATES using a duration-based heuristic because YouTube Data API does not expose an official Shorts boolean.
function parseYouTubeDuration(iso: string | undefined): number {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

function isShortCandidateDuration(seconds: number): boolean {
  return seconds > 0 && seconds <= 180;
}

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

function YoutubePlayer({ videoId, isShort, onBack }: { videoId: string; isShort: boolean; onBack: () => void }) {
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

  const resizeDebounceRef = useRef<number | null>(null);
  const debouncedSyncPlayerSize = useCallback(() => {
    if (resizeDebounceRef.current) window.clearTimeout(resizeDebounceRef.current);
    resizeDebounceRef.current = window.setTimeout(() => {
      syncPlayerSize();
    }, 150);
  }, [syncPlayerSize]);

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
      if (resizeDebounceRef.current) window.clearTimeout(resizeDebounceRef.current);
      try {
        playerRef.current?.destroy?.();
      } catch {
        // ignore
      }
      playerRef.current = null;
    };
  }, [videoId, syncPlayerSize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => debouncedSyncPlayerSize());
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (resizeDebounceRef.current) window.clearTimeout(resizeDebounceRef.current);
    };
  }, [debouncedSyncPlayerSize]);

  useEffect(() => {
    if (!ready) return;
    pollRef.current = window.setInterval(() => {
      const player = playerRef.current;
      if (!player?.getCurrentTime) return;
      setCurrentTime(player.getCurrentTime());
      const d = player.getDuration?.();
      if (d && d !== duration) setDuration(d);
    }, 1000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [ready, duration]);

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
    <div className="relative flex h-full w-full flex-col bg-black">
      {/* LARGE SPATIAL BACK BUTTON OVERLAY */}
      <div className="absolute left-6 top-6 z-50">
        <Dwellable onSelect={onBack}>
          <button
            type="button"
            className="group flex h-24 w-24 items-center justify-center rounded-full bg-black/50 border border-white/20 backdrop-blur transition-all hover:bg-black/80 hover:scale-105"
            aria-label="Back"
          >
            <ArrowLeft className="h-10 w-10 text-white" />
          </button>
        </Dwellable>
      </div>

      {/* PLAYER CONTAINER */}
      <div
        className="relative flex flex-1 items-center justify-center overflow-hidden bg-neutral-950"
        style={{ willChange: 'transform', transform: 'translateZ(0)' }}
      >
        <div
          ref={containerRef}
          className={isShort ? "aspect-[9/16] h-full max-w-full" : "absolute inset-0 h-full w-full"}
        />
        
        {/* MASSIVE SPATIAL PLAY BUTTON TO UNLOCK AUTOPLAY BLOCKS */}
        {ready && !isPlaying && (
          <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-black/20">
            <Dwellable onSelect={togglePlay} className="pointer-events-auto">
              <button
                type="button"
                className="flex h-32 w-32 items-center justify-center rounded-full bg-teal-500/95 text-black shadow-2xl transition-transform hover:scale-110 hover:bg-teal-400"
              >
                <Play className="h-16 w-16 pl-2" />
              </button>
            </Dwellable>
          </div>
        )}
      </div>

      {/* LARGE SPATIAL CONTROL BAR */}
      <div className="flex flex-col gap-6 border-t border-white/10 bg-neutral-900 px-10 py-8">
        <div className="flex items-center gap-6">
          <span className="w-20 shrink-0 text-xl font-medium tabular-nums text-white/60">
            {formatTime(currentTime)}
          </span>
          <div className="relative flex flex-1 items-center gap-1">
            {Array.from({ length: 20 }).map((_, i) => {
              const segFraction = (i + 0.5) / 20;
              const filled = segFraction <= progressFraction;
              return (
                <Dwellable key={i} onSelect={() => seekToFraction((i + 0.5) / 20)} className="flex h-24 flex-1 cursor-pointer items-center justify-center">
                  <div
                    className={`h-3 w-full rounded-full transition-colors duration-150 ${
                      filled ? 'bg-teal-400' : 'bg-white/15'
                    }`}
                  />
                </Dwellable>
              );
            })}
          </div>
          <span className="w-20 shrink-0 text-right text-xl font-medium tabular-nums text-white/60">
            {formatTime(duration)}
          </span>
        </div>

        <div className="flex items-center justify-center gap-10">
          <Dwellable onSelect={() => seekBy(-10)}>
            <button
              type="button"
              className="flex h-24 w-24 items-center justify-center rounded-full bg-white/10 text-xl font-bold text-white/80 transition-colors duration-200 hover:bg-white/20"
            >
              -10s
            </button>
          </Dwellable>

          <Dwellable onSelect={togglePlay} disabled={!ready}>
            <button
              type="button"
              className="flex h-28 w-28 items-center justify-center rounded-full bg-teal-500 text-black transition-colors duration-200 hover:bg-teal-400 disabled:opacity-40"
              disabled={!ready}
            >
              {isPlaying ? <Pause className="h-12 w-12" /> : <Play className="h-12 w-12 pl-2" />}
            </button>
          </Dwellable>

          <Dwellable onSelect={() => seekBy(10)}>
            <button
              type="button"
              className="flex h-24 w-24 items-center justify-center rounded-full bg-white/10 text-xl font-bold text-white/80 transition-colors duration-200 hover:bg-white/20"
            >
              +10s
            </button>
          </Dwellable>

          <Dwellable onSelect={toggleMute}>
            <button
              type="button"
              className="flex h-24 w-24 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors duration-200 hover:bg-white/20"
            >
              {isMuted ? <VolumeX className="h-10 w-10" /> : <Volume2 className="h-10 w-10" />}
            </button>
          </Dwellable>
        </div>
      </div>
    </div>
  );
}

function YoutubeHome({ onSelectVideo }: { onSelectVideo: (video: { id: string, isShort: boolean }) => void }) {
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
        url.searchParams.set('part', 'snippet,contentDetails');
        url.searchParams.set('chart', 'mostPopular');
        url.searchParams.set('maxResults', '24');
        url.searchParams.set('regionCode', 'IN');
        url.searchParams.set('key', API_KEY);

        const res = await fetch(url.toString());
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error?.message || `YouTube API error (${res.status})`);
        }
        const data = await res.json();
        if (cancelled) return;

        // Videos with duration <=180 seconds are treated as Short CANDIDATES using a duration-based heuristic because YouTube Data API does not expose an official Shorts boolean.
        const videos: VideoResult[] = (data.items || [])
          .filter((item: any) => item.id)
          .map((item: any) => {
            const durationSec = parseYouTubeDuration(item.contentDetails?.duration);
            return {
              videoId: item.id,
              title: item.snippet.title,
              channelTitle: item.snippet.channelTitle,
              thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
              durationSec,
              isShortCandidate: isShortCandidateDuration(durationSec),
            };
          })
          .filter((v: VideoResult) => !v.isShortCandidate);

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
  }, [registerScrollTarget, trending]);

  if (trendingError) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-transparent px-8 text-center">
        <p className="max-w-lg text-2xl text-white/70">{trendingError}</p>
      </div>
    );
  }

  if (!trending) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-6 bg-transparent">
        <Loader2 className="h-16 w-16 animate-spin text-white/40" />
        <p className="text-xl text-white/50">Loading trending videos...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div ref={scrollRef} className="grid flex-1 grid-cols-2 gap-6 overflow-y-auto p-6 sm:grid-cols-3 xl:grid-cols-4">
        {trending.map((video) => (
          <div key={video.videoId} className="flex flex-col overflow-hidden rounded-2xl bg-white/5 pb-3 transition-transform duration-200">
            <Dwellable onSelect={() => onSelectVideo({ id: video.videoId, isShort: false })} className="w-full">
              <div className="relative aspect-video w-full">
                <img
                  src={video.thumbnailUrl}
                  alt={video.title}
                  className="h-full w-full object-cover"
                />
                {video.durationSec ? (
                  <span className="absolute bottom-2 right-2 rounded bg-black/80 px-2 py-1 text-sm font-medium text-white">
                    {formatTime(video.durationSec)}
                  </span>
                ) : null}
              </div>
            </Dwellable>
            <div className="flex flex-col gap-1 px-4 pt-3">
              <span className="line-clamp-2 text-base font-medium leading-snug text-white/90">
                {video.title}
              </span>
              <span className="text-sm text-white/50">{video.channelTitle}</span>
            </div>
          </div>
        ))}
      </div>

      {/* LARGE SPATIAL SCROLL RAIL */}
      <div className="flex w-24 shrink-0 flex-col items-center justify-center gap-4 border-l border-white/10 bg-white/5 transition-colors hover:bg-white/10">
        <GripVertical className="h-10 w-10 text-white/40" />
        <span className="text-sm uppercase tracking-widest text-white/40 [writing-mode:vertical-rl]">
          Scroll
        </span>
      </div>
    </div>
  );
}

function YoutubeShorts({ onSelectVideo }: { onSelectVideo: (video: { id: string, isShort: boolean }) => void }) {
  const [shorts, setShorts] = useState<VideoResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { registerScrollTarget } = useDwellEngine();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadShorts() {
      if (!API_KEY) {
        setError('No YouTube API key configured (VITE_YOUTUBE_API_KEY).');
        return;
      }

      try {
        const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
        searchUrl.searchParams.set('part', 'snippet');
        searchUrl.searchParams.set('type', 'video');
        searchUrl.searchParams.set('maxResults', '25');
        searchUrl.searchParams.set('q', 'shorts');
        searchUrl.searchParams.set('key', API_KEY);

        const searchRes = await fetch(searchUrl.toString());
        if (!searchRes.ok) throw new Error(`YouTube API error (${searchRes.status})`);
        const searchData = await searchRes.json();

        const uniqueItems = new Map<string, any>();
        (searchData.items || []).forEach((item: any) => {
          if (item.id?.videoId && !uniqueItems.has(item.id.videoId)) {
            uniqueItems.set(item.id.videoId, item);
          }
        });

        const rawList = Array.from(uniqueItems.values());
        if (!rawList.length) {
          if (!cancelled) setShorts([]);
          return;
        }

        const videoIds = rawList.map(item => item.id.videoId).slice(0, 50);
        const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
        detailsUrl.searchParams.set('part', 'contentDetails');
        detailsUrl.searchParams.set('id', videoIds.join(','));
        detailsUrl.searchParams.set('key', API_KEY);

        const detailsRes = await fetch(detailsUrl.toString());
        const detailsData = detailsRes.ok ? await detailsRes.json() : { items: [] };
        const durations = new Map<string, number>(
          (detailsData.items || []).map((item: any) => [
            item.id,
            parseYouTubeDuration(item.contentDetails?.duration),
          ])
        );

        // Videos with duration <=180 seconds are treated as Short CANDIDATES using a duration-based heuristic because YouTube Data API does not expose an official Shorts boolean.
        const detected = rawList
          .map(item => {
            const vId = item.id.videoId;
            const durationSec = durations.get(vId) || 0;
            return {
              videoId: vId,
              title: item.snippet.title,
              channelTitle: item.snippet.channelTitle,
            thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
            durationSec,
            isShortCandidate: isShortCandidateDuration(durationSec),
          };
        })
        .filter(v => !v.isShortCandidate);

      setResults(videos);
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleVoiceResult = useCallback(
    (transcript: string) => {
      setHeardText(transcript);
      setActiveTab('home');
      runSearch(transcript);
    },
    [runSearch],
  );

  const { start: startListening, listening, supported } = useVoiceSearch(handleVoiceResult);

  const { registerScrollTarget } = useDwellEngine();
  const gridScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!results) return;
    const el = gridScrollRef.current;
    if (!el) return;
    return registerScrollTarget(el);
  }, [results, registerScrollTarget]);

  return (
    <div className="flex h-full w-full flex-col bg-neutral-950 text-white">
      <div className="flex items-center gap-4 border-b border-white/10 bg-white/5 px-8 py-5">
        <div className="flex items-center gap-3">
          <span className="text-3xl font-bold text-white/90">YouTube</span>
          <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-bold uppercase tracking-wider text-white/40">AR</span>
        </div>
        <div className="ml-8 flex items-center gap-2 rounded-full bg-white/5 p-2">
          <Dwellable onSelect={() => { setActiveTab('home'); setResults(null); setPlayingVideo(null); }}>
            <button type="button" onClick={() => { setActiveTab('home'); setResults(null); setPlayingVideo(null); }}
              className={`rounded-full px-8 py-4 text-xl font-medium transition-colors ${activeTab === 'home' ? 'bg-white/20 text-white' : 'text-white/50 hover:bg-white/10'}`}>
              Home
            </button>
          </Dwellable>
          <Dwellable onSelect={() => { setActiveTab('shorts'); setResults(null); setPlayingVideo(null); }}>
            <button type="button" onClick={() => { setActiveTab('shorts'); setResults(null); setPlayingVideo(null); }}
              className={`rounded-full px-8 py-4 text-xl font-medium transition-colors ${activeTab === 'shorts' ? 'bg-white/20 text-white' : 'text-white/50 hover:bg-white/10'}`}>
              Shorts
            </button>
          </Dwellable>
        </div>
        <div className="flex-1" />
        {heardText && !loading && (
          <span className="max-w-[20rem] truncate text-xl text-white/40">"{heardText}"</span>
        )}
        <Dwellable onSelect={startListening} disabled={!supported || listening}>
          <button
            type="button"
            onClick={startListening}
            disabled={!supported || listening}
            aria-label="Voice search"
            className={`flex h-20 w-20 items-center justify-center rounded-full text-black transition-colors duration-200 disabled:opacity-40 ${
              listening ? 'bg-red-500 animate-pulse' : 'bg-teal-500 hover:bg-teal-400'
            }`}
          >
            {loading ? <Loader2 className="h-10 w-10 animate-spin" /> : <Mic className="h-10 w-10" />}
          </button>
        </Dwellable>
      </div>

      <div className="relative flex-1 overflow-hidden">
        {/* Render Layer Priority:
            1. Player (Overlay active)
            2. Search Results
            3. Shorts Feed
            4. Home Feed
            Because playingVideo overlays the UI, Back instantly reveals the intact state below. */}
            
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-8 bg-transparent px-8 text-center">
            <p className="max-w-2xl text-2xl text-white/70">{error}</p>
            <Dwellable onSelect={() => setError(null)}>
              <button
                type="button"
                onClick={() => setError(null)}
                className="rounded-full bg-white/10 px-8 py-4 text-xl text-white/80 transition-colors hover:bg-white/20"
              >
                Dismiss
              </button>
            </Dwellable>
          </div>
        ) : (
          <>
            {/* The active list view */}
            {results ? (
              <div className="flex h-full">
                <div ref={gridScrollRef} className="grid flex-1 grid-cols-2 gap-6 overflow-y-auto p-6 sm:grid-cols-3 xl:grid-cols-4">
                  {results.map((video) => (
                    <div key={video.videoId} className="flex flex-col overflow-hidden rounded-2xl bg-white/5 pb-3 transition-transform duration-200">
                      <Dwellable
                        onSelect={() => setPlayingVideo({ id: video.videoId, isShort: false })}
                        className="w-full"
                      >
                        <div className="relative aspect-video w-full">
                          <img
                            src={video.thumbnailUrl}
                            alt={video.title}
                            className="h-full w-full object-cover"
                          />
                          {video.durationSec ? (
                            <span className="absolute bottom-2 right-2 rounded bg-black/80 px-2 py-1 text-sm font-medium text-white">
                              {formatTime(video.durationSec)}
                            </span>
                          ) : null}
                        </div>
                      </Dwellable>
                      <div className="flex flex-col gap-1 px-4 pt-3">
                        <span className="line-clamp-2 text-base font-medium leading-snug text-white/90">
                          {video.title}
                        </span>
                        <span className="text-sm text-white/50">{video.channelTitle}</span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex w-24 shrink-0 flex-col items-center justify-center gap-4 border-l border-white/10 bg-white/5 transition-colors hover:bg-white/10">
                  <GripVertical className="h-10 w-10 text-white/40" />
                  <span className="text-sm uppercase tracking-widest text-white/40 [writing-mode:vertical-rl]">
                    Scroll
                  </span>
                </div>
              </div>
            ) : activeTab === 'shorts' ? (
              <YoutubeShorts onSelectVideo={setPlayingVideo} />
            ) : (
              <YoutubeHome onSelectVideo={setPlayingVideo} />
            )}

            {/* The Player Overlay */}
            {playingVideo && (
              <div className="absolute inset-0 z-50 bg-black">
                <YoutubePlayer 
                  videoId={playingVideo.id} 
                  isShort={playingVideo.isShort} 
                  onBack={() => setPlayingVideo(null)} 
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
        }
