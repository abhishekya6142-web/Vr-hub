import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

declare global {
  interface Window {
    Hands: any;
    Camera: any;
  }
}

type Landmark = { x: number; y: number; z: number };

const PINCH_THRESHOLD = 0.35;
const MIN_HAND_SIZE = 0.08;

function dist(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const SMOOTHING_ALPHA = 0.3;
const JUMP_REJECT_RATIO = 0.15;
const CONFIDENCE_THRESHOLD = 0.8;
const FREEZE_MS = 200;
const MATCH_DISTANCE_RATIO = 0.35;

// PERFORMANCE: skip hand-detection on every Nth frame. The visual cursor
// still redraws every animation frame using the last known smoothed
// position in between — only the (expensive) MediaPipe inference itself
// is throttled, so movement still looks continuous, not stepped.
const DETECT_EVERY_N_FRAMES = 1;

// PERFORMANCE: camera capture resolution fed into MediaPipe. Smaller
// frames are much cheaper to run inference on. The displayed <video>
// still shows whatever the selected camera/lens natively provides — this
// only affects the requested capture constraints.
const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 480;
type PxPoint = { x: number; y: number };

function pxDist(a: PxPoint, b: PxPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

type HandSlot = {
  smoothedThumb: PxPoint;
  smoothedIndex: PxPoint;
  pendingThumb: PxPoint | null;
  pendingIndex: PxPoint | null;
  isPinching: boolean;
  lastGoodTime: number;
};

function smoothPoint(
  slot: HandSlot,
  which: 'thumb' | 'index',
  raw: PxPoint,
  jumpThreshold: number,
): PxPoint {
  const current = which === 'thumb' ? slot.smoothedThumb : slot.smoothedIndex;
  const pending = which === 'thumb' ? slot.pendingThumb : slot.pendingIndex;
  const jump = pxDist(raw, current);

  if (jump > jumpThreshold) {
    if (pending && pxDist(raw, pending) <= jumpThreshold) {
      if (which === 'thumb') slot.pendingThumb = null;
      else slot.pendingIndex = null;
      return {
        x: current.x * (1 - SMOOTHING_ALPHA) + raw.x * SMOOTHING_ALPHA,
        y: current.y * (1 - SMOOTHING_ALPHA) + raw.y * SMOOTHING_ALPHA,
      };
    }
    if (which === 'thumb') slot.pendingThumb = raw;
    else slot.pendingIndex = raw;
    return current;
  }

  if (which === 'thumb') slot.pendingThumb = null;
  else slot.pendingIndex = null;
  return {
    x: current.x * (1 - SMOOTHING_ALPHA) + raw.x * SMOOTHING_ALPHA,
    y: current.y * (1 - SMOOTHING_ALPHA) + raw.y * SMOOTHING_ALPHA,
  };
}

type PinchMarker = { x: number; y: number };

type HandTrackerProps = {
  onPinchMarkers?: (markers: PinchMarker[]) => void;
  onReady?: () => void;
};

export default function HandTracker({ onPinchMarkers, onReady }: HandTrackerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<string>('Requesting camera access...');
  const onPinchMarkersRef = useRef(onPinchMarkers);
  onPinchMarkersRef.current = onPinchMarkers;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    let camera: { stop: () => void } | undefined;
    let hands: any;
    let cancelled = false;
    let frameCounter = 0;

    function toScreenCoords(
      nx: number,
      ny: number,
      video: HTMLVideoElement,
      canvas: HTMLCanvasElement,
    ) {
      const vw = video.videoWidth || canvas.width;
      const vh = video.videoHeight || canvas.height;
      const rect = canvas.getBoundingClientRect();
      const scale = Math.max(rect.width / vw, rect.height / vh);
      const offsetX = (vw * scale - rect.width) / 2;
      const offsetY = (vh * scale - rect.height) / 2;
      return {
        x: nx * vw * scale - offsetX + rect.left,
        y: ny * vh * scale - offsetY + rect.top,
      };
    }

    let handSlots: HandSlot[] = [];

    async function pickWidestCameraStream(): Promise<MediaStream> {
      try {
        let devices = await navigator.mediaDevices.enumerateDevices();
        let videoInputs = devices.filter((d) => d.kind === 'videoinput');

        if (videoInputs.length > 0 && videoInputs.every((d) => !d.label)) {
          const probe = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
          });
          probe.getTracks().forEach((t) => t.stop());
          devices = await navigator.mediaDevices.enumerateDevices();
          videoInputs = devices.filter((d) => d.kind === 'videoinput');
        }

        function wideScore(label: string) {
          const l = label.toLowerCase();
          if (l.includes('ultra') || l.includes('0.5') || l.includes('0,5')) return 3;
          if (l.includes('wide')) return 2;
          if (l.includes('back') || l.includes('rear') || l.includes('environment')) return 1;
          return 0;
        }

        const sorted = [...videoInputs].sort(
          (a, b) => wideScore(b.label) - wideScore(a.label),
        );
        const chosen = sorted[0];

        const constraints: MediaStreamConstraints = chosen
          ? {
              video: {
                deviceId: { exact: chosen.deviceId },
                width: { ideal: CAPTURE_WIDTH },
                height: { ideal: CAPTURE_HEIGHT },
              },
            }
          : {
              video: {
                facingMode: 'environment',
                width: { ideal: CAPTURE_WIDTH },
                height: { ideal: CAPTURE_HEIGHT },
              },
            };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);

        const [track] = stream.getVideoTracks();
        const caps: any = track.getCapabilities ? track.getCapabilities() : {};
        if (caps && typeof caps.zoom !== 'undefined') {
          const minZoom = Array.isArray(caps.zoom) ? caps.zoom[0] : caps.zoom.min;
          if (typeof minZoom === 'number') {
            try {
              await track.applyConstraints({ advanced: [{ zoom: minZoom }] } as any);
            } catch {
              // best-effort only
            }
          }
        }

        return stream;
      } catch {
        return navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: CAPTURE_WIDTH },
            height: { ideal: CAPTURE_HEIGHT },
          },
        });
      }
    }

    async function start() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;

      if (typeof window.Hands === 'undefined') {
        if (!cancelled) {
          setStatus('Failed to load MediaPipe Hands from CDN. Check your connection and reload.');
        }
        return;
      }

      hands = new window.Hands({
        locateFile: (file: string) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });

      hands.setOptions({
        maxNumHands: 2,
        modelComplexity: 0,
        minDetectionConfidence: 0.75,
        minTrackingConfidence: 0.7,
      });

      hands.onResults((results: any) => {
        if (cancelled) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = video.videoWidth || window.innerWidth;
        canvas.height = video.videoHeight || window.innerHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const now = Date.now();
        const jumpThreshold = JUMP_REJECT_RATIO * Math.max(canvas.width, canvas.height);
        const matchThreshold = MATCH_DISTANCE_RATIO * Math.max(canvas.width, canvas.height);

        const landmarkSets: Landmark[][] = results.multiHandLandmarks || [];
        const handednessSets: any[] = results.multiHandedness || [];
        const markers: PinchMarker[] = [];

        type Detection = {
          thumbPx: PxPoint;
          indexPx: PxPoint;
          isPinching: boolean;
          confident: boolean;
        };
        const detections: Detection[] = [];

        for (let i = 0; i < landmarkSets.length; i++) {
          const landmarks = landmarkSets[i];
          const wrist = landmarks[0];
          const middleMcp = landmarks[9];
          const handSize = dist(wrist, middleMcp);

          if (handSize < MIN_HAND_SIZE) continue;

          const thumbTip = landmarks[4];
          const indexTip = landmarks[8];
          const pinchDistance = dist(thumbTip, indexTip);
          const isPinching = pinchDistance / handSize < PINCH_THRESHOLD;
          const confidence = handednessSets[i]?.score ?? 1;

          if (isPinching) {
            const screen = toScreenCoords(
              (thumbTip.x + indexTip.x) / 2,
              (thumbTip.y + indexTip.y) / 2,
              video,
              canvas,
            );
            markers.push({ x: screen.x, y: screen.y });
          }

          detections.push({
            thumbPx: { x: thumbTip.x * canvas.width, y: thumbTip.y * canvas.height },
            indexPx: { x: indexTip.x * canvas.width, y: indexTip.y * canvas.height },
            isPinching,
            confident: confidence >= CONFIDENCE_THRESHOLD,
          });
        }

        onPinchMarkersRef.current?.(markers);

        const unmatchedSlots = new Set(handSlots);
        const slotForDetection = new Map<Detection, HandSlot>();

        for (const detection of detections) {
          let best: HandSlot | null = null;
          let bestDist = Infinity;
          for (const slot of unmatchedSlots) {
            const d = pxDist(detection.indexPx, slot.smoothedIndex);
            if (d < bestDist) {
              bestDist = d;
              best = slot;
            }
          }
          if (best && bestDist <= matchThreshold) {
            slotForDetection.set(detection, best);
            unmatchedSlots.delete(best);
          }
        }

        for (const detection of detections) {
          let slot = slotForDetection.get(detection) ?? null;

          if (!slot) {
            if (!detection.confident) continue;
            slot = {
              smoothedThumb: { ...detection.thumbPx },
              smoothedIndex: { ...detection.indexPx },
              pendingThumb: null,
              pendingIndex: null,
              isPinching: detection.isPinching,
              lastGoodTime: now,
            };
            handSlots.push(slot);
            continue;
          }

          if (!detection.confident) {
            continue;
          }

          slot.isPinching = detection.isPinching;
          slot.lastGoodTime = now;
          slot.smoothedThumb = smoothPoint(slot, 'thumb', detection.thumbPx, jumpThreshold);
          slot.smoothedIndex = smoothPoint(slot, 'index', detection.indexPx, jumpThreshold);
        }

        handSlots = handSlots.filter((slot) => now - slot.lastGoodTime <= FREEZE_MS);

        for (const slot of handSlots) {
          const dotColor = slot.isPinching ? '#ff3b30' : '#4da3ff';
          const glowColor = slot.isPinching
            ? 'rgba(255, 59, 48, 0.3)'
            : 'rgba(77, 163, 255, 0.25)';
          for (const p of [slot.smoothedThumb, slot.smoothedIndex]) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 12, 0, 2 * Math.PI);
            ctx.fillStyle = glowColor;
            ctx.fill();

            ctx.beginPath();
            ctx.arc(p.x, p.y, 5, 0, 2 * Math.PI);
            ctx.fillStyle = dotColor;
            ctx.shadowColor = dotColor;
            ctx.shadowBlur = 10;
            ctx.fill();
            ctx.shadowBlur = 0;
          }
        }
      });

      try {
        const stream = await pickWidestCameraStream();
        video.srcObject = stream;
        await video.play();

        let rafId = 0;
        const loop = async () => {
          if (cancelled) return;
          frameCounter++;
          if (video.readyState >= 2 && frameCounter % DETECT_EVERY_N_FRAMES === 0) {
            await hands.send({ image: video });
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
        console.error(err);
        if (!cancelled) {
          setStatus(
            'Camera access failed. Grant camera permission and reload the page.',
          );
        }
      }
    }

    start();

    return () => {
      cancelled = true;
      camera?.stop();
      if (hands && typeof hands.close === 'function') {
        hands.close();
      }
    };
  }, []);

  return (
    <>
      <div className="fixed inset-0 overflow-hidden bg-black">
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-cover"
          playsInline
          muted
          autoPlay
        />

        {status && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 px-6 text-center">
            <p className="text-lg font-medium text-white">{status}</p>
          </div>
        )}
      </div>

      {typeof document !== 'undefined' &&
        createPortal(
          <canvas
            ref={canvasRef}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              zIndex: 999999,
              pointerEvents: 'none',
              objectFit: 'cover',
            }}
          />,
          document.body,
        )}
    </>
  );
                }
