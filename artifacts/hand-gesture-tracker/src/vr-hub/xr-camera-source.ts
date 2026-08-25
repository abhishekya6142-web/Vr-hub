// xr-camera-source.ts

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

// Chhota on-canvas FPS text — sirf ek line, top-left corner. Ye actual
// camera-extraction rate dikhata hai (jitni baar naya frame CPU tak
// successfully aata hai — notify() call hone par), na ki render loop
// ka FPS. Koi mode/toggle nahi, hamesha on rehta hai.
const FPS_SAMPLE_WINDOW_MS = 500;

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
  private renderCanvasWidth = 640;
  private renderCanvasHeight = 480;
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

  // FPS counter state (extraction rate — counts notify() calls, i.e.
  // actual new-frame-delivered-to-CPU events).
  private fpsFrameCount = 0;
  private fpsWindowStart = 0;
  private fpsDisplay = 0;

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
      fps: this.fpsDisplay,
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
      this.program = program;
      this.texUniformLoc = gl.getUniformLocation(program, 'uTex');

      const quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      this.quadBuffer = quad;

      const fbo = gl.createFramebuffer();
      const targetTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, targetTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        this.renderCanvasWidth,
        this.renderCanvasHeight,
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

      const pboByteSize = this.renderCanvasWidth * this.renderCanvasHeight * 4;
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

      const outCanvas = document.createElement('canvas');
      outCanvas.width = this.renderCanvasWidth;
      outCanvas.height = this.renderCanvasHeight;
      this.outputCanvas = outCanvas;
      this.outputCtx = outCanvas.getContext('2d', { willReadFrequently: true });

      // OPTIMIZATION: pehle pixelBuffer ek standalone Uint8Array tha,
      // aur har frame par uska data cachedImageData.data mein
      // `.set()` se COPY hota tha (ek extra full-frame memcpy, har
      // ~33ms). Ab cachedImageData sabse pehle bana lete hain, aur
      // pixelBuffer ko USI ImageData.data ke underlying buffer se
      // directly backed karte hain (same memory, do views). Isse
      // getBufferSubData seedha ImageData ke andar hi likhta hai —
      // koi extra copy step nahi. Output pixels bilkul same rehte
      // hain, bas ek memcpy kam hota hai per frame.
      if (this.outputCtx) {
        this.cachedImageData = this.outputCtx.createImageData(
          this.renderCanvasWidth,
          this.renderCanvasHeight,
        );
        this.pixelBuffer = new Uint8Array(this.cachedImageData.data.buffer);
      } else {
        // Fallback (should not normally happen): agar 2d context na
        // mile to purana standalone-buffer tareeka.
        this.pixelBuffer = new Uint8Array(pboByteSize);
      }

      this.supported = true;
      this.ready = true;
      this.lastProcessTime = 0;
      this.fpsFrameCount = 0;
      this.fpsWindowStart = performance.now();
      this.fpsDisplay = 0;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.supported = false;
      this.ready = false;
    }
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
        // OPTIMIZATION: pixelBuffer ab seedha cachedImageData.data ke
        // buffer se backed hai, isliye ye getBufferSubData call
        // seedha ImageData ke andar likhta hai. Neeche wala
        // .set()-based extra copy ab zaroori nahi.
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.pixelBuffer);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteSync(readySync);
        this.pboSync[readIdx] = null;

        if (this.outputCtx && this.outputCanvas && this.cachedImageData) {
          this.outputCtx.putImageData(this.cachedImageData, 0, 0);
          this.drawFpsOverlay();
          this.notify();
          this.tickFps();
        }
      }
      // else: GPU not done yet with that slot — skip this tick, try
      // again next tick. We do NOT block/wait for it.
    }

    this.pboWriteIndex = readIdx;
  }

  // Chhota FPS counter — sirf ek number update karta hai, ~500ms
  // window mein kitne frames deliver hue us se rate nikalta hai.
  private tickFps() {
    this.fpsFrameCount++;
    const now = performance.now();
    const elapsed = now - this.fpsWindowStart;
    if (elapsed >= FPS_SAMPLE_WINDOW_MS) {
      this.fpsDisplay = Math.round((this.fpsFrameCount * 1000) / elapsed);
      this.fpsFrameCount = 0;
      this.fpsWindowStart = now;
    }
  }

  // Ek chhoti text line canvas ke top-left corner par draw karta hai,
  // putImageData ke turant baad (taaki putImageData isko overwrite na
  // kare). Koi mode/toggle nahi — hamesha on.
  private drawFpsOverlay() {
    const ctx = this.outputCtx;
    if (!ctx) return;
    const text = `${this.fpsDisplay} FPS`;
    ctx.save();
    ctx.font = '14px monospace';
    const padding = 4;
    const textWidth = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, textWidth + padding * 2, 20);
    ctx.fillStyle = '#00ff00';
    ctx.textBaseline = 'top';
    ctx.fillText(text, padding, padding);
    ctx.restore();
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
    this.fpsFrameCount = 0;
    this.fpsWindowStart = 0;
    this.fpsDisplay = 0;
    this.outputCanvas = null;
    this.outputCtx = null;
  }
}

export const xrCameraSource = new XRCameraSource();
