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

          const thumbTip = landmarks[4];
          const indexTip = landmarks[8];
          const pinchDistance = dist(thumbTip, indexTip);
          const isPinching = pinchDistance / handSize < PINCH_THRESHOLD;

          if (isPinching) {
            const screen = toScreenCoords(
              (thumbTip.x + indexTip.x) / 2,
              (thumbTip.y + indexTip.y) / 2,
              video,
              canvas,
            );
            markers.push({ x: screen.x, y: screen.y });
          }

          // No hand skeleton anymore — just a small glowing dot at the
          // thumb tip and one at the index fingertip, so together they
          // read like a two-point mouse cursor. They brighten to red when
          // pinched, giving the same "click" feedback the old reticle did.
          const dotColor = isPinching ? '#ff3b30' : '#4da3ff';
          const glowColor = isPinching ? 'rgba(255, 59, 48, 0.3)' : 'rgba(77, 163, 255, 0.25)';
          for (const tip of [thumbTip, indexTip]) {
            const px = tip.x * canvas.width;
            const py = tip.y * canvas.height;

            ctx.beginPath();
            ctx.arc(px, py, 12, 0, 2 * Math.PI);
            ctx.fillStyle = glowColor;
            ctx.fill();

            ctx.beginPath();
            ctx.arc(px, py, 5, 0, 2 * Math.PI);
            ctx.fillStyle = dotColor;
            ctx.shadowColor = dotColor;
            ctx.shadowBlur = 10;
            ctx.fill();
            ctx.shadowBlur = 0;
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
