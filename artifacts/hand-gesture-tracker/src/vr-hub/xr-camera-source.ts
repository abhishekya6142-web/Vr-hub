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
  private frameLogCounter = 0;
  private totalFrames = 0;

  isSupported() {
    return this.supported;
  }

  isReady() {
    return this.ready;
  }

  getCanvas() {
    return this.outputCanvas;
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
      this.program = program;
      this.texUniformLoc = gl.getUniformLocation(program, 'uTex');

      const quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      this.quadBuffer = quad;

      const outCanvas = document.createElement('canvas');
      outCanvas.width = 640;
      outCanvas.height = 480;
      this.outputCanvas = outCanvas;
      this.outputCtx = outCanvas.getContext('2d', { willReadFrequently: true });

      this.supported = true;
      this.ready = true;
    } catch (err) {
      this.supported = false;
      this.ready = false;
    }
  }

  updateFromView(view: XRViewLike) {
    if (!this.ready || !this.gl || !this.binding || !this.program || !this.quadBuffer) return;

    this.totalFrames++;
    if (!view.camera) return; 

    const gl = this.gl;
    let texture: WebGLTexture;
    try {
      texture = this.binding.getCameraImage(view.camera);
    } catch {
      return; 
    }

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const aPos = gl.getAttribLocation(this.program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.texUniformLoc, 0);

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (this.outputCtx && this.outputCanvas) {
      // Force draw from WebGL framebuffer to 2D canvas explicitly
      this.outputCtx.drawImage(
        gl.canvas,
        0,
        0,
        gl.drawingBufferWidth,
        gl.drawingBufferHeight,
        0,
        0,
        this.outputCanvas.width,
        this.outputCanvas.height
      );
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
    this.outputCanvas = null;
    this.outputCtx = null;
  }
}

export const xrCameraSource = new XRCameraSource();
