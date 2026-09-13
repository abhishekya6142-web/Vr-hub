// AccessibilityApp.tsx
//
// Blind Assist mode: camera se real-time object detection
// (MediaPipe Tasks ObjectDetector — EfficientDet-Lite0), har object
// ki relative position/distance voice se bolta hai
// (window.speechSynthesis).
//
// MIGRATED: coco-ssd (@tensorflow-models/coco-ssd) se MediaPipe Tasks
// ObjectDetector mein. Same pattern jo HandTracker.tsx mein
// @mediapipe/tasks-vision ke liye use hua — GPU-delegate WASM
// pipeline, better optimized than the old TF.js coco-ssd model.
//
// FLOW (confirmed with user):
//   1. App opens inside its normal AppWindow panel showing a Start
//      button + instructions. Detection is NOT running yet.
//   2. User taps Start -> accessibilityMode.setFullScreen(true).
//      VRHubInner (parent shell) reacts to this by hiding the normal
//      world-locked panel UI (home screen, other panels, recenter
//      button) so THIS component can render as a full-screen overlay.
//      Detection loop starts now.
//   3. User says "exit" (voice) -> stops detection, calls
//      accessibilityMode.requestExit() -> VRHubInner's subscriber
//      closes this AppWindow (same as pressing the panel's own X),
//      which unmounts this component -> cleanup resets
//      accessibilityMode active/fullScreen to false -> VRHubInner's
//      normal panel UI (world-locked, as before) comes back.
//
// IMPORTANT (unchanged from before):
//   - WebXR session aur HandTracker/MediaPipe hand-tracking ka
//     processing YAHAN SE BILKUL NAHI CHHUA JAATA — full power pe
//     hamesha chalte rehte hain. Sirf VISUAL panel chrome hide hota
//     hai full-screen mode mein, WebXR session khud pause/exit nahi
//     hoti.
//   - Camera: xrCameraSource.subscribe() (XR mode) parallel consumer
//     hai, HandTracker ko affect nahi karta. Non-XR fallback:
//     getUserMedia @ 1280x720.
//   - Background intentionally stays solid black (bg-black) in the
//     full-screen view — this is a voice-first accessibility tool,
//     the visual feed isn't the point; only the spoken announcements
//     matter for the target user.

import { useEffect, useRef, useState, Component, type ReactNode } from 'react';
import { ObjectDetector, type ObjectDetectorResult } from '@mediapipe/tasks-vision';
import { getSharedVisionFileset } from './mediapipe-vision-resolver';
import { xrPoseEngine } from './xr-pose-engine';
import { xrCameraSource } from './xr-camera-source';
import { accessibilityMode } from './accessibility-mode';
// FIX: Start button touch tak pahunch nahi raha tha kyunki app ka
// baaki UI (jaise AppWindow ka close button) Dwellable ke through
// hand-tracking/gaze/dwell selection system se wired hai — plain
// <button onClick> is system ke saath conflict/intercept ho sakta hai
// (dwell-engine ke invisible overlay ya event handling ki wajah se).
// AppWindow.tsx ke close button jaisa hi pattern follow kiya.
import { Dwellable } from './Dwellable';

// =====================================================================
// ⚙️ SETTINGS
// =====================================================================

const DETECT_INTERVAL_MS = 400; // ~2.5fps

const FALLBACK_CAPTURE_WIDTH = 1280;
const FALLBACK_CAPTURE_HEIGHT = 720;

const DANGER_AREA_RATIO = 0.35;
const CLOSE_AREA_RATIO = 0.15;

const REPEAT_COOLDOWN_MS = 4000;
const POSITION_CHANGE_THRESHOLD = 0.15;

const EXIT_PHRASES = ['exit accessibility', 'close accessibility', 'stop accessibility', 'exit'];

// MediaPipe Tasks ObjectDetector — EfficientDet-Lite0, MediaPipe's
// official pre-trained COCO-category detector (~80 classes, same
// category set as the old coco-ssd model). Hosted on Google's public
// MediaPipe model CDN.
const MODEL_ASSET_PATH =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

// NOTE (shared WASM runtime): WASM fileset loading moved to
// getSharedVisionFileset() / mediapipe-vision-resolver.ts. Do NOT call
// FilesetResolver.forVisionTasks() here directly — HandTracker's
// HandLandmarker and this ObjectDetector must share one WASM runtime
// instance, or MediaPipe Tasks crashes with "Aborted
// (Module.noExitRuntime ...)" since HandTracker keeps running in the
// background even while Accessibility is active (required for the
// 3x-pinch exit gesture).

const SCORE_THRESHOLD = 0.5;
const MAX_RESULTS = 8;

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
}

type DetectedObjectMemory = {
  label: string;
  lastSpokenAt: number;
  lastCenterX: number;
};

function directionFromCenterX(centerXNorm: number): string {
  if (centerXNorm < 0.33) return 'left';
  if (centerXNorm > 0.66) return 'right';
  return 'ahead';
}

function urgencyFromAreaRatio(areaRatio: number): 'danger' | 'close' | 'normal' {
  if (areaRatio >= DANGER_AREA_RATIO) return 'danger';
  if (areaRatio >= CLOSE_AREA_RATIO) return 'close';
  return 'normal';
}

function speak(text: string, urgent: boolean) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  if (urgent) window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = urgent ? 1.1 : 1.0;
  utter.pitch = urgent ? 1.2 : 1.0;
  window.speechSynthesis.speak(utter);
}

export function AccessibilityApp() {
  return (
    <AccessibilityErrorBoundary>
      <AccessibilityAppInner />
    </AccessibilityErrorBoundary>
  );
}

// TEMP DEBUG: catches any crash inside AccessibilityAppInner (e.g. a
// thrown error during model load, XR camera subscribe, or render) and
// shows it PERMANENTLY on screen instead of silently
// unmounting/remounting (which looked like "loading -> stuck -> pops
// back to normal with nothing happening"). This is what's needed to
// actually see what's failing. Safe to simplify/remove once the real
// bug is found and fixed.
class AccessibilityErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  componentDidCatch(error: unknown, info: unknown) {
    // eslint-disable-next-line no-console
    console.error('AccessibilityApp crashed:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="fixed inset-0 z-[999999] flex flex-col items-center justify-center gap-4 bg-red-950 p-8 text-center">
          <h2 className="text-lg font-bold text-white">Accessibility crashed</h2>
          <p className="max-w-sm break-words text-xs text-red-200">{this.state.error}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function AccessibilityAppInner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState('Loading object detection…');
  const [lastAnnouncement, setLastAnnouncement] = useState('');
  const [started, setStarted] = useState(false);
  // TEMP DEBUG: on-screen diagnostic line so issues are visible on
  // mobile without needing remote devtools. Shows which stage/branch
  // the detection pipeline is in and any caught error. Safe to remove
  // once both bugs are confirmed fixed.
  const [debugLine, setDebugLine] = useState('debug: init');

  // TEMP DEBUG: catches unhandled promise rejections (e.g. an await
  // that failed without a .catch) globally while this component is
  // mounted, and surfaces them into debugLine instead of letting them
  // silently vanish.
  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      const msg = event.reason instanceof Error ? event.reason.message : String(event.reason);
      setDebugLine(`debug: UNHANDLED REJECTION: ${msg}`);
    };
    window.addEventListener('unhandledrejection', handler);
    return () => window.removeEventListener('unhandledrejection', handler);
  }, []);

  // Mount: mark active. Unmount (panel closed): mark inactive, which
  // also resets fullScreen to false via accessibility-mode.ts.
  useEffect(() => {
    accessibilityMode.setActive(true);
    return () => {
      accessibilityMode.setActive(false);
    };
  }, []);

  // Keep the shared fullScreen flag in sync with local `started`
  // state, so VRHubInner can react to it.
  useEffect(() => {
    accessibilityMode.setFullScreen(started);
    setDebugLine(`debug: started=${started}, accessibilityMode.isFullScreen()=${accessibilityMode.isFullScreen()}`);
  }, [started]);

  // --- Voice-command exit (only listens once started, so it doesn't
  // fight with the Start-button screen's own mic-less UI).
  useEffect(() => {
    if (!started) return;

    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) return;

    let cancelled = false;
    let recognition: SpeechRecognitionLike | null = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onresult = (event: any) => {
      if (cancelled) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript: string = event.results[i][0].transcript.toLowerCase().trim();
        if (EXIT_PHRASES.some((phrase) => transcript.includes(phrase))) {
          speak('Exiting accessibility mode', true);
          accessibilityMode.requestExit();
          return;
        }
      }
    };

    recognition.onerror = () => {};
    recognition.onend = () => {
      if (!cancelled && recognition) {
        try {
          recognition.start();
        } catch {
          // already running — ignore
        }
      }
    };

    try {
      recognition.start();
    } catch {
      // ignore
    }

    return () => {
      cancelled = true;
      recognition?.stop();
      recognition = null;
    };
  }, [started]);

  // --- Object detection loop (only runs once started) ---
  useEffect(() => {
    if (!started) return;

    let cancelled = false;
    let detector: ObjectDetector | null = null;
    let rafId = 0;
    let stream: MediaStream | null = null;
    let lastDetectTime = 0;
    const memory = new Map<string, DetectedObjectMemory>();
    let unsubscribeXr: (() => void) | null = null;

    function useXRCameraSource() {
      return xrPoseEngine.isActive() && xrCameraSource.isSupported();
    }

    function processResult(result: ObjectDetectorResult, srcW: number, srcH: number) {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        canvas.width = srcW;
        canvas.height = srcH;
        ctx.clearRect(0, 0, srcW, srcH);
      }

      const now = Date.now();
      let mostUrgent: { text: string; urgent: boolean } | null = null;

      for (const detection of result.detections) {
        const box = detection.boundingBox;
        if (!box) continue;
        const { originX: x, originY: y, width: w, height: h } = box;
        const categoryName = detection.categories[0]?.categoryName ?? 'object';

        const areaRatio = (w * h) / (srcW * srcH);
        const centerXNorm = (x + w / 2) / srcW;
        const urgency = urgencyFromAreaRatio(areaRatio);
        const direction = directionFromCenterX(centerXNorm);

        if (canvas && ctx) {
          ctx.strokeStyle = urgency === 'danger' ? '#ff3b30' : urgency === 'close' ? '#ffcc00' : '#22d3ee';
          ctx.lineWidth = 3;
          ctx.strokeRect(x, y, w, h);
          ctx.fillStyle = '#fff';
          ctx.font = '14px sans-serif';
          ctx.fillText(`${categoryName} (${direction})`, x + 4, y + 16);
        }

        const key = categoryName;
        const mem = memory.get(key);
        const positionChanged = !mem || Math.abs(mem.lastCenterX - centerXNorm) > POSITION_CHANGE_THRESHOLD;
        const cooldownPassed = !mem || now - mem.lastSpokenAt > REPEAT_COOLDOWN_MS;

        if ((positionChanged || cooldownPassed) && (urgency !== 'normal' || cooldownPassed)) {
          const phrase =
            urgency === 'danger'
              ? `Danger, ${categoryName} very close, ${direction}`
              : `${categoryName}, ${direction}${urgency === 'close' ? ', close' : ''}`;

          if (urgency === 'danger') {
            mostUrgent = { text: phrase, urgent: true };
          } else if (!mostUrgent) {
            mostUrgent = { text: phrase, urgent: false };
          }

          memory.set(key, { label: key, lastSpokenAt: now, lastCenterX: centerXNorm });
        }
      }

      if (mostUrgent) {
        speak(mostUrgent.text, mostUrgent.urgent);
        setLastAnnouncement(mostUrgent.text);
      }
    }

    async function start() {
      setDebugLine('debug: loading MediaPipe ObjectDetector model...');
      try {
        const fileset = await getSharedVisionFileset();
        detector = await ObjectDetector.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: MODEL_ASSET_PATH,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          scoreThreshold: SCORE_THRESHOLD,
          maxResults: MAX_RESULTS,
        });
        setDebugLine('debug: model loaded OK');
      } catch (err) {
        if (!cancelled) setStatus('Failed to load object detection model.');
        setDebugLine(`debug: MODEL LOAD FAILED: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (cancelled || !detector) return;

      const xrModeCheck = useXRCameraSource();
      setDebugLine(
        `debug: model OK, xrPoseEngine.isActive()=${xrPoseEngine.isActive()}, xrCameraSource.isSupported()=${xrCameraSource.isSupported()}, using=${xrModeCheck ? 'XR camera' : 'getUserMedia fallback'}`,
      );

      if (xrModeCheck) {
        let frameCount = 0;
        unsubscribeXr = xrCameraSource.subscribe((xrCanvas) => {
          if (cancelled || !xrCanvas || !detector) return;
          frameCount++;
          const nowMs = performance.now();
          if (nowMs - lastDetectTime < DETECT_INTERVAL_MS) return;
          lastDetectTime = nowMs;
          setDebugLine(`debug: XR frames received=${frameCount}, canvas=${xrCanvas.width}x${xrCanvas.height}`);
          try {
            const result = detector.detectForVideo(xrCanvas, performance.now());
            processResult(result, xrCanvas.width, xrCanvas.height);
          } catch (err) {
            setDebugLine(`debug: detectForVideo() ERROR: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
        if (!cancelled) setStatus('');
        return;
      }

      try {
        const video = videoRef.current;
        if (!video) {
          setDebugLine('debug: ERROR videoRef.current is null');
          return;
        }
        setDebugLine('debug: requesting getUserMedia...');
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: FALLBACK_CAPTURE_WIDTH },
            height: { ideal: FALLBACK_CAPTURE_HEIGHT },
          },
        });
        video.srcObject = stream;
        await video.play();
        if (!cancelled) setStatus('');
        setDebugLine('debug: getUserMedia OK, video playing, starting loop');

        const loop = () => {
          if (cancelled || !detector) return;
          const nowMs = performance.now();
          if (video.readyState >= 2 && nowMs - lastDetectTime >= DETECT_INTERVAL_MS) {
            lastDetectTime = nowMs;
            try {
              const result = detector.detectForVideo(video, performance.now());
              processResult(result, video.videoWidth || FALLBACK_CAPTURE_WIDTH, video.videoHeight || FALLBACK_CAPTURE_HEIGHT);
            } catch (err) {
              setDebugLine(`debug: detectForVideo() ERROR: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          rafId = requestAnimationFrame(loop);
        };
        rafId = requestAnimationFrame(loop);
      } catch (err) {
        if (!cancelled) setStatus('Camera access failed.');
      }
    }

    start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      stream?.getTracks().forEach((t) => t.stop());
      unsubscribeXr?.();
      detector?.close();
      window.speechSynthesis?.cancel();
    };
  }, [started]);

  const xrMode = xrPoseEngine.isActive() && xrCameraSource.isSupported();

  // --- Stage 1: Start screen (inside normal small panel) ---
  if (!started) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-neutral-950 p-8 text-center">
        <h2 className="text-lg font-medium text-white">Blind Assist</h2>
        <p className="max-w-xs text-sm text-white/60">
          Detects nearby objects and speaks their position and distance out loud. Once started, this takes over the
          full screen. Say "exit" any time to stop and return.
        </p>
        <Dwellable onSelect={() => setStarted(true)}>
          <button
            type="button"
            onClick={() => setStarted(true)}
            className="mt-2 rounded-full bg-lime-500 px-6 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-lime-400"
          >
            Start
          </button>
        </Dwellable>
        <p className="mt-3 text-[10px] text-white/30">{debugLine}</p>
      </div>
    );
  }

  // --- Stage 2: full-screen detection view. VRHubInner hides the
  // normal panel UI while accessibilityMode.isFullScreen() is true,
  // so this renders as a fixed full-screen overlay instead of inside
  // the small AppWindow card. Background intentionally stays solid
  // black — this is a voice-first tool, the visual feed isn't the
  // point for the target user.
  return (
    <div className="fixed inset-0 z-[999999] flex flex-col items-center justify-center bg-black">
      {!xrMode && (
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" playsInline muted autoPlay />
      )}
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
      <div className="absolute bottom-4 left-4 right-4 rounded-xl bg-black/60 p-3 text-center text-sm text-white/90 backdrop-blur">
        {status || lastAnnouncement || 'Listening for objects…'}
      </div>
      <div className="absolute top-4 left-4 rounded-full bg-black/50 px-3 py-1 text-xs text-white/70">
        Say "exit" to close
      </div>
      <div className="absolute top-16 left-4 right-4 rounded-lg bg-black/70 p-2 text-[10px] text-lime-400">
        {debugLine}
      </div>
    </div>
  );
          }
