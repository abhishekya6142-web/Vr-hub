// accessibility-mode.ts
//
// Chhota shared signal: sirf "Accessibility app abhi open/active hai
// ya nahi" batata hai. WebXR/HandTracker ka koi processing yahan se
// control NAHI hota — dono full power pe hamesha chalte rehte hain,
// Accessibility ke andar bhi. Ye flag sirf exit-signaling ke liye hai:
// AccessibilityApp apne andar pinch-count track karta hai, aur 3x
// consecutive pinch hone par is module ke through onExitRequested
// listeners ko fire karta hai taaki AppWindow/parent component
// Accessibility ko close kar sake.

type ExitListener = () => void;

class AccessibilityMode {
  private active = false;
  private exitListeners = new Set<ExitListener>();

  isActive() {
    return this.active;
  }

  setActive(value: boolean) {
    this.active = value;
  }

  // AccessibilityApp calls this when the user has completed the
  // 3x-consecutive-pinch exit gesture.
  requestExit() {
    this.exitListeners.forEach((cb) => cb());
  }

  // Parent (e.g. AppWindow / the component that renders
  // AccessibilityApp) subscribes to this to know when to close the
  // app and return to the normal home/AR view.
  onExitRequested = (cb: ExitListener): (() => void) => {
    this.exitListeners.add(cb);
    return () => {
      this.exitListeners.delete(cb);
    };
  };
}

export const accessibilityMode = new AccessibilityMode();
