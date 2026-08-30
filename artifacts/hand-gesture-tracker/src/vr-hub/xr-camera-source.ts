// xr-camera-source.ts

import { perfStats } from './perf-stats';

type Listener = (canvas: HTMLCanvasElement | null) => void;

interface XRViewLike {
  camera?: unknown;
}

interface XRWebGLBindingLike {
  getCameraImage: (camera: unknown) => WebGLTexture;
}

interface XRWebGLBindingConstructor {
  new (session: unknown, gl: WebGL2RenderingContext): XRWebGLBindingLike;
}

declare const XRWebGLBinding: XRWebGLBindingConstructor | undefined;

// FIX (restored): this V-flip in the shader was the version that produced
// correctly-oriented images (confirmed by the green-PIP-box test). Do NOT
// also flip rows in readPixels below — that combination was the "double
// flip" that made the image upside-down again.
const VERTEX_SRC = `
  attribute vec2 aPos;
  varying vec2 vUv;
  void main() {
    vUv = aPos * 0.5 + 0.5;
    vUv.y = 1.0 - vUv.y;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }
`;

const FRAGMENT_SRC = `
  precision mediump float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  void main() {
    gl_FragColor = texture2D(uTex, vUv);
  }
`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Could not create shader');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${info}`);
  }
  return shader;
}

// FIX (balance): 66ms (~15fps) choppy tha, lekin 4ms (~250fps attempt)
// bahut zyada tha — display khud sirf 60-90fps tak render kar sakta
// hai, isliye itni high frequency par har readback-cycle (render +
// async-PBO queue-management) chalane ki koshish karna sirf extra
// overhead add karta hai bina koi real visual benefit ke, aur poora
// FPS neeche gira deta hai. ~30fps (33ms) ek sensible middle-ground
// hai — camera-texture insaani aankh ko smooth lagne ke liye kaafi
// hai, aur GPU/CPU par overload nahi daalta.
const PROCESS_INTERVAL_MS = 33;

// FIX (aspect-ratio): output canvas ko ab NAHI fixed 640x480 par rakhte.
// Camera ka actual source texture jo bhi aspect ratio de (16:9, 4:3,
// jo bhi), hum wahi ratio preserve karte hain — sirf width ko is max
// tak cap karte hain taaki processing resolution chhoti/fast rahe.
// Height khud-ba-khud actual aspect se calculate hoti hai, koi
// stretch/squish nahi.
const MAX_PROCESS_WIDTH = 640;

// TEMP (measurement only — no logic change): DEBUG flag on karne se
// console mein har ~1 second par camera-extraction FPS aur average
// processView() time print hota hai. Production/normal use mein
// false hi rakhna — zero runtime cost jab false ho (sirf ek if-check).
// Iska maksad sirf ye confirm karna hai ki performance fix ka asar
// numbers mein kitna hai; jab measure ho jaaye to DEBUG_PERF_LOG ko
// false wapas kar dena, koi aur cleanup nahi karna padega.
const DEBUG_PERF_LOG = false;

class PerfCounter {
  private frameCount = 0;
  private totalMs = 0;
  private windowStart = performance.now();
  private label: string;

  constructor(label: string) {
    this.label = label;
  }

  record(durationMs: number) {
    if (!DEBUG_PERF_LOG) return;
    this.frameCount++;
    this.totalMs += durationMs;
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed >= 1000) {
      const fps = (this.frameCount / elapsed) * 1000;
      const avgMs = this.totalMs / this.frameCount;
      // TEMP (removed console.log — on-screen overlay hi kaafi hai,
      // console access phone par nahi hai, aur ye ek extra unused
      // string-format + console-write cost tha har second).
      perfStats.update({ cameraExtractionFps: fps, cameraExtractionAvgMs: avgMs });
      this.frameCount = 0;
      this.totalMs = 0;
      this.windowStart = now;
    }
  }
}

function compileProgram(gl: WebGL2RenderingContext): { program: WebGLProgram; texUniformLoc: WebGLUniformLocation | null } {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
  const program = gl.createProgram();
  if (!program) throw new Error('Could not create GL program');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  const texUniformLoc = gl.getUniformLocation(program, 'uTex');
  return { program, texUniformLoc };
}

class XRCameraSource {
  private listeners = new Set<Listener>();
  private gl: WebGL2RenderingContext | null = null;
  private binding: XRWebGLBindingLike | null = null;
  private program: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private texUniformLoc: WebGLUniformLocation | null = null;
  private outputCanvas: HTMLCanvasElement | null = null;
  private outputCtx: CanvasRenderingContext2D | null = null;
  private ready = false;
  private supported = false;
  private lastCameraSeen = false;
  private lastTextureOk = false;
  private lastError: string | null = null;
  private totalFrames = 0;

  // FIX (aspect-ratio): ye ab "current" values hain, fixed constants
  // nahi — pehli baar camera texture dikhne par actual source
  // dimensions se derive hote hain, phir FBO/PBO/output-canvas usi ke
  // hisaab se (re)allocate hote hain. Agar source dimensions kabhi
  // badlein (rare, but device switch cases mein ho sakta hai) to
  // dobara re-derive ho jaate hain.
  private renderCanvasWidth = MAX_PROCESS_WIDTH;
  private renderCanvasHeight = Math.round((MAX_PROCESS_WIDTH * 3) / 4); // placeholder tak allocate hone se pehle
  private sourceDimsKnown = false;

  private ownFbo: WebGLFramebuffer | null = null;
  private ownTargetTexture: WebGLTexture | null = null;
  private pixelBuffer: Uint8Array | null = null;
  private cachedImageData: ImageData | null = null;
  private lastProcessTime = 0;

  // Async GPU readback via double-buffered PBOs — see notes on
  // processView() below. This ping-pong design is exactly what makes
  // running at a high frequency (PROCESS_INTERVAL_MS = 4, close to
  // every-frame) safe without blocking the CPU on the GPU.
  private pbo: [WebGLBuffer | null, WebGLBuffer | null] = [null, null];
  private pboSync: [WebGLSync | null, WebGLSync | null] = [null, null];
  private pboWriteIndex: 0 | 1 = 0;

  // TEMP (measurement only): tracks how often processView() actually
  // runs (= camera-extraction FPS) and how long each call takes.
  private extractionPerf = new PerfCounter('camera-extraction');

  isSupported() {
    return this.supported;
  }

  isReady() {
    return this.ready;
  }

  getCanvas() {
    return this.outputCanvas;
  }

  getDebugState() {
    return {
      supported: this.supported,
      ready: this.ready,
      lastCameraSeen: this.lastCameraSeen,
      lastTextureOk: this.lastTextureOk,
      lastError: this.lastError,
      frameCount: this.totalFrames,
      renderCanvasWidth: this.renderCanvasWidth,
      renderCanvasHeight: this.renderCanvasHeight,
      sourceDimsKnown: this.sourceDimsKnown,
    };
  }

  init(session: unknown, gl: WebGL2RenderingContext) {
    if (typeof XRWebGLBinding === 'undefined') {
      this.supported = false;
      return;
    }

    try {
      this.gl = gl;
      this.binding = new XRWebGLBinding(session, gl);

      const { program, texUniformLoc } = compileProgram(gl);
      this.program = program;
      this.texUniformLoc = texUniformLoc;

      const quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      this.quadBuffer = quad;

      // FIX (aspect-ratio): FBO/PBO/output-canvas allocation ab
      // allocateBuffers() mein hai, taaki jab actual source dimensions
      // pehli baar pata chalein (processView ke andar) to same logic
      // se dobara (re-)allocate kiya ja sake — koi duplicate code nahi.
      this.allocateBuffers(gl, this.renderCanvasWidth, this.renderCanvasHeight);

      this.supported = true;
      this.ready = true;
      this.lastProcessTime = 0;
      this.sourceDimsKnown = false;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.supported = false;
      this.ready = false;
    }
  }

  // FIX (aspect-ratio): shared allocation logic — pehle sirf init()
  // mein tha, ab ek dedicated method hai jo init() aur "source
  // dimensions first-detected / changed" dono cases se call hoti hai.
  // Purane FBO/texture/PBO/pixelBuffer/canvas ko safely dispose karta
  // hai agar wo pehle se exist karte hain.
  private allocateBuffers(gl: WebGL2RenderingContext, width: number, height: number) {
    if (this.ownFbo) gl.deleteFramebuffer(this.ownFbo);
    if (this.ownTargetTexture) gl.deleteTexture(this.ownTargetTexture);
    if (this.pbo[0]) gl.deleteBuffer(this.pbo[0]!);
    if (this.pbo[1]) gl.deleteBuffer(this.pbo[1]!);
    if (this.pboSync[0]) gl.deleteSync(this.pboSync[0]!);
    if (this.pboSync[1]) gl.deleteSync(this.pboSync[1]!);

    this.renderCanvasWidth = width;
    this.renderCanvasHeight = height;

    const fbo = gl.createFramebuffer();
    const targetTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, targetTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targetTexture, 0);
    const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Offscreen framebuffer incomplete: 0x${fbStatus.toString(16)}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.ownFbo = fbo;
    this.ownTargetTexture = targetTexture;

    const pboByteSize = width * height * 4;
    const pboA = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pboA);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, pboByteSize, gl.STREAM_READ);
    const pboB = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pboB);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, pboByteSize, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.pbo = [pboA, pboB];
    this.pboSync = [null, null];
    this.pboWriteIndex = 0;

    this.pixelBuffer = new Uint8Array(pboByteSize);

    if (!this.outputCanvas) {
      this.outputCanvas = document.createElement('canvas');
      this.outputCtx = this.outputCanvas.getContext('2d', { willReadFrequently: true });
    }
    this.outputCanvas.width = width;
    this.outputCanvas.height = height;
    this.cachedImageData = null; // agli processView() par size ke hisaab se recreate hoga
  }

  processFrame(view: XRViewLike) {
    if (!this.ready) return;
    const now = performance.now();
    if (now - this.lastProcessTime < PROCESS_INTERVAL_MS) return;
    this.lastProcessTime = now;
    this.processView(view);
  }

  private processView(view: XRViewLike) {
    if (
      !this.ready ||
      !this.gl ||
      !this.binding ||
      !this.program ||
      !this.quadBuffer ||
      !this.ownFbo ||
      !this.pixelBuffer
    ) {
      return;
    }

    // TEMP (measurement only): start timing this processView() call.
    const __perfStart = DEBUG_PERF_LOG ? performance.now() : 0;

    this.totalFrames++;
    this.lastCameraSeen = !!view.camera;
    if (!view.camera) {
      this.lastError = 'view.camera undefined';
      return;
    }

    const gl = this.gl;

    let texture: WebGLTexture;
    try {
      texture = this.binding.getCameraImage(view.camera);
      this.lastTextureOk = true;
      this.lastError = null;
    } catch (err) {
      this.lastTextureOk = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      return;
    }

    // FIX (aspect-ratio): source texture ka ACTUAL width/height ek
    // baar (aur agar kabhi badle to dobara) query karte hain, aur
    // usi aspect ratio ko preserve karte hue apna processing canvas
    // size derive karte hain — MAX_PROCESS_WIDTH tak capped, koi
    // hardcoded 4:3 assumption nahi. Ye query GPU-cheap hai
    // (gl.getTexParameter jaisa metadata call nahi, seedha
    // gl.TEXTURE_WIDTH/HEIGHT texture-level param query hai) — har
    // frame chalane laayak sasta hai, lekin hum sirf tab kaam karte
    // hain jab dims abhi tak known nahi ya badal gaye hain.
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const srcWidth = gl.getTexLevelParameter
      ? (gl.getTexLevelParameter(gl.TEXTURE_2D, 0, gl.TEXTURE_WIDTH) as number)
      : 0;
    const srcHeight = gl.getTexLevelParameter
      ? (gl.getTexLevelParameter(gl.TEXTURE_2D, 0, gl.TEXTURE_HEIGHT) as number)
      : 0;

    if (!this.sourceDimsKnown && srcWidth > 0 && srcHeight > 0) {
      const aspect = srcHeight / srcWidth;
      const targetWidth = Math.min(MAX_PROCESS_WIDTH, srcWidth);
      const targetHeight = Math.max(1, Math.round(targetWidth * aspect));
      this.allocateBuffers(gl, targetWidth, targetHeight);
      this.sourceDimsKnown = true;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ownFbo);
    gl.viewport(0, 0, this.renderCanvasWidth, this.renderCanvasHeight);

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const aPos = gl.getAttribLocation(this.program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.texUniformLoc, 0);

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Async ping-pong PBO readback instead of a blocking gl.readPixels()
    // straight into a JS typed array.
    const writeIdx = this.pboWriteIndex;
    const readIdx: 0 | 1 = writeIdx === 0 ? 1 : 0;

    // 1) Queue a new (non-blocking) GPU readback into the "write" slot.
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo[writeIdx]);
    gl.readPixels(0, 0, this.renderCanvasWidth, this.renderCanvasHeight, gl.RGBA, gl.UNSIGNED_BYTE, 0);

    if (this.pboSync[writeIdx]) {
      gl.deleteSync(this.pboSync[writeIdx]!);
    }
    this.pboSync[writeIdx] = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.flush();

    // 2) Try to harvest the OTHER slot's data — written on a previous
    // tick, so it's had time to finish on the GPU.
    const readySync = this.pboSync[readIdx];
    if (readySync) {
      const status = gl.getSyncParameter(readySync, gl.SYNC_STATUS);
      if (status === gl.SIGNALED) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo[readIdx]);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.pixelBuffer);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteSync(readySync);
        this.pboSync[readIdx] = null;

        if (this.outputCtx && this.outputCanvas) {
          const w = this.renderCanvasWidth;
          const h = this.renderCanvasHeight;
          if (!this.cachedImageData || this.cachedImageData.width !== w || this.cachedImageData.height !== h) {
            this.cachedImageData = this.outputCtx.createImageData(w, h);
          }
          this.cachedImageData.data.set(this.pixelBuffer);
          this.outputCtx.putImageData(this.cachedImageData, 0, 0);
          this.notify();
        }
      }
      // else: GPU not done yet with that slot — skip this tick, try
      // again next tick. We do NOT block/wait for it.
    }

    this.pboWriteIndex = readIdx;

    // TEMP (measurement only): record how long this processView() call
    // took, and feed it into the rolling FPS/avg-time counter.
    if (DEBUG_PERF_LOG) {
      this.extractionPerf.record(performance.now() - __perfStart);
    }
  }

  private notify() {
    this.listeners.forEach((cb) => cb(this.outputCanvas));
  }

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  reset() {
    const gl = this.gl;
    if (gl) {
      if (this.pboSync[0]) gl.deleteSync(this.pboSync[0]!);
      if (this.pboSync[1]) gl.deleteSync(this.pboSync[1]!);
      if (this.pbo[0]) gl.deleteBuffer(this.pbo[0]!);
      if (this.pbo[1]) gl.deleteBuffer(this.pbo[1]!);
      if (this.ownFbo) gl.deleteFramebuffer(this.ownFbo);
      if (this.ownTargetTexture) gl.deleteTexture(this.ownTargetTexture);
    }
    this.pbo = [null, null];
    this.pboSync = [null, null];
    this.pboWriteIndex = 0;

    this.ready = false;
    this.supported = false;
    this.gl = null;
    this.binding = null;
    this.program = null;
    this.quadBuffer = null;
    this.ownFbo = null;
    this.ownTargetTexture = null;
    this.pixelBuffer = null;
    this.cachedImageData = null;
    this.lastProcessTime = 0;
    this.outputCanvas = null;
    this.outputCtx = null;
    this.sourceDimsKnown = false;
  }
}

export const xrCameraSource = new XRCameraSource();
      
