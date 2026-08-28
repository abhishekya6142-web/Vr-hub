// hand tracking - MINIMAL, VERIFIABLE VERSION
//
// Maqsad: is baar sabse simple, sabse zyada debuggable version banaya hai.
// Koi extra optimization, koi aspect-preserving resize, koi complex
// confidence-management nahi -- sirf seedha:
//   landmark (0-1 range) -> canvas pixel -> screen pixel -> draw dot
//
// DEBUG MODE ON hai by default -- har fingertip ka apna, alag-color
// dot dikhega, taaki calibration verify karna aasan ho:
//   - LAAL dot   = thumb tip (landmark 4)
//   - HARA dot   = index tip (landmark 8)
//   - PEELA dot  = wrist (landmark 0)
//   - NEELA dot  = middle-finger base knuckle (landmark 9)
//   - safed dot  = origin (thumb-index ka beech)
//   - cyan/red laser beam = origin se lekar computed target tak
//
// Agar in 4 colored dots mein se koi bhi apni real finger/wrist
// position se match NAHI karta, to bug yahi hai -- coordinate mapping
// mein, kisi settings mein nahi.

import { useEffect, useRef, useState } from 'react';
import { xrPoseEngine } from './vr-hub/xr-pose-engine';
import { xrCameraSource } from './vr-hub/xr-camera-source';
import { perfStats } from './vr-hub/perf-stats';

declare global {
  interface Window {
    Hands: any;
    Camera: any;
  }
}

// =====================================================================
// ⚙️ SETTINGS
// =====================================================================

const DEBUG_HAND_TRACKING = true; // false karne se sirf laser dikhega, dots nahi

const MIN_DETECTION_CONFIDENCE = 0.6;
const MIN_TRACKING_CONFIDENCE = 0.5;
const MAX_NUM_HANDS = 1;

const PINCH_ENTER_THRESHOLD = 0.25;
const PINCH_EXIT_THRESHOLD = 0.4;

const MIN_HAND_SIZE = 0.08;
const FREEZE_MS = 400;

const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 480;

// FIX (poora AR view choppy/lag): pehle har single XR-frame (jo
// 60fps tak aa sakta hai) turant MediaPipe ko bheja jaa raha tha —
// MediaPipe ka hand-detection kaafi heavy CPU/GPU kaam hai, isliye
// itni frequency pe chalane se poora render-loop hi block/slow ho
// jaata tha (sirf laser nahi, poora AR view choppy lagta tha).
// Ab MediaPipe ko max ~24fps tak hi throttle karte hain — XR ka apna
// render/pose-tracking loop iske bina bhi apni full speed pe chalta
// rahega, sirf hand-detection kam frequently chalega (jo insaani
// aankh ke liye zyada noticeable nahi hota, hand-movement itna fast
// nahi hota).
//
// FIX (poora AR view choppy/lag): pehle har single XR-frame (jo
// 60fps tak aa sakta hai) turant MediaPipe ko bheja jaa raha tha —
// MediaPipe ka hand-detection kaafi heavy CPU/GPU kaam hai, isliye
// itni frequency pe chalane se poora render-loop hi block/slow ho
// jaata tha (sirf laser nahi, poora AR view choppy lagta tha).
// Ab MediaPipe ko max ~24fps tak hi throttle karte hain — XR ka apna
// render/pose-tracking loop iske bina bhi apni full speed pe chalta
// rahega, sirf hand-detection kam frequently chalega (jo insaani
// aankh ke liye zyada noticeable nahi hota, hand-movement itna fast
// nahi hota).
const PROCESS_INTERVAL_MS = 1000 / 24;

// Laser ki length, screen ke chhote-dimension ke fraction mein.
const RAY_LENGTH_RATIO = 0.4;

// Smoothing — kitni jaldi laser naye position ki taraf move kare.
// 1 = bilkul smoothing nahi (raw/instant), 0.1 = bahut slow/smooth.
const SMOOTHING_ALPHA = 0.5;

// TEMP (measurement only — no logic change): console mein har ~1
// second par MediaPipe FPS aur average hands.send()->onResults() time
// print hota hai. Measure ho jaane ke baad false kar dena — zero
// runtime cost jab false ho.
const DEBUG_PERF_LOG = true;

class PerfCounter {
  private frameCount = 0;
  private totalMs = 0;
  private windowStart = performance.now();
  private label: string;
  constructor(label: string) {
    this.label = label;
  }
  record(durationMs: number) {
    if (!DEBUG_PERF_LOG) return;
    this.frameCount++;
    this.totalMs += durationMs;
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed >= 1000) {
      const fps = (this.frameCount / elapsed) * 1000;
      const avgMs = this.totalMs / this.frameCount;
      // TEMP (removed console.log — on-screen overlay hi kaafi hai).
      perfStats.update({ mediapipeFps: fps, mediapipeAvgMs: avgMs });
      this.frameCount = 0;
      this.totalMs = 0;
      this.windowStart = now;
    }
  }
}

// =====================================================================

type Landmark = { x: number; y: number; z: number };
type PxPoint = { x: number; y: number };

function dist(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pxDist(a: PxPoint, b: PxPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalize(v: PxPoint): PxPoint {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

type HandSlot = {
  smoothedOrigin: PxPoint;
  smoothedDir: PxPoint;
  isPinching: boolean;
  lastGoodTime: number;
  debug: { thumb: PxPoint; index: PxPoint; wrist: PxPoint; middleMcp: PxPoint } | null;
};

type PinchMarker = { x: number; y: number };

type HandTrackerProps = {
  onPinchMarkers?: (markers: PinchMarker[]) => void;
  onPointMarkers?: (markers: PinchMarker[]) => void;
  onReady?: () => void;
};

export default function HandTracker({ onPinchMarkers, onPointMarkers, onReady }: HandTrackerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [, setStatus] = useState<string>('Requesting camera access...');

  const onPinchMarkersRef = useRef(onPinchMarkers);
  onPinchMarkersRef.current = onPinchMarkers;
  const onPointMarkersRef = useRef(onPointMarkers);
  onPointMarkersRef.current = onPointMarkers;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    let camera: { stop: () => void } | undefined;
    let hands: any;
    let cancelled = false;

    // Jo bhi frame abhi MediaPipe ko bheja gaya, uska EXACT width/height
    // yahan turant record karte hain -- 'results.image' jaisi kisi
    // indirect/possibly-stale value par bharosa NAHI karte.
    let lastSentWidth = CAPTURE_WIDTH;
    let lastSentHeight = CAPTURE_HEIGHT;

    function useXRCameraSource() {
      return xrPoseEngine.isActive() && xrCameraSource.isSupported();
    }

    let handSlots: HandSlot[] = [];

    // TEMP (measurement only): tracks actual MediaPipe processing FPS —
    // i.e. how often hands.send() completes, not just how often we
    // attempt to call it.
    const mediapipePerf = new PerfCounter('mediapipe');

    async function start() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!canvas) return;

      if (typeof window.Hands === 'undefined') {
        if (!cancelled) setStatus('Failed to load MediaPipe Hands. Reload page.');
        return;
      }

      hands = new window.Hands({
        locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });

      hands.setOptions({
        maxNumHands: MAX_NUM_HANDS,
        modelComplexity: 0,
        minDetectionConfidence: MIN_DETECTION_CONFIDENCE,
        minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
      });

      hands.onResults((results: any) => {
        if (cancelled) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const screenW = window.innerWidth;
        const screenH = window.innerHeight;
        canvas.width = screenW;
        canvas.height = screenH;
        ctx.clearRect(0, 0, screenW, screenH);

        const now = Date.now();

        // STEP 1: source ka size -- jo hum ne ABHI MediaPipe ko bheja
        // (lastSentWidth/Height), 'results.image' se NAHI.
        const sourceW = lastSentWidth;
        const sourceH = lastSentHeight;

        // STEP 2: uniform "cover" scale -- ek hi scale factor dono
        // dimensions ke liye (X/Y alag-alag scale nahi karte).
        const scale = Math.max(screenW / sourceW, screenH / sourceH);
        const offsetX = (screenW - sourceW * scale) / 2;
        const offsetY = (screenH - sourceH * scale) / 2;

        // STEP 3: normalized (0-1) landmark ko seedha screen-pixel mein.
        function toScreen(lm: Landmark): PxPoint {
          return {
            x: lm.x * sourceW * scale + offsetX,
            y: lm.y * sourceH * scale + offsetY,
          };
        }

        const landmarkSets: Landmark[][] = results.multiHandLandmarks || [];
        const handednessSets: any[] = results.multiHandedness || [];
        const markers: PinchMarker[] = [];
        const pointMarkers: PinchMarker[] = [];

        type Detection = {
          origin: PxPoint;
          dir: PxPoint;
          pinchRatio: number;
          debug: { thumb: PxPoint; index: PxPoint; wrist: PxPoint; middleMcp: PxPoint };
        };
        const detections: Detection[] = [];

        for (let i = 0; i < landmarkSets.length; i++) {
          const lm = landmarkSets[i];
          const wristLm = lm[0];
          const thumbLm = lm[4];
          const indexLm = lm[8];
          const middleMcpLm = lm[9];

          const handSize = dist(wristLm, middleMcpLm);
          if (handSize < MIN_HAND_SIZE) continue;

          const pinchRatio = dist(thumbLm, indexLm) / handSize;

          const thumb = toScreen(thumbLm);
          const index = toScreen(indexLm);
          const wrist = toScreen(wristLm);
          const middleMcp = toScreen(middleMcpLm);

          const origin: PxPoint = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
          const dir = normalize({ x: middleMcp.x - wrist.x, y: middleMcp.y - wrist.y });

          detections.push({ origin, dir, pinchRatio, debug: { thumb, index, wrist, middleMcp } });
        }

        // Simplest possible single-hand tracking — koi multi-slot
        // matching complexity nahi, bas 1 hand.
        const detection = detections[0];

        if (detection) {
          let slot = handSlots[0];
          if (!slot) {
            slot = {
              smoothedOrigin: { ...detection.origin },
              smoothedDir: { ...detection.dir },
              isPinching: detection.pinchRatio < PINCH_ENTER_THRESHOLD,
              lastGoodTime: now,
              debug: detection.debug,
            };
            handSlots = [slot];
          } else {
            slot.lastGoodTime = now;
            slot.debug = detection.debug;
            slot.smoothedOrigin.x += (detection.origin.x - slot.smoothedOrigin.x) * SMOOTHING_ALPHA;
            slot.smoothedOrigin.y += (detection.origin.y - slot.smoothedOrigin.y) * SMOOTHING_ALPHA;
            const nd = normalize({
              x: slot.smoothedDir.x + (detection.dir.x - slot.smoothedDir.x) * SMOOTHING_ALPHA,
              y: slot.smoothedDir.y + (detection.dir.y - slot.smoothedDir.y) * SMOOTHING_ALPHA,
            });
            slot.smoothedDir = nd;
            slot.isPinching = slot.isPinching
              ? detection.pinchRatio < PINCH_EXIT_THRESHOLD
              : detection.pinchRatio < PINCH_ENTER_THRESHOLD;
          }

          const rayLength = Math.min(screenW, screenH) * RAY_LENGTH_RATIO;
          const target: PxPoint = {
            x: slot.smoothedOrigin.x + slot.smoothedDir.x * rayLength,
            y: slot.smoothedOrigin.y + slot.smoothedDir.y * rayLength,
          };

          if (slot.isPinching) markers.push(target);
          else pointMarkers.push(target);
        } else {
          // Hand nahi mila is frame mein — FREEZE_MS tak purana slot
          // rakho (flicker se bachne ke liye), uske baad hata do.
          if (handSlots[0] && now - handSlots[0].lastGoodTime > FREEZE_MS) {
            handSlots = [];
          }
        }

        onPinchMarkersRef.current?.(markers);
        onPointMarkersRef.current?.(pointMarkers);

        // ============================ RENDER ============================
        const slot = handSlots[0];
        if (slot) {
          const rayLength = Math.min(screenW, screenH) * RAY_LENGTH_RATIO;
          const origin = slot.smoothedOrigin;
          const target = {
            x: origin.x + slot.smoothedDir.x * rayLength,
            y: origin.y + slot.smoothedDir.y * rayLength,
          };
          const color = slot.isPinching ? '#ff3b30' : '#22d3ee';
          const glow = slot.isPinching ? 'rgba(255,59,48,0.4)' : 'rgba(34,211,238,0.4)';

          ctx.beginPath();
          ctx.moveTo(origin.x, origin.y);
          ctx.lineTo(target.x, target.y);
          ctx.strokeStyle = color;
          ctx.lineWidth = 3.5;
          ctx.shadowColor = color;
          ctx.shadowBlur = 10;
          ctx.stroke();
          ctx.shadowBlur = 0;

          ctx.beginPath();
          ctx.arc(origin.x, origin.y, 6, 0, 2 * Math.PI);
          ctx.fillStyle = '#ffffff';
          ctx.fill();

          ctx.beginPath();
          ctx.arc(target.x, target.y, slot.isPinching ? 16 : 12, 0, 2 * Math.PI);
          ctx.fillStyle = glow;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(target.x, target.y, slot.isPinching ? 7 : 5, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();

          if (DEBUG_HAND_TRACKING && slot.debug) {
            const { thumb, index, wrist, middleMcp } = slot.debug;
            const dot = (p: PxPoint, c: string, label: string) => {
              ctx.beginPath();
              ctx.arc(p.x, p.y, 8, 0, 2 * Math.PI);
              ctx.fillStyle = c;
              ctx.fill();
              ctx.strokeStyle = '#000';
              ctx.lineWidth = 1;
              ctx.stroke();
              ctx.fillStyle = '#fff';
              ctx.font = 'bold 12px sans-serif';
              ctx.fillText(label, p.x + 10, p.y - 10);
            };
            dot(thumb, '#ff0000', 'THUMB');
            dot(index, '#00ff00', 'INDEX');
            dot(wrist, '#ffff00', 'WRIST');
            dot(middleMcp, '#3366ff', 'MCP');
          }
        }
      });

      try {
        await hands.initialize();
      } catch (err) {
        console.error('[HandTracker] Failed to init MediaPipe:', err);
        return;
      }

      if (cancelled) return;

      let xrModeAtStart = useXRCameraSource();
      let pollAttempts = 0;
      while (!xrModeAtStart && xrPoseEngine.isActive() && pollAttempts < 40) {
        await new Promise((r) => setTimeout(r, 100));
        xrModeAtStart = useXRCameraSource();
        pollAttempts++;
      }

      if (xrModeAtStart) {
        let isProcessing = false;
        let lastProcessTime = 0;
        // ROLLBACK (stability se zyada zaroori kuch nahi): pichle
        // kai fixes (independent mediapipeLoop, snapshot-canvas,
        // 8fps/20fps throttle changes) ne mil ke system ko unstable
        // kar diya — world-lock jitter, panel unresponsive, XR render
        // crash jaisा. Bahut saari cheezein ek saath badalne se root
        // cause pakadna mushkil ho gaya tha.
        //
        // Ab wapas simplest, original, PROVEN-STABLE pattern par: XR
        // camera-source jab bhi naya frame "notify" kare, seedha usी
        // subscribe-callback ke andar (synchronously, XR frame ke
        // call-stack ke hisse ke roop mein) hands.send() call karte
        // hain — jaisा shuru se tha. Isका matlab XR render FPS
        // MediaPipe ki speed se kuch bandha rahega (jitna pehle bhi
        // tha), lekin ye COMBINATION hum already lambe time se
        // production mein chala chuke the aur wo stable tha — naya
        // "decoupled" architecture wala prayog isse zyada behtar
        // nahi nikla, ulta naye bugs le aaya. Simplicity > premature
        // optimization.
        const unsubscribe = xrCameraSource.subscribe(async (xrCanvas) => {
          if (cancelled || !xrCanvas || isProcessing) return;

          // Throttle: MediaPipe ko har frame nahi, max ~24fps tak
          // hi bhejte hain — baaki frames sirf skip ho jaate hain
          // (XR ka apna pose/render loop inhe waise hi consume karta
          // rehta hai, hum sirf hand-detection ka extra load kam
          // karte hain).
          const nowMs = performance.now();
          if (nowMs - lastProcessTime < PROCESS_INTERVAL_MS) return;
          lastProcessTime = nowMs;

          // Is exact frame ka size record karo, jo MediaPipe ko bheja
          // jaa raha hai -- onResults() isi ko use karega.
          lastSentWidth = xrCanvas.width;
          lastSentHeight = xrCanvas.height;

          isProcessing = true;
          const __perfStart = DEBUG_PERF_LOG ? performance.now() : 0;
          try {
            await hands.send({ image: xrCanvas });
            if (DEBUG_PERF_LOG) mediapipePerf.record(performance.now() - __perfStart);
          } catch (err) {
            // silent
          } finally {
            isProcessing = false;
          }
        });
        camera = { stop: () => unsubscribe() };
        if (!cancelled) {
          setStatus('');
          onReadyRef.current?.();
        }
        return;
      }

      try {
        if (!video) return;
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: CAPTURE_WIDTH }, height: { ideal: CAPTURE_HEIGHT } },
        });
        video.srcObject = stream;
        await video.play();

        let isProcessing = false;
        let lastProcessTime = 0;
        let rafId = 0;
        const loop = async () => {
          if (cancelled) return;
          const nowMs = performance.now();
          if (video.readyState >= 2 && !isProcessing && nowMs - lastProcessTime >= PROCESS_INTERVAL_MS) {
            lastProcessTime = nowMs;
            lastSentWidth = video.videoWidth || CAPTURE_WIDTH;
            lastSentHeight = video.videoHeight || CAPTURE_HEIGHT;
            isProcessing = true;
            const __perfStart = DEBUG_PERF_LOG ? performance.now() : 0;
            try {
              await hands.send({ image: video });
              if (DEBUG_PERF_LOG) mediapipePerf.record(performance.now() - __perfStart);
            } catch (err) {
              // ignore
            } finally {
              isProcessing = false;
            }
          }
          rafId = requestAnimationFrame(loop);
        };
        rafId = requestAnimationFrame(loop);

        camera = {
          stop: () => {
            cancelAnimationFrame(rafId);
            stream.getTracks().forEach((t) => t.stop());
          },
        };
        if (!cancelled) {
          setStatus('');
          onReadyRef.current?.();
        }
      } catch (err) {
        if (!cancelled) setStatus('Camera access failed.');
      }
    }

    start();

    return () => {
      cancelled = true;
      camera?.stop();
      if (hands && typeof hands.close === 'function') hands.close();
    };
  }, []);

  const xrMode = xrPoseEngine.isActive() && xrCameraSource.isSupported();

  return (
    <>
      <div className={`fixed inset-0 overflow-hidden ${xrMode ? '' : 'bg-black'}`}>
        {!xrMode && (
          <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" playsInline muted autoPlay />
        )}
      </div>
      <canvas
        ref={canvasRef}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          zIndex: 999998,
          pointerEvents: 'none',
        }}
      />
    </>
  );
}
