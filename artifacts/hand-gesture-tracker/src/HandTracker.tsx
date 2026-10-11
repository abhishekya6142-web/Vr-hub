// HandTracker.tsx
import { useEffect, useRef, useState } from 'react';
import {
  HandLandmarker,
  type HandLandmarkerResult,
} from '@mediapipe/tasks-vision';

import { getSharedVisionFileset } from './vr-hub/mediapipe-vision-resolver';
import { xrPoseEngine } from './vr-hub/xr-pose-engine';
import { xrCameraSource } from './vr-hub/xr-camera-source';
import { perfStats } from './vr-hub/perf-stats';

const DEBUG_HAND_TRACKING = true;

const MIN_DETECTION_CONFIDENCE = 0.6;
const MIN_TRACKING_CONFIDENCE = 0.5;
const MAX_NUM_HANDS = 1;

const PINCH_ENTER_THRESHOLD = 0.25;
const PINCH_EXIT_THRESHOLD = 0.4;

const MIN_HAND_SIZE = 0.08;
const FREEZE_MS = 400;

const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 480;

const PROCESS_INTERVAL_MS = 1000 / 24;
const RAY_LENGTH_RATIO = 0.4;
const SMOOTHING_ALPHA = 0.5;
const DEBUG_PERF_LOG = false;
const BEAM_EDGE_MARGIN = 8;

const MODEL_ASSET_PATH =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

class PerfCounter {
  private frameCount = 0;
  private totalMs = 0;
  private windowStart = performance.now();

  record(durationMs: number) {
    if (!DEBUG_PERF_LOG) return;

    this.frameCount++;
    this.totalMs += durationMs;

    const now = performance.now();
    const elapsed = now - this.windowStart;

    if (elapsed >= 1000) {
      perfStats.update({
        mediapipeFps: (this.frameCount / elapsed) * 1000,
        mediapipeAvgMs: this.totalMs / this.frameCount,
      });

      this.frameCount = 0;
      this.totalMs = 0;
      this.windowStart = now;
    }
  }
}

type Landmark = { x: number; y: number; z: number };
type PxPoint = { x: number; y: number };

function dist(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Beam ki 2D screen direction:
 * Primary: index MCP (5) -> index fingertip (8).
 * Fallback: wrist (0) -> middle MCP (9).
 */
function computeScreenPointingDirection(
  indexMcp: PxPoint,
  indexTip: PxPoint,
  wrist: PxPoint,
  middleMcp: PxPoint,
  out: PxPoint,
): boolean {
  let dx = indexTip.x - indexMcp.x;
  let dy = indexTip.y - indexMcp.y;
  let length = Math.hypot(dx, dy);

  if (length < 4) {
    dx = middleMcp.x - wrist.x;
    dy = middleMcp.y - wrist.y;
    length = Math.hypot(dx, dy);
  }

  if (length < 2) return false;

  out.x = dx / length;
  out.y = dy / length;

  return true;
}

/** Ray origin se screen boundary tak ki distance. */
function distToScreenEdge(
  ox: number,
  oy: number,
  ux: number,
  uy: number,
  w: number,
  h: number,
): number {
  let t = Infinity;

  if (ux > 1e-6) t = Math.min(t, (w - ox) / ux);
  else if (ux < -1e-6) t = Math.min(t, -ox / ux);

  if (uy > 1e-6) t = Math.min(t, (h - oy) / uy);
  else if (uy < -1e-6) t = Math.min(t, -oy / uy);

  return Number.isFinite(t) ? Math.max(t, 0) : 0;
}

type PinchMarker = { x: number; y: number };

type HandTrackerProps = {
  onPinchMarkers?: (markers: PinchMarker[]) => void;
  onPointMarkers?: (markers: PinchMarker[]) => void;
  onReady?: () => void;
};

type HandSlot = {
  smoothedOrigin: PxPoint;
  smoothedDir: PxPoint;
  reach: number;
  isPinching: boolean;
  lastGoodTime: number;
  debug: {
    thumb: PxPoint;
    index: PxPoint;
    wrist: PxPoint;
    middleMcp: PxPoint;
  } | null;
};

export default function HandTracker({
  onPinchMarkers,
  onPointMarkers,
  onReady,
}: HandTrackerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [, setStatus] = useState('Requesting camera access...');

  const onPinchMarkersRef = useRef(onPinchMarkers);
  const onPointMarkersRef = useRef(onPointMarkers);
  const onReadyRef = useRef(onReady);

  onPinchMarkersRef.current = onPinchMarkers;
  onPointMarkersRef.current = onPointMarkers;
  onReadyRef.current = onReady;

  useEffect(() => {
    let camera: { stop: () => void } | undefined;
    let landmarker: HandLandmarker | null = null;
    let cancelled = false;

    let lastSentWidth = CAPTURE_WIDTH;
    let lastSentHeight = CAPTURE_HEIGHT;

    const handSlots: HandSlot[] = [];
    const mediapipePerf = new PerfCounter();

    function useXRCameraSource() {
      return xrPoseEngine.isActive() && xrCameraSource.isSupported();
    }

    function processResults(
      result: HandLandmarkerResult,
      sourceW: number,
      sourceH: number,
    ) {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const screenW = window.innerWidth;
      const screenH = window.innerHeight;

      if (canvas.width !== screenW || canvas.height !== screenH) {
        canvas.width = screenW;
        canvas.height = screenH;
      }

      ctx.clearRect(0, 0, screenW, screenH);

      const now = Date.now();

      // Match the camera feed's cover scaling.
      const scale = Math.max(
        screenW / sourceW,
        screenH / sourceH,
      );

      const offsetX = (screenW - sourceW * scale) / 2;
      const offsetY = (screenH - sourceH * scale) / 2;

      function toScreen(lm: Landmark): PxPoint {
        return {
          x: lm.x * sourceW * scale + offsetX,
          y: lm.y * sourceH * scale + offsetY,
        };
      }

      const landmarkSets: Landmark[][] = result.landmarks || [];
      const markers: PinchMarker[] = [];
      const pointMarkers: PinchMarker[] = [];

      type Detection = {
        origin: PxPoint;
        dir: PxPoint;
        pinchRatio: number;
        debug: {
          thumb: PxPoint;
          index: PxPoint;
          wrist: PxPoint;
          middleMcp: PxPoint;
        };
      };

      const detections: Detection[] = [];

      for (const lm of landmarkSets) {
        const wristLm = lm[0];
        const thumbLm = lm[4];
        const indexLm = lm[8];
        const indexMcpLm = lm[5];
        const middleMcpLm = lm[9];

        if (
          !wristLm ||
          !thumbLm ||
          !indexLm ||
          !indexMcpLm ||
          !middleMcpLm
        ) {
          continue;
        }

        const handSize = dist(wristLm, middleMcpLm);
        if (handSize < MIN_HAND_SIZE) continue;

        const pinchRatio = dist(thumbLm, indexLm) / handSize;

        const thumb = toScreen(thumbLm);
        const index = toScreen(indexLm);
        const indexMcp = toScreen(indexMcpLm);
        const wrist = toScreen(wristLm);
        const middleMcp = toScreen(middleMcpLm);

        // Keep the original thumb-index midpoint as beam origin.
        const origin: PxPoint = {
          x: (thumb.x + index.x) / 2,
          y: (thumb.y + index.y) / 2,
        };

        const dir: PxPoint = { x: 0, y: 0 };

        const validDirection = computeScreenPointingDirection(
          indexMcp,
          index,
          wrist,
          middleMcp,
          dir,
        );

        if (!validDirection) continue;

        detections.push({
          origin,
          dir,
          pinchRatio,
          debug: { thumb, index, wrist, middleMcp },
        });
      }

      const detection = detections[0];
      const rayLength = Math.min(screenW, screenH) * RAY_LENGTH_RATIO;

      if (detection) {
        let slot = handSlots[0];

        if (!slot) {
          slot = {
            smoothedOrigin: { ...detection.origin },
            smoothedDir: { ...detection.dir },
            reach: rayLength,
            isPinching:
              detection.pinchRatio < PINCH_ENTER_THRESHOLD,
            lastGoodTime: now,
            debug: detection.debug,
          };

          handSlots[0] = slot;
        } else {
          slot.lastGoodTime = now;
          slot.debug = detection.debug;

          // Smooth the beam origin.
          slot.smoothedOrigin.x +=
            (detection.origin.x - slot.smoothedOrigin.x) *
            SMOOTHING_ALPHA;

          slot.smoothedOrigin.y +=
            (detection.origin.y - slot.smoothedOrigin.y) *
            SMOOTHING_ALPHA;

          // Smooth direction and renormalize.
          const sd = slot.smoothedDir;

          sd.x +=
            (detection.dir.x - sd.x) * SMOOTHING_ALPHA;

          sd.y +=
            (detection.dir.y - sd.y) * SMOOTHING_ALPHA;

          const directionLength = Math.hypot(sd.x, sd.y);

          if (directionLength > 1e-6) {
            sd.x /= directionLength;
            sd.y /= directionLength;
          } else {
            sd.x = detection.dir.x;
            sd.y = detection.dir.y;
          }

          // Pinch hysteresis avoids rapid click-state flickering.
          slot.isPinching = slot.isPinching
            ? detection.pinchRatio < PINCH_EXIT_THRESHOLD
            : detection.pinchRatio < PINCH_ENTER_THRESHOLD;
        }

        slot.reach = rayLength;

        const target: PxPoint = {
          x:
            slot.smoothedOrigin.x +
            slot.smoothedDir.x * slot.reach,
          y:
            slot.smoothedOrigin.y +
            slot.smoothedDir.y * slot.reach,
        };

        if (slot.isPinching) markers.push(target);
        else pointMarkers.push(target);
      } else {
        const slot = handSlots[0];

        if (slot && now - slot.lastGoodTime > FREEZE_MS) {
          handSlots.length = 0;
        }
      }

      onPinchMarkersRef.current?.(markers);
      onPointMarkersRef.current?.(pointMarkers);

      const slot = handSlots[0];
      if (!slot) return;

      const origin = slot.smoothedOrigin;
      const ux = slot.smoothedDir.x;
      const uy = slot.smoothedDir.y;

      const target: PxPoint = {
        x: origin.x + ux * slot.reach,
        y: origin.y + uy * slot.reach,
      };

      // Extend the beam to the edge of the screen.
      const edgeDistance =
        distToScreenEdge(
          origin.x,
          origin.y,
          ux,
          uy,
          screenW,
          screenH,
        ) + BEAM_EDGE_MARGIN;

      const beamLength = Math.max(edgeDistance, slot.reach);

      const beamEnd: PxPoint = {
        x: origin.x + ux * beamLength,
        y: origin.y + uy * beamLength,
      };

      const color = slot.isPinching ? '#ff3b30' : '#22d3ee';
      const glow = slot.isPinching
        ? 'rgba(255,59,48,0.4)'
        : 'rgba(34,211,238,0.4)';

      // Laser beam.
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(beamEnd.x, beamEnd.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3.5;
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Beam origin.
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      // Pointer target.
      ctx.beginPath();
      ctx.arc(
        target.x,
        target.y,
        slot.isPinching ? 16 : 12,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = glow;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(
        target.x,
        target.y,
        slot.isPinching ? 7 : 5,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = color;
      ctx.fill();

      // Optional hand landmark debug overlay.
      if (DEBUG_HAND_TRACKING && slot.debug) {
        const { thumb, index, wrist, middleMcp } = slot.debug;

        const dot = (
          point: PxPoint,
          dotColor: string,
          label: string,
        ) => {
          ctx.beginPath();
          ctx.arc(point.x, point.y, 8, 0, Math.PI * 2);
          ctx.fillStyle = dotColor;
          ctx.fill();

          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1;
          ctx.stroke();

          ctx.fillStyle = '#fff';
          ctx.font = 'bold 12px sans-serif';
          ctx.fillText(label, point.x + 10, point.y - 10);
        };

        dot(thumb, '#ff0000', 'THUMB');
        dot(index, '#00ff00', 'INDEX');
        dot(wrist, '#ffff00', 'WRIST');
        dot(middleMcp, '#3366ff', 'MCP');
      }
    }

    async function start() {
      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (!canvas) return;

      try {
        const fileset = await getSharedVisionFileset();

        landmarker = await HandLandmarker.createFromOptions(
          fileset,
          {
            baseOptions: {
              modelAssetPath: MODEL_ASSET_PATH,
              delegate: 'GPU',
            },
            runningMode: 'VIDEO',
            numHands: MAX_NUM_HANDS,
            minHandDetectionConfidence: MIN_DETECTION_CONFIDENCE,
            minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
          },
        );
      } catch (err) {
        console.error(
          '[HandTracker] Failed to initialize HandLandmarker:',
          err,
        );

        if (!cancelled) {
          setStatus('Failed to load hand tracking. Reload page.');
        }

        return;
      }

      if (cancelled || !landmarker) return;

      let xrModeAtStart = useXRCameraSource();
      let pollAttempts = 0;

      while (
        !xrModeAtStart &&
        xrPoseEngine.isActive() &&
        pollAttempts < 40
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        xrModeAtStart = useXRCameraSource();
        pollAttempts++;
      }

      // XR camera source path.
      if (xrModeAtStart) {
        let isProcessing = false;
        let lastProcessTime = 0;

        const unsubscribe = xrCameraSource.subscribe((xrCanvas) => {
          if (
            cancelled ||
            !xrCanvas ||
            isProcessing ||
            !landmarker
          ) {
            return;
          }

          const nowMs = performance.now();

          if (nowMs - lastProcessTime < PROCESS_INTERVAL_MS) return;

          lastProcessTime = nowMs;
          lastSentWidth = xrCanvas.width;
          lastSentHeight = xrCanvas.height;
          isProcessing = true;

          const perfStart = DEBUG_PERF_LOG
            ? performance.now()
            : 0;

          try {
            const result = landmarker!.detectForVideo(
              xrCanvas,
              performance.now(),
            );

            processResults(
              result,
              lastSentWidth,
              lastSentHeight,
            );

            if (DEBUG_PERF_LOG) {
              mediapipePerf.record(
                performance.now() - perfStart,
              );
            }
          } catch (err) {
            console.error('[HandTracker] XR frame error:', err);
          } finally {
            isProcessing = false;
          }
        });

        camera = { stop: unsubscribe };

        if (!cancelled) {
          setStatus('');
          onReadyRef.current?.();
        }

        return;
      }

      // Regular camera fallback.
      try {
        if (!video) return;

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: CAPTURE_WIDTH },
            height: { ideal: CAPTURE_HEIGHT },
          },
        });

        video.srcObject = stream;
        await video.play();

        let isProcessing = false;
        let lastProcessTime = 0;
        let rafId = 0;

        const loop = () => {
          if (cancelled || !landmarker) return;

          const nowMs = performance.now();

          if (
            video.readyState >= 2 &&
            !isProcessing &&
            nowMs - lastProcessTime >= PROCESS_INTERVAL_MS
          ) {
            lastProcessTime = nowMs;
            lastSentWidth = video.videoWidth || CAPTURE_WIDTH;
            lastSentHeight = video.videoHeight || CAPTURE_HEIGHT;
            isProcessing = true;

            const perfStart = DEBUG_PERF_LOG
              ? performance.now()
              : 0;

            try {
              const result = landmarker!.detectForVideo(
                video,
                performance.now(),
              );

              processResults(
                result,
                lastSentWidth,
                lastSentHeight,
              );

              if (DEBUG_PERF_LOG) {
                mediapipePerf.record(
                  performance.now() - perfStart,
                );
              }
            } catch (err) {
              console.error('[HandTracker] Camera frame error:', err);
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
            stream.getTracks().forEach((track) => track.stop());
          },
        };

        if (!cancelled) {
          setStatus('');
          onReadyRef.current?.();
        }
      } catch (err) {
        console.error('[HandTracker] Camera access failed:', err);

        if (!cancelled) {
          setStatus('Camera access failed.');
        }
      }
    }

    void start();

    return () => {
      cancelled = true;
      camera?.stop();
      landmarker?.close();
    };
  }, []);

  const xrMode =
    xrPoseEngine.isActive() && xrCameraSource.isSupported();

  return (
    <>
      <div
        className={`fixed inset-0 overflow-hidden ${
          xrMode ? '' : 'bg-black'
        }`}
      >
        {!xrMode && (
          <video
            ref={videoRef}
            className="absolute inset-0 h-full w-full object-cover"
            playsInline
            muted
            autoPlay
          />
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
