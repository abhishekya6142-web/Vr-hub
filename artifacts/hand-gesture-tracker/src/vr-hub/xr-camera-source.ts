// xr-camera-source.ts

type Listener = (canvas: HTMLCanvasElement | null) => void;

interface XRViewLike {
  camera?: unknown;
}

interface XRWebGLBindingLike {
  getCameraImage: (camera: unknown) => WebGLTexture;
}

interface XRWebGLBindingConstructor {
  new (session: unknown, gl: WebGLRenderingContext): XRWebGLBindingLike;
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

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
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

class XRCameraSource {
  private listeners = new Set<Listener>();
  private gl: WebGLRenderingContext | null = null;
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
    };
  }

  init(session: unknown, gl: WebGLRenderingContext) {
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

      const outCanvas = document.createElement('canvas');
      outCanvas.width = this.renderCanvasWidth;
      outCanvas.height = this.renderCanvasHeight;
      this.outputCanvas = outCanvas;
      this.outputCtx = outCanvas.getContext('2d', { willReadFrequently: true });

      this.supported = true;
      this.ready = true;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.supported = false;
      this.ready = false;
    }
  }

  updateFromView(view: XRViewLike) {
    if (!this.ready || !this.gl || !this.binding || !this.program || !this.quadBuffer || !this.ownFbo) return;

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

    if (!this.pixelBuffer || this.pixelBuffer.length !== this.renderCanvasWidth * this.renderCanvasHeight * 4) {
      this.pixelBuffer = new Uint8Array(this.renderCanvasWidth * this.renderCanvasHeight * 4);
    }
    gl.readPixels(
      0,
      0,
      this.renderCanvasWidth,
      this.renderCanvasHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.pixelBuffer,
    );

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // FIX: NO row-flip here anymore — the shader's vUv.y flip already
    // produces correctly-oriented pixels in this.pixelBuffer (top row
    // first). Flipping again here would undo that correct orientation.
    // We just copy pixelBuffer straight into ImageData.
    if (this.outputCtx && this.outputCanvas) {
      const w = this.renderCanvasWidth;
      const h = this.renderCanvasHeight;
      const imageData = this.outputCtx.createImageData(w, h);
      imageData.data.set(this.pixelBuffer);
      this.outputCtx.putImageData(imageData, 0, 0);
      this.notify();
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
    this.ready = false;
    this.supported = false;
    this.gl = null;
    this.binding = null;
    this.program = null;
    this.quadBuffer = null;
    this.ownFbo = null;
    this.ownTargetTexture = null;
    this.pixelBuffer = null;
    this.outputCanvas = null;
    this.outputCtx = null;
  }
}

export const xrCameraSource = new XRCameraSource();
