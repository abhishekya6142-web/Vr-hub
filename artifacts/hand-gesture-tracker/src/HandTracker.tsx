import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// MediaPipe Hands is loaded globally via CDN <script> tags in index.html.
declare global {
  interface Window {
    Hands: any;
    Camera: any;
  }
}

type Landmark = { x: number; y: number; z: number };

// Pinch threshold: thumb tip (4) to index tip (8) distance, normalized by
// hand size (wrist [0] to middle-finger MCP [9] distance) so it works
// consistently regardless of how far the hand is from the camera.
const PINCH_THRESHOLD = 0.35;

// Distance filter: wrist-to-middle-MCP distance (normalized 0-1 image
// coordinates) below this is treated as "too far from camera" and the hand
// is ignored entirely. Tune this value to taste.
const MIN_HAND_SIZE = 0.08;

function dist(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// --- Cursor smoothing/stability tuning --------------------------------
// Only landmark 4 (thumb tip) and landmark 8 (index tip) ever feed the
// cursor dots below — no other landmark from the 21-point hand model is
// read for this purpose, even while a hand is frozen/unconfirmed.

// EXPONENTIAL SMOOTHING: weight given to each new raw reading per frame.
// smoothed = smoothed * (1 - SMOOTHING_ALPHA) + raw * SMOOTHING_ALPHA
const SMOOTHING_ALPHA = 0.3;

// OUTLIER REJECTION: a single-frame jump larger than this fraction of the
// screen's largest dimension is treated as a likely misdetection and
// skipped, unless the same jump is confirmed again on the very next frame.
const JUMP_REJECT_RATIO = 0.15;

// CONFIDENCE-BASED FREEZE: below this handedness confidence score, a
// previously-tracked hand's cursor freezes at its last good position
// instead of updating or disappearing outright.
const CONFIDENCE_THRESHOLD = 0.8;

// How long (ms) a hand may stay frozen — via low confidence or a missed
// detection — before its cursor is actually removed.
const FREEZE_MS = 200;

// How far (as a fraction of the screen's largest dimension) a hand's index
// tip may move between frames and still be considered the same tracked
// hand, so two hands don't get their identities swapped between frames.
const MATCH_DISTANCE_RATIO = 0.35;

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

// Applies exponential smoothing with outlier rejection to one tracked
// point (thumb or index tip) of a hand slot, returning the new smoothed
// position. Mutates the slot's `pending*` field as a side effect to track
// an outlier candidate awaiting next-frame confirmation.
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
    // Big single-frame jump — only accept it if the SAME large jump shows
    // up again next frame (a real fast movement), otherwise keep showing
    // the last good smoothed position for this one frame.
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
  // Fired every processed frame with pinch marker positions converted to
  // *client/viewport* pixel coordinates (matching getBoundingClientRect()),
  // so callers can hit-test DOM elements without knowing anything about the
  // canvas's internal resolution or object-cover scaling.
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

  // One-time confirmation that the cursor-overlay canvas is mounted as a
  // direct child of <body> (via portal below), appended last in the DOM, so
  // it always paints above every other element regardless of stacking
  // contexts created by app windows, the dock, or anything else.
  useEffect(() => {
    if (canvasRef.current) {
      console.log(
        '[HandTracker] cursor overlay canvas parentElement === document.body:',
        canvasRef.current.parentElement === document.body,
      );
    }
  }, []);

  useEffect(() => {
    let camera: any;
    let hands: any;
    let cancelled = false;

    // Converts a normalized (0-1) landmark coordinate into a *client/
    // viewport* pixel coordinate, accounting for the object-cover scaling
    // between the canvas's internal resolution (video's native size) and
    // its displayed CSS box. This is what lets pinch markers line up with
    // real DOM element bounding rects for dwell hit-testing.
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

    // Persistent per-hand smoothing state, carried across frames for the
    // lifetime of this camera session.
    let handSlots: HandSlot[] = [];

    async function start() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;

      if (typeof window.Hands === 'undefined' || typeof window.Camera === 'undefined') {
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

        // Only landmark 4 (thumb tip) and landmark 8 (index tip) are ever
        // read here — no other landmark from the 21-point model influences
        // cursor position or gets drawn.
        for (let i = 0; i < landmarkSets.length; i++) {
          const landmarks = landmarkSets[i];
          const wrist = landmarks[0];
          const middleMcp = landmarks[9];
          const handSize = dist(wrist, middleMcp);

          // Distance filter: skip hands that are too small/far away, as if
          // they weren't detected at all.
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

        // --- Match this frame's detections to persistent hand slots ----
        // (nearest index-tip position) so smoothing/outlier state stays
        // attached to the same physical hand across frames instead of
        // resetting whenever MediaPipe reorders its results array.
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
            if (!detection.confident) continue; // don't trust a brand-new, low-confidence hand
            // Brand-new hand — seed the slot with this frame's raw
            // position so it doesn't slide in from (0, 0).
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
            // CONFIDENCE-BASED FREEZE: keep showing the last good smoothed
            // position instead of updating from this shaky reading. The
            // pruning step below removes the slot only once it's stayed
            // unconfident/undetected for longer than FREEZE_MS.
            continue;
          }

          slot.isPinching = detection.isPinching;
          slot.lastGoodTime = now;
          slot.smoothedThumb = smoothPoint(slot, 'thumb', detection.thumbPx, jumpThreshold);
          slot.smoothedIndex = smoothPoint(slot, 'index', detection.indexPx, jumpThreshold);
        }

        // Unmatched existing slots (hand momentarily lost from detection
        // entirely) also freeze at their last good position rather than
        // vanishing immediately — same FREEZE_MS grace period applies via
        // the prune below, since their lastGoodTime simply stops advancing.

        // --- Prune hands that stayed unconfident/undetected too long ---
        handSlots = handSlots.filter((slot) => now - slot.lastGoodTime <= FREEZE_MS);

        // --- Draw --------------------------------------------------------
        // No hand skeleton — just a small glowing dot at the smoothed
        // thumb tip and one at the smoothed index fingertip per tracked
        // hand, so together they read like a two-point mouse cursor. They
        // brighten to red when pinched, giving the same "click" feedback
        // the old reticle did.
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

      camera = new window.Camera(video, {
        onFrame: async () => {
          await hands.send({ image: video });
        },
        facingMode: 'environment',
        width: 1280,
        height: 720,
      });

      try {
        await camera.start();
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
      if (camera && typeof camera.stop === 'function') {
        camera.stop();
      }
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

      {/* Cursor-overlay canvas: portaled directly onto <body> (as the very
          last child, since React appends portal content after whatever was
          already there at mount time) so it lives OUTSIDE the app's normal
          component tree entirely. No ancestor here can create a stacking
          context that traps it — its z-index is compared against the whole
          page, not just siblings inside VRHub. It never unmounts/remounts
          when switching between home screen, app windows, or real-world
          mode, since HandTracker itself is always mounted; drawing keeps
          running continuously in the background regardless of which screen
          is visible. */}
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
