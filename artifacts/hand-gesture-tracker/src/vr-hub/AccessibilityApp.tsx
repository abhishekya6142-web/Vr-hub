// AccessibilityApp.tsx
//
// Blind Assist mode: camera se real-time object detection
// (@tensorflow-models/coco-ssd), har object ki relative
// position/distance voice se bolta hai (window.speechSynthesis).
//
// IMPORTANT:
//   - WebXR session aur HandTracker/MediaPipe ka processing YAHAN SE
//     BILKUL NAHI CHHUA JAATA. Dono full power pe waise hi chalte
//     rehte hain jaise Accessibility ke bina chalte the. Koi
//     pause/zero/exit nahi hota WebXR ka.
//   - Ye component sirf ek NAYA parallel consumer hai
//     xrCameraSource.subscribe() ka — jo already WebXR se raw camera
//     frames deta hai HandTracker ko bhi. Dono independently subscribe
//     karte hain, ek dusre ko affect nahi karte.
//
// EXIT: ab pinch-gesture se NAHI, VOICE COMMAND se — user "exit
// accessibility" (ya close variants) bole to Web Speech API
// (SpeechRecognition) usse sunke exit trigger karta hai. Koi wiring
// dependency HandTracker/pinch-events par nahi hai — self-contained.
//
// Camera resolution: non-XR fallback (getUserMedia) mein HD
// (1280x720) target karte hain. XR mode mein xrCameraSource jo bhi
// deta hai wahi use hota hai (usko badalna xr-camera-source.ts ko
// chhoo dega, jo hume nahi karna).

import { useEffect, useRef, useState } from 'react';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import '@tensorflow/tfjs';
import { xrPoseEngine } from './xr-pose-engine';
import { xrCameraSource } from './xr-camera-source';
import { accessibilityMode } from './accessibility-mode';

// =====================================================================
// ⚙️ SETTINGS
// =====================================================================

const DETECT_INTERVAL_MS = 400; // ~2.5fps — real-time hand-tracking jitna fast nahi chahiye

const FALLBACK_CAPTURE_WIDTH = 1280;
const FALLBACK_CAPTURE_HEIGHT = 720;

const DANGER_AREA_RATIO = 0.35;
const CLOSE_AREA_RATIO = 0.15;

const REPEAT_COOLDOWN_MS = 4000;
const POSITION_CHANGE_THRESHOLD = 0.15;

// Voice-exit phrases — koi bhi in mein se boli jaaye to exit trigger
// hoga. Lowercase, substring-match (SpeechRecognition transcript
// lowercase karke check karenge).
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
  if (urgent) {
    window.speechSynthesis.cancel();
  }
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = urgent ? 1.1 : 1.0;
  utter.pitch = urgent ? 1.2 : 1.0;
  window.speechSynthesis.speak(utter);
}

type AccessibilityAppProps = {
  onRequestClose?: () => void;
};

export function AccessibilityApp({ onRequestClose }: AccessibilityAppProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState('Loading object detection…');
  const [lastAnnouncement, setLastAnnouncement] = useState('');

  useEffect(() => {
    accessibilityMode.setActive(true);
    return () => {
      accessibilityMode.setActive(false);
    };
  }, []);

  // --- Voice-command exit: continuous SpeechRecognition listening
  // for an exit phrase. Independent of HandTracker/pinch — no
  // cross-component wiring needed.
  const onRequestCloseRef = useRef(onRequestClose);
  onRequestCloseRef.current = onRequestClose;

  useEffect(() => {
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      // Browser doesn't support it — voice exit just won't work, rest
      // of the app still functions normally.
      return;
    }

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
          onRequestCloseRef.current?.();
          return;
        }
      }
    };

    recognition.onerror = () => {
      // Mic errors (permission denial, no-speech timeouts, etc.) —
      // try to restart below via onend, silent otherwise.
    };

    recognition.onend = () => {
      // Some browsers auto-stop after a period of silence even with
      // continuous=true. Restart automatically unless we're
      // unmounting.
      if (!cancelled && recognition) {
        try {
          recognition.start();
        } catch {
          // already started / transient — ignore
        }
      }
    };

    try {
      recognition.start();
    } catch {
      // ignore — start() can throw if called while already running
    }

    return () => {
      cancelled = true;
      recognition?.stop();
      recognition = null;
    };
  }, []);

  // --- Object detection loop ---
  useEffect(() => {
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
  }, []);

  const xrMode = xrPoseEngine.isActive() && xrCameraSource.isSupported();

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center bg-black">
      {!xrMode && (
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" playsInline muted autoPlay />
      )}
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
      <div className="absolute bottom-4 left-4 right-4 rounded-xl bg-black/60 p-3 text-center text-sm text-white/90 backdrop-blur">
        {status || lastAnnouncement || 'Listening for objects…'}
      </div>
      <div className="absolute top-4 left-4 rounded-full bg-black/50 px-3 py-1 text-xs text-white/70">
        Say "exit accessibility" to close
      </div>
    </div>
  );
}
