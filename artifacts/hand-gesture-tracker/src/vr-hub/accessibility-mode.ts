// accessibility-mode.ts
//
// Shared signal between AccessibilityApp and the top-level VRHubInner
// shell. Two things live here:
//
// 1. active — is the Accessibility app currently open at all (panel
//    stage OR full-screen stage). WebXR/HandTracker processing is
//    NEVER controlled by this — they always run at full power.
//
// 2. fullScreen — has the user pressed "Start" inside the
//    Accessibility panel? When true, VRHubInner should hide the
//    normal world-locked panel UI (home screen, other app panels,
//    recenter button etc.) and let AccessibilityApp render as a
//    full-screen overlay instead of staying inside its small
//    AppWindow panel card. WebXR session itself keeps running
//    underneath — only the visual panel chrome is hidden.
//
// Exit flow: user says "exit" (voice command, handled inside
// AccessibilityApp) -> AccessibilityApp calls requestExit() -> the
// subscriber in VRHubInner calls handleClose('accessibility') (the
// same function used for the panel's own X button), which closes the
// AppWindow and also implicitly ends full-screen mode (AccessibilityApp
// unmounts, its effect cleanup resets fullScreen to false).

type ExitListener = () => void;
type FullScreenListener = (fullScreen: boolean) => void;

class AccessibilityMode {
  private active = false;
  private fullScreen = false;
  private exitListeners = new Set<ExitListener>();
  private fullScreenListeners = new Set<FullScreenListener>();

  isActive() {
    return this.active;
  }

  setActive(value: boolean) {
    this.active = value;
    if (!value) this.setFullScreen(false);
  }

  isFullScreen() {
    return this.fullScreen;
  }

  setFullScreen(value: boolean) {
    if (this.fullScreen === value) return;
    this.fullScreen = value;
    this.fullScreenListeners.forEach((cb) => cb(this.fullScreen));
  }

  // AccessibilityApp calls this when the user says the exit voice
  // command.
  requestExit() {
    this.exitListeners.forEach((cb) => cb());
  }

  // VRHubInner subscribes to this to know when to close the
  // Accessibility AppWindow (calls its existing handleClose).
  onExitRequested = (cb: ExitListener): (() => void) => {
    this.exitListeners.add(cb);
    return () => {
      this.exitListeners.delete(cb);
    };
  };

  // VRHubInner subscribes to this to know when to hide/show the
  // normal panel UI.
  onFullScreenChange = (cb: FullScreenListener): (() => void) => {
    this.fullScreenListeners.add(cb);
    return () => {
      this.fullScreenListeners.delete(cb);
    };
  };
}

export const accessibilityMode = new AccessibilityMode();
