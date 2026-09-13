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
    <div ref={scrollRef} className="relative flex h-full flex-col overflow-y-auto bg-black">
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={handleFileSelected}
      />

      {!videoUrl && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 pb-28 text-center">
          <div className="text-5xl">🎬</div>
          <p className="text-white/70">
            Neeche wala fixed button dabao (real touch se) apne phone ki video pick karne ke liye.
          </p>
        </div>
      )}

      {videoUrl && (
        <div className="flex flex-1 flex-col pb-28">
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
              <span>{formatTime(videoRef.current?.currentTime ?? 0)}</span>
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
          </div>
        </div>
      )}

      {/*
        FIXED, ALWAYS-SAME-POSITION real-touch button.
        - Position kabhi nahi badalti (bottom-center, absolute to this
          panel), chahe koi video select ho ya na ho, ya dusra video
          switch karna ho — muscle-memory se dhoondhna easy rahe.
        - Ye deliberately Dwellable/pinch se wire NAHI hai — browser
          file-picker sirf real trusted tap/click se khulta hai
          (synthetic pinch-events se kabhi nahi), isliye ye ek button
          hamesha genuine touch maangta hai. Baaki sab pinch se chalta
          hai.
        - Bada tap-target (56px height) taaki touch se dhoondhna aasan
          ho bina dekhe.
      */}
      <button
        type="button"
        onClick={handleChooseVideo}
        aria-label={videoUrl ? 'Choose a different video' : 'Choose video'}
        className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex h-14 min-w-[220px] items-center justify-center gap-2 rounded-full bg-purple-500 px-6 text-base font-semibold text-white shadow-lg shadow-black/50 active:scale-95"
      >
        📁 {videoUrl ? 'Choose Different Video' : 'Choose Video'}
      </button>
    </div>
  );
}
