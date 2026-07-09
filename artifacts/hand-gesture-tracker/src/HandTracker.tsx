import { useEffect, useRef, useState } from 'react';

// MediaPipe Hands is loaded globally via CDN <script> tags in index.html.
declare global {
  interface Window {
    Hands: any;
    Camera: any;
  }
}

type Landmark = { x: number; y: number; z: number };
type HandLabel = 'Left' | 'Right';
type SlotId = 'A' | 'B';

const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

// Landmark indices for each finger: [mcp, pip, tip] (thumb uses cmc/mcp/tip)
const FINGERS = {
  thumb: { tip: 4, ip: 3, mcp: 2 },
  index: { tip: 8, pip: 6, mcp: 5 },
  middle: { tip: 12, pip: 10, mcp: 9 },
  ring: { tip: 16, pip: 14, mcp: 13 },
  pinky: { tip: 20, pip: 18, mcp: 17 },
};

// Minimum confidence required to accept a detection at all.
const DETECTION_ACCEPT_THRESHOLD = 0.8;
// Minimum confidence + consecutive frames required to mark a hand calibrated.
const CALIBRATION_SCORE_THRESHOLD = 0.85;
const CALIBRATION_FRAMES_REQUIRED = 20;
// Consecutive frames a gesture must repeat before it's "confirmed" on screen.
const GESTURE_CONFIRM_FRAMES = 2;

// --- Spatial identity tracking + label voting ---
// A "slot" is a persistent tracked hand identity, matched frame-to-frame by
// wrist position rather than by trusting MediaPipe's per-frame handedness
// label (which flickers, especially on an unmirrored back-camera feed).
const SLOT_IDS: SlotId[] = ['A', 'B'];
// Nearest-neighbor match radius in normalized (0-1) image coordinates.
const MAX_MATCH_DISTANCE = 0.35;
// Clear a slot if it goes unmatched for this many consecutive frames.
const MAX_MISSING_FRAMES = 10;
// Cost assigned to matching a detection into a free (inactive) slot -- high
// enough that an active slot's real nearest match always wins the
// assignment, but finite so free slots still get used.
const FREE_SLOT_COST = 1;
// Rolling buffer size for the label vote.
const LABEL_BUFFER_SIZE = 15;
// Minimum votes in the buffer before a slot's label is trusted/displayed.
const LABEL_VOTE_MIN_SAMPLES = 10;

function dist(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isFingerExtended(
  landmarks: Landmark[],
  tip: number,
  pip: number,
  mcp: number,
  wrist: Landmark,
): boolean {
  // A finger is "extended" when its tip is farther from the wrist than its
  // pip/mcp joint is -- a simple, orientation-tolerant heuristic.
  return dist(landmarks[tip], wrist) > dist(landmarks[pip], wrist) * 1.1 &&
    dist(landmarks[tip], wrist) > dist(landmarks[mcp], wrist);
}

function detectGesture(landmarks: Landmark[]): string {
  const wrist = landmarks[0];

  const thumbExtended = isFingerExtended(
    landmarks,
    FINGERS.thumb.tip,
    FINGERS.thumb.ip,
    FINGERS.thumb.mcp,
    wrist,
  );
  const indexExtended = isFingerExtended(
    landmarks,
    FINGERS.index.tip,
    FINGERS.index.pip,
    FINGERS.index.mcp,
    wrist,
  );
  const middleExtended = isFingerExtended(
    landmarks,
    FINGERS.middle.tip,
    FINGERS.middle.pip,
    FINGERS.middle.mcp,
    wrist,
  );
  const ringExtended = isFingerExtended(
    landmarks,
    FINGERS.ring.tip,
    FINGERS.ring.pip,
    FINGERS.ring.mcp,
    wrist,
  );
  const pinkyExtended = isFingerExtended(
    landmarks,
    FINGERS.pinky.tip,
    FINGERS.pinky.pip,
    FINGERS.pinky.mcp,
    wrist,
  );

  const extendedCount = [
    thumbExtended,
    indexExtended,
    middleExtended,
    ringExtended,
    pinkyExtended,
  ].filter(Boolean).length;

  // Pinch: thumb tip and index tip close together, relative to hand size.
  // Only counts when the other three fingers are not also curled into a
  // fist, so a closed fist doesn't get misread as a pinch.
  const handSpan = dist(landmarks[0], landmarks[9]);
  const pinchDistance = dist(landmarks[4], landmarks[8]);
  const isPinch =
    handSpan > 0 &&
    pinchDistance / handSpan < 0.35 &&
    (middleExtended || ringExtended || pinkyExtended || extendedCount >= 2);
  if (isPinch) {
    return 'PINCH';
  }

  if (extendedCount >= 4) return 'OPEN PALM';
  if (extendedCount === 0) return 'FIST';
  if (indexExtended && !middleExtended && !ringExtended && !pinkyExtended) {
    return 'POINTING';
  }
  return 'UNKNOWN';
}

// Persistent per-slot state, kept in a ref (not React state) since it's
// updated every frame.
type TrackedSlot = {
  id: SlotId;
  wrist: Landmark | null;
  framesSinceSeen: number;
  // Rolling buffer of inverted (back-camera-corrected) labels seen for this
  // spatially tracked hand; the slot's displayed label is the buffer
  // majority, not the current frame's raw label.
  labelBuffer: HandLabel[];
  votedLabel: HandLabel | null;
  lastCandidateGesture: string;
  candidateStreak: number;
  confirmedGesture: string;
  calibrationStreak: number;
  calibrated: boolean;
  baseline: number | null;
};

function makeSlot(id: SlotId): TrackedSlot {
  return {
    id,
    wrist: null,
    framesSinceSeen: 0,
    labelBuffer: [],
    votedLabel: null,
    lastCandidateGesture: 'NO HAND',
    candidateStreak: 0,
    confirmedGesture: 'NO HAND',
    calibrationStreak: 0,
    calibrated: false,
    baseline: null,
  };
}

function resetSlot(slot: TrackedSlot) {
  slot.wrist = null;
  slot.framesSinceSeen = 0;
  slot.labelBuffer = [];
  slot.votedLabel = null;
  slot.lastCandidateGesture = 'NO HAND';
  slot.candidateStreak = 0;
  slot.confirmedGesture = 'NO HAND';
  slot.calibrationStreak = 0;
  // A slot that's gone unmatched long enough to be cleared has lost its
  // spatial identity -- whatever hand reuses this slot next may not be the
  // same physical hand, so calibration must not carry over.
  slot.calibrated = false;
  slot.baseline = null;
}

function majorityLabel(buffer: HandLabel[], fallback: HandLabel | null): HandLabel | null {
  if (buffer.length < LABEL_VOTE_MIN_SAMPLES) return fallback;
  let leftCount = 0;
  let rightCount = 0;
  for (const label of buffer) {
    if (label === 'Left') leftCount += 1;
    else rightCount += 1;
  }
  if (leftCount === rightCount) return fallback ?? buffer[buffer.length - 1];
  return leftCount > rightCount ? 'Left' : 'Right';
}

type Detection = {
  landmarks: Landmark[];
  wrist: Landmark;
  score: number;
  rawLabel: HandLabel;
};

// Optimal one-to-one assignment of detections to slots (at most 2 of each,
// so exhaustive search is cheap). Prefers matching an active slot to its
// nearest detection within its (growing) match radius; only falls back to a
// free slot when no active slot claims a detection. Chosen over a naive
// greedy nearest-first pass because greedy can lock in a locally-best pair
// that blocks the only feasible match for the other slot.
function assignDetections(
  slots: TrackedSlot[],
  detections: Detection[],
): Array<Detection | null> {
  const n = slots.length;
  const result: Array<Detection | null> = new Array(n).fill(null);
  if (detections.length === 0) return result;

  const matchRadius = (slot: TrackedSlot) =>
    // Widen the acceptable match radius the longer a slot has gone
    // unmatched, so a hand that moved quickly (or was briefly occluded) can
    // still be reacquired instead of being permanently blocked by a fixed
    // threshold.
    MAX_MATCH_DISTANCE * (1 + slot.framesSinceSeen * 0.15);

  const isValidPair = (slot: TrackedSlot, det: Detection) =>
    !slot.wrist || dist(slot.wrist, det.wrist) <= matchRadius(slot);
  const pairCost = (slot: TrackedSlot, det: Detection) =>
    slot.wrist ? dist(slot.wrist, det.wrist) : FREE_SLOT_COST;

  type Assignment = Array<number | null>; // per slot index: detection index or null
  type BestResult = { assignment: Assignment; matched: number; cost: number };
  const bestHolder: { current: BestResult | null } = { current: null };

  function evaluate(assignment: Assignment) {
    let matched = 0;
    let cost = 0;
    for (let i = 0; i < n; i += 1) {
      const detIdx = assignment[i];
      if (detIdx === null) continue;
      if (!isValidPair(slots[i], detections[detIdx])) return; // invalid combo
      matched += 1;
      cost += pairCost(slots[i], detections[detIdx]);
    }
    const current = bestHolder.current;
    if (
      !current ||
      matched > current.matched ||
      (matched === current.matched && cost < current.cost)
    ) {
      bestHolder.current = { assignment: [...assignment], matched, cost };
    }
  }

  function backtrack(slotIdx: number, used: Set<number>, assignment: Assignment) {
    if (slotIdx === n) {
      evaluate(assignment);
      return;
    }
    assignment[slotIdx] = null;
    backtrack(slotIdx + 1, used, assignment);
    for (let d = 0; d < detections.length; d += 1) {
      if (used.has(d)) continue;
      used.add(d);
      assignment[slotIdx] = d;
      backtrack(slotIdx + 1, used, assignment);
      used.delete(d);
    }
    assignment[slotIdx] = null;
  }

  backtrack(0, new Set(), new Array(n).fill(null));

  if (bestHolder.current) {
    bestHolder.current.assignment.forEach((detIdx, slotIdx) => {
      if (detIdx !== null) result[slotIdx] = detections[detIdx];
    });
  }
  return result;
}

export default function HandTracker() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<string>('Requesting camera access...');
  const [phase, setPhase] = useState<'calibrating' | 'tracking'>('calibrating');
  const [gestures, setGestures] = useState<Record<HandLabel, string>>({
    Left: 'NO HAND',
    Right: 'NO HAND',
  });
  const [fingertips, setFingertips] = useState<
    Record<HandLabel, { x: number; y: number } | null>
  >({ Left: null, Right: null });
  const [fps, setFps] = useState<number>(0);
  const [calibrated, setCalibrated] = useState<Record<HandLabel, boolean>>({
    Left: false,
    Right: false,
  });

  const slotsRef = useRef<Record<SlotId, TrackedSlot>>({
    A: makeSlot('A'),
    B: makeSlot('B'),
  });
  const phaseRef = useRef<'calibrating' | 'tracking'>('calibrating');
  // Dev-only: last raw MediaPipe label seen per slot, to spot-check the
  // back-camera inversion without spamming the console every frame.
  const rawLabelLogRef = useRef<Record<SlotId, string | undefined>>({
    A: undefined,
    B: undefined,
  });

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    let camera: any;
    let hands: any;
    let cancelled = false;

    let frameCount = 0;
    let lastFpsTime = performance.now();

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

        const landmarkSets: Landmark[][] = results.multiHandLandmarks || [];
        const handednessList: any[] = results.multiHandedness || [];
        const slots = slotsRef.current;

        // Build the accepted detections for this frame (confidence-gated),
        // each carrying its wrist position, landmarks, score, and the
        // back-camera-corrected raw label.
        const detections: Detection[] = [];
        for (let i = 0; i < landmarkSets.length; i += 1) {
          const handedness = handednessList[i];
          if (!handedness) continue;
          const score: number = handedness.score ?? 0;
          // Ignore low-confidence detections entirely (likely a leg, arm, or
          // other body part misread as a hand).
          if (score < DETECTION_ACCEPT_THRESHOLD) continue;

          // MediaPipe's handedness label assumes a mirrored/selfie-style
          // image. We're using the unmirrored back camera, so the raw label
          // is backwards relative to the viewer -- invert it here. This is
          // just one vote in the per-slot majority buffer, not the final
          // displayed label.
          const rawLabel: HandLabel = handedness.label === 'Left' ? 'Right' : 'Left';
          const landmarks = landmarkSets[i];
          detections.push({ landmarks, wrist: landmarks[0], score, rawLabel });
        }

        // --- Spatial identity tracking: match detections to existing slots
        // by wrist position (optimal one-to-one assignment) rather than
        // relabeling from scratch each frame. A detection with no feasible
        // active-slot match goes into a free slot -- a genuinely new hand
        // entering frame. ---
        const slotList = SLOT_IDS.map((id) => slots[id]);
        const matchedDetection = assignDetections(slotList, detections);

        const nextGestures: Record<HandLabel, string> = {
          Left: 'NO HAND',
          Right: 'NO HAND',
        };
        const nextFingertips: Record<HandLabel, { x: number; y: number } | null> = {
          Left: null,
          Right: null,
        };
        const nextCalibrated: Record<HandLabel, boolean> = {
          Left: false,
          Right: false,
        };
        const slotOutputs: Array<{
          label: HandLabel;
          confidence: number;
          gesture: string;
          fingertip: { x: number; y: number };
          calibrated: boolean;
        }> = [];

        slotList.forEach((slot, slotIdx) => {
          const det = matchedDetection[slotIdx];

          if (!det) {
            // No detection matched this slot this frame.
            slot.framesSinceSeen += 1;
            if (slot.framesSinceSeen > MAX_MISSING_FRAMES) {
              resetSlot(slot);
            }
            return;
          }

          slot.wrist = det.wrist;
          slot.framesSinceSeen = 0;

          // Label voting: push this frame's (already inverted) label into
          // the rolling buffer and recompute the majority. The displayed
          // label only updates once the buffer has enough samples, so a
          // freshly (re)tracked hand doesn't flicker before it has data.
          slot.labelBuffer.push(det.rawLabel);
          if (slot.labelBuffer.length > LABEL_BUFFER_SIZE) {
            slot.labelBuffer.shift();
          }
          slot.votedLabel = majorityLabel(slot.labelBuffer, slot.votedLabel);

          if (import.meta.env.DEV) {
            const logKey = `${det.rawLabel}:${slot.votedLabel}`;
            if (rawLabelLogRef.current[slot.id] !== logKey) {
              rawLabelLogRef.current[slot.id] = logKey;
              console.debug(
                `[hand-tracker] slot=${slot.id} rawVote="${det.rawLabel}" votedLabel="${slot.votedLabel ?? 'pending'}" (buffer=${slot.labelBuffer.length})`,
              );
            }
          }

          const landmarks = det.landmarks;
          const label = slot.votedLabel;

          if (phaseRef.current === 'calibrating') {
            if (det.score >= CALIBRATION_SCORE_THRESHOLD) {
              slot.calibrationStreak += 1;
            } else {
              slot.calibrationStreak = 0;
            }
            if (
              slot.calibrationStreak >= CALIBRATION_FRAMES_REQUIRED &&
              !slot.calibrated
            ) {
              slot.calibrated = true;
              slot.baseline = dist(landmarks[0], landmarks[9]);
            }
          }

          // Draw connections + points regardless of whether the label has
          // locked in yet -- the hand is real, just not confidently labeled.
          const drawColor = label === 'Left' ? '#00e0a4' : label === 'Right' ? '#4da3ff' : '#cccccc';
          ctx.strokeStyle = drawColor;
          ctx.lineWidth = 3;
          for (const [a, b] of HAND_CONNECTIONS) {
            const p1 = landmarks[a];
            const p2 = landmarks[b];
            ctx.beginPath();
            ctx.moveTo(p1.x * canvas.width, p1.y * canvas.height);
            ctx.lineTo(p2.x * canvas.width, p2.y * canvas.height);
            ctx.stroke();
          }

          ctx.fillStyle = '#ffb703';
          for (const point of landmarks) {
            ctx.beginPath();
            ctx.arc(
              point.x * canvas.width,
              point.y * canvas.height,
              5,
              0,
              2 * Math.PI,
            );
            ctx.fill();
          }

          const tip = landmarks[FINGERS.index.tip];
          const tipX = tip.x * canvas.width;
          const tipY = tip.y * canvas.height;
          ctx.beginPath();
          ctx.arc(tipX, tipY, 10, 0, 2 * Math.PI);
          ctx.strokeStyle = '#ff3b30';
          ctx.lineWidth = 3;
          ctx.stroke();

          // Temporal filter -- only "confirm" a gesture once it has repeated
          // for GESTURE_CONFIRM_FRAMES consecutive frames, to suppress
          // single-frame flicker/false positives.
          const candidateGesture = detectGesture(landmarks);
          if (candidateGesture === slot.lastCandidateGesture) {
            slot.candidateStreak += 1;
          } else {
            slot.lastCandidateGesture = candidateGesture;
            slot.candidateStreak = 1;
          }
          if (slot.candidateStreak >= GESTURE_CONFIRM_FRAMES) {
            slot.confirmedGesture = candidateGesture;
          }

          if (label) {
            slotOutputs.push({
              label,
              confidence: slot.labelBuffer.length,
              gesture: slot.confirmedGesture,
              fingertip: { x: Math.round(tipX), y: Math.round(tipY) },
              calibrated: slot.calibrated,
            });
          }
        });

        // Resolve label collisions: two slots could transiently vote the
        // same label (e.g. right after hands cross). Rather than letting a
        // later write silently overwrite an earlier one, the more
        // confident slot (larger vote buffer) claims the label; the other
        // slot's data is withheld for this frame instead of bleeding into
        // the wrong side.
        const claimedLabels = new Set<HandLabel>();
        slotOutputs
          .sort((a, b) => b.confidence - a.confidence)
          .forEach((output) => {
            if (claimedLabels.has(output.label)) return;
            claimedLabels.add(output.label);
            nextGestures[output.label] = output.gesture;
            nextFingertips[output.label] = output.fingertip;
            nextCalibrated[output.label] = output.calibrated;
          });

        setGestures(nextGestures);
        setFingertips(nextFingertips);
        setCalibrated(nextCalibrated);

        // Auto-transition once both hands are calibrated.
        if (
          phaseRef.current === 'calibrating' &&
          nextCalibrated.Left &&
          nextCalibrated.Right
        ) {
          phaseRef.current = 'tracking';
          setPhase('tracking');
        }

        frameCount += 1;
        const now = performance.now();
        if (now - lastFpsTime >= 1000) {
          setFps(Math.round((frameCount * 1000) / (now - lastFpsTime)));
          frameCount = 0;
          lastFpsTime = now;
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
        if (!cancelled) setStatus('');
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

  function skipCalibration() {
    phaseRef.current = 'tracking';
    setPhase('tracking');
  }

  const bothCalibrated = calibrated.Left && calibrated.Right;

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-cover"
        playsInline
        muted
        autoPlay
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full object-cover"
      />

      {status && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 px-6 text-center">
          <p className="text-lg font-medium text-white">{status}</p>
        </div>
      )}

      {!status && phase === 'calibrating' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-black/70 px-6 text-center">
          <h1 className="text-2xl font-bold text-white">Calibration</h1>
          <p className="max-w-sm text-base text-white/80">
            Show both hands to the camera and hold them steady.
          </p>

          <div className="flex flex-col gap-3 font-mono text-sm">
            <div
              className={`rounded-md px-4 py-2 ${
                calibrated.Left
                  ? 'bg-[#00e0a4]/20 text-[#00e0a4]'
                  : 'bg-white/10 text-white/70'
              }`}
            >
              Left hand: {calibrated.Left ? 'detected' : 'not detected'}
            </div>
            <div
              className={`rounded-md px-4 py-2 ${
                calibrated.Right
                  ? 'bg-[#4da3ff]/20 text-[#4da3ff]'
                  : 'bg-white/10 text-white/70'
              }`}
            >
              Right hand: {calibrated.Right ? 'detected' : 'not detected'}
            </div>
          </div>

          {bothCalibrated && (
            <p className="text-lg font-semibold text-[#00e0a4]">
              Calibration complete ✓
            </p>
          )}

          <button
            type="button"
            onClick={skipCalibration}
            className="mt-2 rounded-full border border-white/30 px-5 py-2 text-sm font-medium text-white/90 transition hover:bg-white/10"
          >
            Skip calibration
          </button>
        </div>
      )}

      {/* Gesture labels (only shown once tracking begins). */}
      {!status && phase === 'tracking' && (
        <div className="absolute left-1/2 top-6 flex -translate-x-1/2 gap-3">
          <div className="rounded-full bg-black/60 px-5 py-2 backdrop-blur-sm">
            <span className="font-mono text-sm font-bold tracking-wide text-[#00e0a4]">
              Left hand: {gestures.Left}
            </span>
          </div>
          <div className="rounded-full bg-black/60 px-5 py-2 backdrop-blur-sm">
            <span className="font-mono text-sm font-bold tracking-wide text-[#4da3ff]">
              Right hand: {gestures.Right}
            </span>
          </div>
        </div>
      )}

      {/* Debug overlay */}
      {!status && phase === 'tracking' && (
        <div className="absolute bottom-6 left-6 rounded-md bg-black/60 px-4 py-3 font-mono text-xs leading-relaxed text-white backdrop-blur-sm">
          <div>FPS: {fps}</div>
          <div>
            L fingertip: {fingertips.Left ? `${fingertips.Left.x}, ${fingertips.Left.y}` : '--'}
          </div>
          <div>
            R fingertip: {fingertips.Right ? `${fingertips.Right.x}, ${fingertips.Right.y}` : '--'}
          </div>
        </div>
      )}

      {!status && (
        <div className="absolute right-6 top-6 rounded-md bg-black/60 px-3 py-1.5 font-mono text-[11px] text-white/80 backdrop-blur-sm">
          Hand Gesture Tracker — Step 1
        </div>
      )}
    </div>
  );
}
