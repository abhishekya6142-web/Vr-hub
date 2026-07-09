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
        const markers: PinchMarker[] = [];

        for (const landmarks of landmarkSets) {
          const wrist = landmarks[0];
          const middleMcp = landmarks[9];
          const handSize = dist(wrist, middleMcp);

          // Distance filter: skip hands that are too small/far away, as if
          // they weren't detected at all.
          if (handSize < MIN_HAND_SIZE) continue;

          // Draw the hand skeleton for visual feedback.
          ctx.strokeStyle = '#4da3ff';
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
            ctx.arc(point.x * canvas.width, point.y * canvas.height, 5, 0, 2 * Math.PI);
            ctx.fill();
          }

          const thumbTip = landmarks[4];
          const indexTip = landmarks[8];
          const pinchDistance = dist(thumbTip, indexTip);
          const isPinching = pinchDistance / handSize < PINCH_THRESHOLD;

          if (isPinching) {
            const midX = ((thumbTip.x + indexTip.x) / 2) * canvas.width;
            const midY = ((thumbTip.y + indexTip.y) / 2) * canvas.height;
            const screen = toScreenCoords(
              (thumbTip.x + indexTip.x) / 2,
              (thumbTip.y + indexTip.y) / 2,
              video,
              canvas,
            );
            markers.push({ x: screen.x, y: screen.y });

            // Draw the marker directly on the canvas so it's perfectly in
            // sync with the current frame (no React re-render lag).
            ctx.beginPath();
            ctx.arc(midX, midY, 18, 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(255, 59, 48, 0.35)';
            ctx.fill();
            ctx.beginPath();
            ctx.arc(midX, midY, 10, 0, 2 * Math.PI);
            ctx.fillStyle = '#ff3b30';
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(midX - 16, midY);
            ctx.lineTo(midX + 16, midY);
            ctx.moveTo(midX, midY - 16);
            ctx.lineTo(midX, midY + 16);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        }

        onPinchMarkersRef.current?.(markers);
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
    </div>
  );
}
