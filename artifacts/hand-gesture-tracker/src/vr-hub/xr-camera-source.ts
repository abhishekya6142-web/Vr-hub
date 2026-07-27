// xr-camera-source.ts
export class XRCameraSource {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private listeners: Set<(canvas: HTMLCanvasElement) => void> = new Set();
  private isSupportedFlag = false;

  constructor() {
    if (typeof window !== 'undefined') {
      this.canvas = document.createElement('canvas');
      this.canvas.width = 640;
      this.canvas.height = 480;
      this.initGL();
    }
  }

  public isSupported(): boolean {
    return this.isSupportedFlag && !!this.canvas;
  }

  public getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  public subscribe(callback: (canvas: HTMLCanvasElement) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private initGL() {
    if (!this.canvas) return;
    const gl = this.canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return;
    this.gl = gl;

    // Shaders handling WebGL Y-inversion and screen orientation orientation correction
    const vsSource = `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;
      uniform float u_angle;

      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        
        // Center texCoord around (0.5, 0.5) for rotation
        vec2 tc = a_texCoord - vec2(0.5);
        float s = sin(u_angle);
        float c = cos(u_angle);
        mat2 rot = mat2(c, -s, s, c);
        tc = rot * tc + vec2(0.5);

        // Correct WebGL top-left vs bottom-left Y-axis inversion
        v_texCoord = vec2(tc.x, 1.0 - tc.y);
      }
    `;

    const fsSource = `
      precision mediump float;
      uniform sampler2D u_image;
      varying vec2 v_texCoord;

      void main() {
        gl_FragColor = texture2D(u_image, v_texCoord);
      }
    `;

    const compileShader = (type: number, src: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      return shader;
    };

    const vs = compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    this.program = program;

    this.isSupportedFlag = true;
  }

  public updateFrame(binding: XRWebGLBinding, camera: XRCamera) {
    if (!this.gl || !this.program || !this.canvas) return;

    const gl = this.gl;
    const texture = binding.getCameraImage(camera);
    if (!texture) return;

    // Determine current device orientation angle (in radians)
    let rotationAngle = 0;
    if (window.screen && window.screen.orientation) {
      const angle = window.screen.orientation.angle || 0;
      // Convert degrees to radians (camera sensor offset on Android is typically 90deg in portrait)
      rotationAngle = (angle * Math.PI) / 180;
      if (angle === 0 || angle === 180) {
        // Portrait adjustment for Android camera sensor mounting
        rotationAngle += Math.PI / 2;
      }
    }

    // Match output canvas dimensions to camera texture width/height
    if (this.canvas.width !== camera.width || this.canvas.height !== camera.height) {
      this.canvas.width = camera.width;
      this.canvas.height = camera.height;
      gl.viewport(0, 0, camera.width, camera.height);
    }

    gl.useProgram(this.program);

    // Setup full-screen quad geometry
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const aPosition = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    const texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW
    );

    const aTexCoord = gl.getAttribLocation(this.program, 'a_texCoord');
    gl.enableVertexAttribArray(aTexCoord);
    gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 0, 0);

    const uAngle = gl.getUniformLocation(this.program, 'u_angle');
    gl.uniform1f(uAngle, rotationAngle);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_image'), 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Notify HandTracker subscribers that a new corrected frame is drawn
    this.listeners.forEach((cb) => cb(this.canvas!));
  }
}

export const xrCameraSource = new XRCameraSource();
