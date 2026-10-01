import { useEffect, useRef, type ReactNode } from 'react';
import { spatialTrackingEngine } from './spatial-tracking-engine';
import { xrPoseEngine } from './xr-pose-engine';

type SpatialAnchorProps = {
  children: ReactNode;
  parallaxAmount?: number;
  scaleCompensation?: boolean;
};

export function SpatialAnchor({
  children,
  parallaxAmount = 1,
  scaleCompensation = true,
}: SpatialAnchorProps) {
  const groupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = groupRef.current;
    if (!el) return;

    const resetTransform = () => {
      const current = groupRef.current;
      if (!current) return;

      current.style.transform =
        'translate3d(0,0,0) rotateX(0deg) rotateY(0deg) scale(1)';
    };

    const applyTransform = (
      shiftX: number,
      shiftY: number,
      rotateX: number,
      rotateY: number,
    ) => {
      const current = groupRef.current;
      if (!current) return;

      // IMPORTANT:
      // XR mode already gets its real world-lock transform from
      // VRHub.tsx / WebXR. Do NOT apply another transform here.
      if (xrPoseEngine.isActive()) {
        resetTransform();
        return;
      }

      let scale = 1;

      // Only used in non-XR gyro fallback mode.
      if (scaleCompensation) {
        const totalTilt = Math.abs(rotateX) + Math.abs(rotateY);
        scale = 1 - Math.min(totalTilt, 20) * 0.00075;
      }

      current.style.transform =
        `translate3d(${shiftX * parallaxAmount}px, ` +
        `${shiftY * parallaxAmount}px, 0) ` +
        `rotateX(${rotateX * parallaxAmount}deg) ` +
        `rotateY(${rotateY * parallaxAmount}deg) ` +
        `scale(${scale})`;
    };

    // If XR is already active when this component mounts,
    // make sure this component starts with an identity transform.
    if (xrPoseEngine.isActive()) {
      resetTransform();
    }

    // NON-XR FALLBACK ONLY:
    // Gyroscope-based parallax is allowed when WebXR is not active.
    const unsubscribeGyro = spatialTrackingEngine.subscribe((t) => {
      applyTransform(
        t.shiftX,
        t.shiftY,
        t.rotateX,
        t.rotateY,
      );
    });

    return () => {
      unsubscribeGyro();

      // Leave the component clean when unmounting.
      const current = groupRef.current;
      if (current) {
        current.style.transform =
          'translate3d(0,0,0) rotateX(0deg) rotateY(0deg) scale(1)';
      }
    };
  }, [parallaxAmount, scaleCompensation]);

  return (
    <div
      style={{
        perspective: '1200px',
        width: '100%',
        height: '100%',
      }}
    >
      <div
        ref={groupRef}
        style={{
          transform:
            'translate3d(0,0,0) rotateX(0deg) rotateY(0deg) scale(1)',
          transition: 'none',
          transformStyle: 'preserve-3d',
          width: '100%',
          height: '100%',
        }}
        onClick={() => spatialTrackingEngine.requestAccessManually()}
      >
        {children}
      </div>
    </div>
  );
}
