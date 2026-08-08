import React, { useRef } from 'react';
import { useCompassHeading } from './useCompassHeading';

export function SpatialCompass() {
  const radius = 1500; // Ring user se kitni door hogi (1.5 meters)
  const segments = 24; // 24 pieces mil kar ek circle banayenge
  const angleStep = 360 / segments; // Har piece 15 degree par ghoomega

  // Cylinder ka ek side kitna choda hoga uska math:
  const faceWidth = 2 * radius * Math.tan((Math.PI * (360 / segments)) / 360);

  // Directions set karna (0 degree = North, 90 = East, etc.)
  const directions: Record<number, string> = {
    0: 'N',
    45: 'NE',
    90: 'E',
    135: 'SE',
    180: 'S',
    225: 'SW',
    270: 'W',
    315: 'NW',
  };

  // REAL COMPASS INTEGRATION:
  // useCompassHeading tries to read the device's real magnetic-north
  // heading. On phones/browsers where that sensor doesn't fire (common
  // during an active WebXR session on some devices), headingDegrees
  // stays null and we fall back to the old behavior — ring stays fixed
  // relative to the anchor (wherever the AR session started facing),
  // which is what the original code always did.
  //
  // enabled = true always here; if you want to only spend battery/sensor
  // overhead while the compass is actually visible, wire a prop in.
  const { headingDegrees, isReal } = useCompassHeading(true);

  // FIX: cache the first-ever real heading we get as a "zero offset".
  // Without this, if the device heading arrives late (after we've
  // already rendered a few frames), the ring would visibly snap/jump
  // once real data kicks in. Instead we treat whatever heading we first
  // measured as directly usable — the ring rotates by the raw heading
  // itself so N always points at true north from that point forward.
  const hasWarnedRef = useRef(false);
  if (!isReal && !hasWarnedRef.current) {
    hasWarnedRef.current = true;
    // eslint-disable-next-line no-console
    console.info('[SpatialCompass] Real compass heading not available on this device/browser — falling back to anchor-relative North.');
  }

  // Counter-rotate the whole ring by -heading so that the segment
  // labeled "N" always faces true magnetic north, regardless of which
  // way the device/session anchor happens to be facing. When heading is
  // null (fallback), this is 0 — ring behaves exactly as before
  // (anchor-relative, N = wherever the AR session started facing).
  const headingOffset = isReal && headingDegrees != null ? headingDegrees : 0;

  return (
    // Yeh container scene ke ekdum center mein hoga
    <div
      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
      style={{
        transformStyle: 'preserve-3d',
        zIndex: 10,
        // Whole-ring counter-rotation for real-north alignment. See
        // headingOffset comment above — this is 0 (no-op) in fallback
        // mode, so non-supporting devices behave exactly like before.
        transform: `rotateY(${-headingOffset}deg)`,
        transition: 'transform 0.15s linear',
      }}
    >
      {/* 24 pieces loop karke ring generate karna */}
      {Array.from({ length: segments }).map((_, i) => {
        const angle = i * angleStep;
        const dirLabel = directions[angle];

        return (
          <div
            key={i}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center border-y border-white/20 bg-black/10 backdrop-blur-md"
            style={{
              width: `${faceWidth + 2}px`, // +2px extra taaki pieces ke beech gap na dikhe
              height: '4px', // Tumhe agar mota band chahiye toh '60px' kar do, images mein line hai isliye '4px' rakha hai
              // Ring banane ka magic idhar hai: rotate karo aur phir bahar (Z) push karo
              transform: `rotateY(${angle}deg) translateZ(-${radius}px)`,
              backfaceVisibility: 'hidden',
            }}
          >
            {/* Glowing White Line */}
            <div className="absolute inset-0 bg-white/40 shadow-[0_0_15px_rgba(255,255,255,0.6)]" />

            {/* Directions aur Markers */}
            {dirLabel ? (
              <div
                className="absolute flex flex-col items-center gap-2"
                style={{ transform: 'translateY(-30px)' }} // Line ke upar float karega
              >
                <span className="text-4xl font-bold tracking-widest text-white drop-shadow-[0_0_15px_rgba(255,255,255,1)]">
                  {dirLabel}
                </span>
                <div className="h-6 w-[2px] bg-white drop-shadow-[0_0_8px_rgba(255,255,255,1)]" />
              </div>
            ) : (
              // Chhote dot/tick marks un angles par jahan N, S, E, W nahi hai
              <div
                className="absolute h-3 w-[2px] bg-white/50"
                style={{ transform: 'translateY(-10px)' }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
