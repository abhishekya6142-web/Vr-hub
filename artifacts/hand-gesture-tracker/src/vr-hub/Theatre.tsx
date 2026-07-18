import { useEffect, useRef, useState } from 'react';
import { Dwellable } from './Dwellable';
import { useDwellEngine } from './dwell-engine';

export function Theatre() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0-1
  const [duration, setDuration] = useState(0);

  const { registerScrollTarget } = useDwellEngine();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    return registerScrollTarget(el);
  }, [registerScrollTarget]);

  // Clean up the object URL when a new video is chosen or the component
  // unmounts, so we don't leak memory across picks.
  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  function handleChooseVideo() {
    fileInputRef.current?.click();
  }

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    setFileName(file.name);
    setIsPlaying(false);
    setProgress(0);
    // allow re-selecting the same file later
    e.target.value = '';
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }

  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    setProgress(video.currentTime / video.duration);
    setDuration(video.duration);
  }

  function seekBy(deltaSeconds: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + deltaSeconds));
  }

  function seekToFraction(fraction: number) {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    video.currentTime = Math.max(0, Math.min(video.duration, fraction * video.duration));
  }

  function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  return (
    <div ref={scrollRef} className="flex h-full flex-col overflow-y-auto bg-black">
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={handleFileSelected}
      />

      {!videoUrl && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="text-5xl">🎬</div>
          <p className="text-white/70">Pick a video from your phone to play it here.</p>
          <Dwellable onSelect={handleChooseVideo}>
            <button
              type="button"
              onClick={handleChooseVideo}
              className="rounded-xl bg-purple-500 px-6 py-3 font-semibold text-white transition-colors duration-200 hover:bg-purple-400"
            >
              Choose Video
            </button>
          </Dwellable>
        </div>
      )}

      {videoUrl && (
        <div className="flex flex-1 flex-col">
          <div className="relative flex flex-1 items-center justify-center bg-black">
            <video
              ref={videoRef}
              src={videoUrl}
              className="h-full w-full object-contain"
              playsInline
              onTimeUpdate={handleTimeUpdate}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
            />
          </div>

          <div className="flex flex-col gap-3 bg-black/80 p-4">
            <p className="truncate text-xs text-white/50">{fileName}</p>

            <div
              className="relative h-2 w-full cursor-pointer rounded-full bg-white/20"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                seekToFraction((e.clientX - rect.left) / rect.width);
              }}
            >
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-purple-400"
                style={{ width: `${progress * 100}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-xs text-white/50">
              <span>{formatTime((videoRef.current?.currentTime ?? 0))}</span>
              <span>{formatTime(duration)}</span>
            </div>

            <div className="flex items-center justify-center gap-4">
              <Dwellable onSelect={() => seekBy(-10)}>
                <button
                  type="button"
                  onClick={() => seekBy(-10)}
                  className="rounded-full bg-white/10 px-4 py-2 text-white transition-colors duration-200 hover:bg-white/20"
                >
                  ⏪ 10s
                </button>
              </Dwellable>

              <Dwellable onSelect={togglePlay}>
                <button
                  type="button"
                  onClick={togglePlay}
                  className="rounded-full bg-purple-500 px-6 py-3 text-lg font-semibold text-white transition-colors duration-200 hover:bg-purple-400"
                >
                  {isPlaying ? '⏸' : '▶'}
                </button>
              </Dwellable>

              <Dwellable onSelect={() => seekBy(10)}>
                <button
                  type="button"
                  onClick={() => seekBy(10)}
                  className="rounded-full bg-white/10 px-4 py-2 text-white transition-colors duration-200 hover:bg-white/20"
                >
                  10s ⏩
                </button>
              </Dwellable>
            </div>

            <Dwellable onSelect={handleChooseVideo}>
              <button
                type="button"
                onClick={handleChooseVideo}
                className="rounded-xl bg-white/10 px-4 py-2 text-sm text-white/80 transition-colors duration-200 hover:bg-white/20"
              >
                Choose Different Video
              </button>
            </Dwellable>
          </div>
        </div>
      )}
    </div>
  );
                }
