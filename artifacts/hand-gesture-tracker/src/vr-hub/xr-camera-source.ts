// xr-camera-source.ts

type FrameCallback = (canvas: HTMLCanvasElement) => void;

class XRCameraSource {
  private canvas: HTMLCanvasElement | null = null;
  private listeners: Set<FrameCallback> = new Set();
  private supported: boolean = false;
  private binding: any = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.canvas = document.createElement('canvas');
      this.canvas.width = 640;
      this.canvas.height = 480;
    }
  }

  public isSupported(): boolean {
    return this.supported;
  }

  public setSupported(val: boolean) {
    this.supported = val;
  }

  public getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  public subscribe(callback: FrameCallback): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  public updateCameraImage(session: XRSession, frame: XRFrame, view: any, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    if (!this.canvas) return;

    try {
      if (!this.binding && (window as any).XRWebGLBinding) {
        this.binding = new (window as any).XRWebGLBinding(session, gl);
      }

      if (!this.binding || !view || !view.camera) {
        this.supported = false;
        return;
      }

      const texture = this.binding.getCameraImage(view.camera);
      if (!texture) {
        this.supported = false;
        return;
      }

      this.supported = true;
      const width = view.camera.width || 640;
      const height = view.camera.height || 480;

      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }

      // Frame subscribers ko notify karo
      for (const cb of this.listeners) {
        cb(this.canvas);
      }
    } catch (err) {
      console.warn('[XRCameraSource] Frame update error:', err);
    }
  }
}

export const xrCameraSource = new XRCameraSource();
