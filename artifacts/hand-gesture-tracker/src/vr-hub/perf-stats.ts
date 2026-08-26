// perf-stats.ts
//
// TEMP (measurement only): ek chhota shared "mailbox" hai jahan
// xr-camera-source.ts, HandTracker.tsx, aur XRHub.tsx apne-apne FPS
// numbers likhte hain, aur PerfOverlay.tsx unhe padhkar screen par
// dikhata hai.
//
// Isse koi naya dependency/library nahi lagi — bas ek plain object +
// subscribe callback, jaisा baaki codebase mein already (xrPoseEngine,
// xrCameraSource) subscribe pattern use ho raha hai.
//
// Jab measurement khatam ho jaaye: sirf DEBUG_PERF_LOG (in teeno files
// mein) false kar dena, aur VRHub.tsx se <PerfOverlay /> line hata
// dena — is file (perf-stats.ts) aur PerfOverlay.tsx ko rehne dena
// koi nuksan nahi karta (dead code, zero runtime cost).

export type PerfStats = {
  xrRenderFps: number | null;
  cameraExtractionFps: number | null;
  cameraExtractionAvgMs: number | null;
  mediapipeFps: number | null;
  mediapipeAvgMs: number | null;
};

type Listener = (stats: PerfStats) => void;

class PerfStatsStore {
  private stats: PerfStats = {
    xrRenderFps: null,
    cameraExtractionFps: null,
    cameraExtractionAvgMs: null,
    mediapipeFps: null,
    mediapipeAvgMs: null,
  };
  private listeners = new Set<Listener>();

  update(partial: Partial<PerfStats>) {
    this.stats = { ...this.stats, ...partial };
    this.listeners.forEach((cb) => cb(this.stats));
  }

  getSnapshot(): PerfStats {
    return this.stats;
  }

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    cb(this.stats);
    return () => {
      this.listeners.delete(cb);
    };
  };
}

export const perfStats = new PerfStatsStore();
