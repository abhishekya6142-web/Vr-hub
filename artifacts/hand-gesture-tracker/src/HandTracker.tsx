import { useEffect, useRef, useState } from 'react';

// MediaPipe Hands is loaded globally via CDN <script> tags in index.html.
declare global {
  interface Window {
    Hands: any;
    Camera: any;
  }
}

type Landmark = { x: number; y: number; z: number };

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

export default function HandTracker() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<string>('Requesting camera access...');
  const [gesture, setGesture] = useState<string>('NO HAND');
  const [fingertip, setFingertip] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [fps, setFps] = useState<number>(0);

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
        maxNumHands: 1,
        modelComplexity: 0,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });

      hands.onResults((results: any) => {
        if (cancelled) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = video.videoWidth || window.innerWidth;
        canvas.height = video.videoHeight || window.innerHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const landmarkSets: Landmark[][] = results.multiHandLandmarks || [];

        if (landmarkSets.length === 0) {
          setGesture('NO HAND');
          setFingertip(null);
        } else {
          const landmarks = landmarkSets[0];

          // Draw connections.
          ctx.strokeStyle = '#00e0a4';
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

          setFingertip({ x: Math.round(tipX), y: Math.round(tipY) });
          setGesture(detectGesture(landmarks));
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

      {/* Gesture label */}
      <div className="absolute left-1/2 top-6 -translate-x-1/2 rounded-full bg-black/60 px-6 py-2 backdrop-blur-sm">
        <span className="font-mono text-xl font-bold tracking-wide text-[#00e0a4]">
          {gesture}
        </span>
      </div>

      {/* Debug overlay */}
      <div className="absolute bottom-6 left-6 rounded-md bg-black/60 px-4 py-3 font-mono text-xs leading-relaxed text-white backdrop-blur-sm">
        <div>FPS: {fps}</div>
        <div>
          Fingertip X: {fingertip ? fingertip.x : '--'}
        </div>
        <div>
          Fingertip Y: {fingertip ? fingertip.y : '--'}
        </div>
      </div>

      <div className="absolute right-6 top-6 rounded-md bg-black/60 px-3 py-1.5 font-mono text-[11px] text-white/80 backdrop-blur-sm">
        Hand Gesture Tracker — Step 1
      </div>
    </div>
  );
}
