// mediapipe-vision-resolver.ts
//
// PROBLEM THIS FIXES (original): HandTracker.tsx (HandLandmarker) and
// AccessibilityApp.tsx (ObjectDetector) each independently called
// `FilesetResolver.forVisionTasks(...)` and created their own separate
// WASM runtime. Two independent MediaPipe Tasks WASM instances alive in
// the same page crash ("Aborted(Module.noExitRuntime ...)").
// FIX: ek shared fileset (module-level singleton). Dono files
// getSharedVisionFileset() yahin se import karein.
//
// NAYA (is version mein):
//  1. VERSION MISMATCH FIX: pehle WASM `@latest` se aata tha, jabki npm
//     mein installed @mediapipe/tasks-vision ka JS ek fixed version hai.
//     Jaise hi CDN ka "latest" aage badhta hai, JS aur WASM ka version
//     match nahi karta aur HandLandmarker init fail / "Aborted" ho jaata
//     hai. Ab pehle LOCAL wasm (public/mediapipe/wasm — node_modules se
//     copy kiya hua, installed JS se exact match) use hota hai; wo na ho
//     to CDN, jahan WASM_VERSION ko apne package.json ke exact version
//     par set karo.
//  2. FAILURE CACHE FIX: pehle ek baar fail hone par rejected promise
//     hamesha ke liye cache ho jaata tha (reload ke bina retry nahi).
//     Ab fail hone par cache clear hota hai, agla caller dobara try karta hai.
//
// LOCAL WASM SETUP (Replit shell, project root mein, ek baar):
//   mkdir -p public/mediapipe
//   cp -r node_modules/@mediapipe/tasks-vision/wasm public/mediapipe/wasm
//
// NOTE: FilesetResolver.forVisionTasks() khud WASM download nahi karta,
// sirf paths deta hai; asli load createFromOptions() ke time hota hai.
// Isliye local file ka maujood hona hum yahin probe karke check karte hain.

import { FilesetResolver } from '@mediapipe/tasks-vision';

// package.json mein "@mediapipe/tasks-vision" ka jo exact version hai wahi
// yahan likho (jaise '0.10.22'). 'latest' sirf last-resort hai.
const WASM_VERSION = 'latest';

const LOCAL_WASM_BASE = '/mediapipe/wasm';
const CDN_WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${WASM_VERSION}/wasm`;

type VisionFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

let filesetPromise: Promise<VisionFileset> | null = null;

// Local wasm loader asli JS file hai ya nahi (SPA fallback HTML 200 de
// sakta hai, isliye content-type bhi check karte hain).
async function localWasmAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${LOCAL_WASM_BASE}/vision_wasm_internal.js`, { cache: 'no-store' });
    const type = res.headers.get('content-type') ?? '';
    const ok = res.ok && type.includes('javascript');
    try {
      await res.body?.cancel();
    } catch {
      // ignore
    }
    return ok;
  } catch {
    return false;
  }
}

async function loadFileset(): Promise<VisionFileset> {
  if (await localWasmAvailable()) {
    try {
      return await FilesetResolver.forVisionTasks(LOCAL_WASM_BASE);
    } catch (err) {
      console.warn('[mediapipe-vision-resolver] local wasm failed, CDN try karunga:', err);
    }
  } else {
    console.warn(
      `[mediapipe-vision-resolver] local wasm (${LOCAL_WASM_BASE}) nahi mila — CDN @${WASM_VERSION} use ho raha hai. ` +
        'Version mismatch se bachne ke liye wasm folder public/mediapipe/wasm mein copy karo.',
    );
  }
  return FilesetResolver.forVisionTasks(CDN_WASM_BASE);
}

export function getSharedVisionFileset(): Promise<VisionFileset> {
  if (!filesetPromise) {
    filesetPromise = loadFileset().catch((err) => {
      filesetPromise = null; // fail hua to cache mat karo, agli baar retry
      throw err;
    });
  }
  return filesetPromise;
}
