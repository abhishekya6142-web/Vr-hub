// mediapipe-vision-resolver.ts
//
// PROBLEM THIS FIXES: HandTracker.tsx (HandLandmarker) and
// AccessibilityApp.tsx (ObjectDetector) each independently called
// `FilesetResolver.forVisionTasks(WASM_BASE_URL)` and created their
// own separate WASM runtime. Running two of these MediaPipe Tasks
// WASM instances at the same time (HandTracker keeps running in the
// background even while Accessibility is active — that's required
// for the 3x-pinch exit gesture) caused a runtime crash:
//   "Aborted(Module.noExitRuntime has been replaced with plain
//   noExitRuntime ...)"
// This is a known MediaPipe Tasks WASM limitation — the underlying
// Emscripten module isn't designed to have multiple independent
// copies alive in the same page at once.
//
// FIX: a single shared FilesetResolver instance (module-level
// singleton, memoized as a Promise so concurrent callers await the
// same in-flight load instead of racing). Both HandTracker.tsx and
// AccessibilityApp.tsx must import getSharedVisionFileset() from here
// instead of calling FilesetResolver.forVisionTasks() themselves.
//
// Both HandLandmarker.createFromOptions() and
// ObjectDetector.createFromOptions() accept this same fileset object
// — MediaPipe Tasks explicitly supports creating multiple *task*
// instances (landmarker, detector, etc.) off of one shared fileset;
// what's unsafe is creating multiple separate filesets/runtimes.

import { FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_BASE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';

type VisionFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

let filesetPromise: Promise<VisionFileset> | null = null;

export function getSharedVisionFileset(): Promise<VisionFileset> {
  if (!filesetPromise) {
    filesetPromise = FilesetResolver.forVisionTasks(WASM_BASE_URL);
  }
  return filesetPromise;
}
