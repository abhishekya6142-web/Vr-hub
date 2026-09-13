// AccessibilityApp.tsx
//
// Blind Assist mode: camera se real-time object detection
// (@tensorflow-models/coco-ssd), har object ki relative
// position/distance voice se bolta hai (window.speechSynthesis).
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
//   - WebXR session aur HandTracker/MediaPipe ka processing YAHAN SE
//     BILKUL NAHI CHHUA JAATA — full power pe hamesha chalte rehte
//     hain. Sirf VISUAL panel chrome hide hota hai full-screen mode
//     mein, WebXR session khud pause/exit nahi hoti.
//   - Camera: xrCameraSource.subscribe() (XR mode) parallel consumer
//     hai, HandTracker ko affect nahi karta. Non-XR fallback:
//     getUserMedia @ 1280x720.

import { useEffect, useRef, useState } from 'react';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import '@tensorflow/tfjs';
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState('Loading object detection…');
  const [lastAnnouncement, setLastAnnouncement] = useState('');
  const [started, setStarted] = useState(false);

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
    let model: cocoSsd.ObjectDetection | null = null;
    let rafId = 0;
    let stream: MediaStream | null = null;
    let lastDetectTime = 0;
    const memory = new Map<string, DetectedObjectMemory>();
    let unsubscribeXr: (() => void) | null = null;

    function useXRCameraSource() {
      return xrPoseEngine.isActive() && xrCameraSource.isSupported();
    }

    async function processSource(source: HTMLVideoElement | HTMLCanvasElement, srcW: number, srcH: number) {
      if (!model || cancelled) return;
      const predictions = await model.detect(source);
      if (cancelled) return;

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        canvas.width = srcW;
        canvas.height = srcH;
        ctx.clearRect(0, 0, srcW, srcH);
      }

      const now = Date.now();
      let mostUrgent: { text: string; urgent: boolean } | null = null;

      for (const pred of predictions) {
        const [x, y, w, h] = pred.bbox;
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
          ctx.fillText(`${pred.class} (${direction})`, x + 4, y + 16);
        }

        const key = pred.class;
        const mem = memory.get(key);
        const positionChanged = !mem || Math.abs(mem.lastCenterX - centerXNorm) > POSITION_CHANGE_THRESHOLD;
        const cooldownPassed = !mem || now - mem.lastSpokenAt > REPEAT_COOLDOWN_MS;

        if ((positionChanged || cooldownPassed) && (urgency !== 'normal' || cooldownPassed)) {
          const phrase =
            urgency === 'danger'
              ? `Danger, ${pred.class} very close, ${direction}`
              : `${pred.class}, ${direction}${urgency === 'close' ? ', close' : ''}`;

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
      try {
        model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
      } catch (err) {
        if (!cancelled) setStatus('Failed to load object detection model.');
        return;
      }
      if (cancelled) return;

      if (useXRCameraSource()) {
        unsubscribeXr = xrCameraSource.subscribe((xrCanvas) => {
          if (cancelled || !xrCanvas || !model) return;
          const nowMs = performance.now();
          if (nowMs - lastDetectTime < DETECT_INTERVAL_MS) return;
          lastDetectTime = nowMs;
          processSource(xrCanvas, xrCanvas.width, xrCanvas.height);
        });
        if (!cancelled) setStatus('');
        return;
      }

      try {
        const video = videoRef.current;
        if (!video) return;
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

        const loop = () => {
          if (cancelled) return;
          const nowMs = performance.now();
          if (video.readyState >= 2 && nowMs - lastDetectTime >= DETECT_INTERVAL_MS) {
            lastDetectTime = nowMs;
            processSource(video, video.videoWidth || FALLBACK_CAPTURE_WIDTH, video.videoHeight || FALLBACK_CAPTURE_HEIGHT);
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
      </div>
    );
  }

  // --- Stage 2: full-screen detection view. VRHubInner hides the
  // normal panel UI while accessibilityMode.isFullScreen() is true,
  // so this renders as a fixed full-screen overlay instead of inside
  // the small AppWindow card.
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
    </div>
  );
}
