// XR Camera Source
// ---------------------------------------------------------------------------
// WebXR 'camera-access' feature (Raw Camera Access API) se real camera
// frames leta hai — taaki WebXR passthrough aur MediaPipe hand-tracking
// EK HI camera stream use karein, do independent getUserMedia() consumers
// na bane (jo device pe conflict/crash karte the).
//
// Problem: XRWebGLBinding.getCameraImage(view.camera) sirf ek opaque
// WebGLTexture deta hai — MediaPipe Hands ko <video> ya <canvas> chahiye,
// GPU texture seedha nahi. Isliye:
//
//   1. Ek chhota WebGL shader-quad banate hain (fullscreen triangle).
//   2. Har XR frame, us texture ko is quad ke through render karte hain,
//      seedha canvas ke default framebuffer pe.
//   3. HandTracker.tsx isi <canvas> ko `hands.send({ image: canvas })`
//      se feed karta hai — jaise pehle <video> feed karta tha.
//
// XRHub.tsx isi WebGL context ko use karta hai jo XRWebGLLayer ke liye
// already bana hua hai (WebXR ek hi GL context expect karta hai session
// ke saath) — is module ko sirf gl + XRWebGLBinding milta hai, naya
// context nahi banata.
// ---------------------------------------------------------------------------

type Listener = (canvas: HTMLCanvasElement | null) => void;

interface XRViewLike {
  camera?: unknown; // XRCamera — feature-detected at runtime
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
    // Camera texture upside-down aati hai canvas coords ke hisaab se —
    // isliye V flip karte hain yahin, MediaPipe ko sahi-orientation frame mile.
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

  isSupported() {
    return this.supported;
  }

  isReady() {
    return this.ready;
  }

  getCanvas() {
    return this.outputCanvas;
  }

  // XRHub calls this once per session, after session.updateRenderState()
  // aur pehle requestAnimationFrame loop shuru ho. gl = wahi WebGL context
  // jo XRWebGLLayer ke liye bana tha.
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
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]), // fullscreen triangle
        gl.STATIC_DRAW,
      );
      this.quadBuffer = quad;

      // Output canvas — ye wohi cheez hai jo HandTracker ko milegi.
      // Size CAPTURE_WIDTH/HEIGHT jaisa rakha hai taaki MediaPipe ko
      // consistent resolution mile jaisa normal <video> path me milta hai.
      const outCanvas = document.createElement('canvas');
      outCanvas.width = 640;
      outCanvas.height = 480;
      this.outputCanvas = outCanvas;
      this.outputCtx = outCanvas.getContext('2d');

      this.supported = true;
      this.ready = true;
    } catch (err) {
      console.error('[xr-camera-source] init failed:', err);
      this.supported = false;
      this.ready = false;
    }
  }

  // XRHub's per-XR-frame loop calls this with the current frame + view.
  // Renders the camera texture into the shared gl canvas, then copies the
  // pixels into outputCanvas (2D canvas) so MediaPipe (jo WebGL texture
  // seedha nahi le sakta) usе normal canvas ki tarah consume kar sake.
  updateFromView(view: XRViewLike) {
    if (!this.ready || !this.gl || !this.binding || !this.program || !this.quadBuffer) return;
    if (!view.camera) return; // camera-access feature is view pe available nahi

    const gl = this.gl;

    let texture: WebGLTexture;
    try {
      texture = this.binding.getCameraImage(view.camera);
    } catch {
      return; // feature granted nahi ya frame abhi ready nahi
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

    // GL canvas se pixels nikaal ke 2D output canvas pe copy karo — ye har
    // frame ek readback hai (thoda costly), lekin MediaPipe ko compatible
    // source dene ka yehi tareeka hai jab hume seedha video element nahi
    // milta. Agar performance issue ho to future me isе OffscreenCanvas +
    // ImageBitmap se optimize kar sakte hain.
    if (this.outputCtx && this.gl.canvas instanceof HTMLCanvasElement) {
      this.outputCtx.drawImage(
        this.gl.canvas,
        0,
        0,
        this.outputCanvas!.width,
        this.outputCanvas!.height,
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
