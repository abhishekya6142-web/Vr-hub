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

// Minimum confidence required to accept a detection at all (Fix 2).
const DETECTION_ACCEPT_THRESHOLD = 0.8;
// Minimum confidence + consecutive frames required to mark a hand calibrated.
const CALIBRATION_SCORE_THRESHOLD = 0.85;
const CALIBRATION_FRAMES_REQUIRED = 20;
// Consecutive frames a gesture must repeat before it's "confirmed" on screen.
const GESTURE_CONFIRM_FRAMES = 3;

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

// Per-hand temporal state, keyed by handedness label ("Left" / "Right").
// Kept in refs (not React state) since it's updated every frame.
type HandTemporalState = {
  lastCandidateGesture: string;
  candidateStreak: number;
  confirmedGesture: string;
  calibrationStreak: number;
};

function makeTemporalState(): HandTemporalState {
  return {
    lastCandidateGesture: 'NO HAND',
    candidateStreak: 0,
    confirmedGesture: 'NO HAND',
    calibrationStreak: 0,
  };
}

// Calibration baseline: wrist-to-middle-MCP distance per hand, captured once
// both hands are calibrated. Stored as a plain JS object (module-level ref),
// no backend/persistence needed for this step.
type CalibrationBaseline = Partial<Record<HandLabel, number>>;

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

  // Refs for values that must survive across frames without re-rendering.
  const temporalRef = useRef<Record<HandLabel, HandTemporalState>>({
    Left: makeTemporalState(),
    Right: makeTemporalState(),
  });
  const calibratedRef = useRef<Record<HandLabel, boolean>>({
    Left: false,
    Right: false,
  });
  const baselineRef = useRef<CalibrationBaseline>({});
  const phaseRef = useRef<'calibrating' | 'tracking'>('calibrating');

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

        const seenThisFrame = new Set<HandLabel>();
        const nextGestures: Record<HandLabel, string> = {
          Left: 'NO HAND',
          Right: 'NO HAND',
        };
        const nextFingertips: Record<HandLabel, { x: number; y: number } | null> = {
          Left: null,
          Right: null,
        };

        for (let i = 0; i < landmarkSets.length; i += 1) {
          const handedness = handednessList[i];
          if (!handedness) continue;
          const score: number = handedness.score ?? 0;

          // Fix 2: ignore low-confidence detections entirely (likely a leg,
          // arm, or other body part misread as a hand).
          if (score < DETECTION_ACCEPT_THRESHOLD) continue;

          // MediaPipe reports handedness from the camera's point of view,
          // which is mirrored for a front-style overlay on a selfie feed;
          // since we're using the rear camera (not mirrored), use the label
          // as-is.
          const label: HandLabel = handedness.label === 'Left' ? 'Left' : 'Right';
          seenThisFrame.add(label);
          const landmarks = landmarkSets[i];
          const temporal = temporalRef.current[label];

          if (phaseRef.current === 'calibrating') {
            // Calibration: require a sustained high-confidence streak before
            // marking a hand calibrated.
            if (score >= CALIBRATION_SCORE_THRESHOLD) {
              temporal.calibrationStreak += 1;
            } else {
              temporal.calibrationStreak = 0;
            }

            if (
              temporal.calibrationStreak >= CALIBRATION_FRAMES_REQUIRED &&
              !calibratedRef.current[label]
            ) {
              calibratedRef.current[label] = true;
              baselineRef.current[label] = dist(landmarks[0], landmarks[9]);
              setCalibrated({ ...calibratedRef.current });
            }
          }

          // Draw connections.
          ctx.strokeStyle = label === 'Left' ? '#00e0a4' : '#4da3ff';
          ctx.lineWidth = 3;
          for (const [a, b] of HAND_CONNECTIONS) {
            const p1 = landmarks[a];
            const p2 = landmarks[b];
            ctx.beginPath();
            ctx.moveTo(p1.x * canvas.width, p1.y * canvas.height);
            ctx.lineTo(p2.x * canvas.width, p2.y * canvas.height);
            ctx.stroke();
          }

          // Draw 21 landmark points.
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

          // Highlight index fingertip.
          const tip = landmarks[FINGERS.index.tip];
          const tipX = tip.x * canvas.width;
          const tipY = tip.y * canvas.height;
          ctx.beginPath();
          ctx.arc(tipX, tipY, 10, 0, 2 * Math.PI);
          ctx.strokeStyle = '#ff3b30';
          ctx.lineWidth = 3;
          ctx.stroke();

          nextFingertips[label] = { x: Math.round(tipX), y: Math.round(tipY) };

          // Fix 2: temporal filter -- only "confirm" a gesture once it has
          // repeated for GESTURE_CONFIRM_FRAMES consecutive frames, to
          // suppress single-frame flicker/false positives.
          const candidate = detectGesture(landmarks);
          if (candidate === temporal.lastCandidateGesture) {
            temporal.candidateStreak += 1;
          } else {
            temporal.lastCandidateGesture = candidate;
            temporal.candidateStreak = 1;
          }
          if (temporal.candidateStreak >= GESTURE_CONFIRM_FRAMES) {
            temporal.confirmedGesture = candidate;
          }
          nextGestures[label] = temporal.confirmedGesture;
        }

        // Reset temporal/calibration streaks for hands not seen this frame.
        (['Left', 'Right'] as HandLabel[]).forEach((label) => {
          if (!seenThisFrame.has(label)) {
            const temporal = temporalRef.current[label];
            temporal.lastCandidateGesture = 'NO HAND';
            temporal.candidateStreak = 0;
            temporal.confirmedGesture = 'NO HAND';
            temporal.calibrationStreak = 0;
          }
        });

        setGestures(nextGestures);
        setFingertips(nextFingertips);

        // Auto-transition once both hands are calibrated.
        if (
          phaseRef.current === 'calibrating' &&
          calibratedRef.current.Left &&
          calibratedRef.current.Right
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
