import React, { useState, useRef, useEffect } from 'react';

export type VisionWindow = {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  content: React.ReactNode;
};

interface VisionWindowManagerProps {
  pinchMarkers: { x: number; y: number }[];
}

export function VisionWindowManager({ pinchMarkers }: VisionWindowManagerProps) {
  const [windows, setWindows] = useState<VisionWindow[]>([
    {
      id: 'win-1',
      title: 'Browser',
      x: 100,
      y: 100,
      width: 420,
      height: 320,
      content: <div style={{ padding: '20px', color: '#fff' }}>🌐 Welcome to dr.versal.app</div>,
    },
    {
      id: 'win-2',
      title: 'YouTube Player',
      x: 560,
      y: 150,
      width: 450,
      height: 280,
      content: <div style={{ padding: '20px', color: '#fff' }}>📺 Spatial Video Player</div>,
    },
  ]);

  const dragStateRef = useRef<{
    windowId: string;
    offsetX: number;
    offsetY: number;
  } | null>(null);

  // Handle dimensions for exact hit-testing
  const HANDLE_WIDTH = 160;
  const HANDLE_HEIGHT = 32;
  const HANDLE_GAP = 12; // Window ke niche ka gap

  useEffect(() => {
    if (pinchMarkers.length === 0) {
      dragStateRef.current = null;
      return;
    }

    const marker = pinchMarkers[0];

    if (!dragStateRef.current) {
      // Top window se check shuru karte hain
      for (let i = windows.length - 1; i >= 0; i--) {
        const win = windows[i];
        
        // Exact spatial coordinates for the floating pill handle
        const handleTop = win.y + win.height + HANDLE_GAP;
        const handleBottom = handleTop + HANDLE_HEIGHT;
        const handleLeft = win.x + (win.width / 2) - (HANDLE_WIDTH / 2);
        const handleRight = handleLeft + HANDLE_WIDTH;

        const isInsideHandle =
          marker.x >= handleLeft &&
          marker.x <= handleRight &&
          marker.y >= handleTop &&
          marker.y <= handleBottom;

        if (isInsideHandle) {
          dragStateRef.current = {
            windowId: win.id,
            offsetX: marker.x - win.x,
            offsetY: marker.y - win.y,
          };

          // Window ko top active layer par lane ke liye array ke end me daal do
          setWindows((prev) => {
            const filtered = prev.filter((w) => w.id !== win.id);
            return [...filtered, win];
          });
          break;
        }
      }
    } else {
      // Dragging movement
      const { windowId, offsetX, offsetY } = dragStateRef.current;
      setWindows((prev) =>
        prev.map((win) =>
          win.id === windowId
            ? { ...win, x: marker.x - offsetX, y: marker.y - offsetY }
            : win
        )
      );
    }
  }, [pinchMarkers]);

  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 888888 }}>
      {windows.map((win, index) => (
        <div
          key={win.id}
          style={{
            position: 'absolute',
            left: win.x,
            top: win.y,
            width: win.width,
            height: win.height,
            zIndex: index,
            pointerEvents: 'auto',
            display: 'flex',
            flexDirection: 'column',
            // --- Vision Pro Glassmorphism styling ---
            background: 'rgba(255, 255, 255, 0.1)',
            backdropFilter: 'blur(30px) saturate(140%)',
            WebkitBackdropFilter: 'blur(30px) saturate(140%)',
            borderRadius: '24px',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            boxShadow: '0 30px 70px rgba(0, 0, 0, 0.35)',
            overflow: 'visible', // Bahar floating handle dikhane ke liye zaroori hai
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '14px 20px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.12)',
              color: 'rgba(255, 255, 255, 0.85)',
              fontWeight: 500,
              fontSize: '15px',
              letterSpacing: '0.3px',
            }}
          >
            {win.title}
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {win.content}
          </div>

          {/* --- AUTHENTIC VISIONOS FLOATING DRAG CAPSULE --- */}
          <div
            style={{
              position: 'absolute',
              bottom: `-${HANDLE_HEIGHT + HANDLE_GAP}px`,
              left: '50%',
              transform: 'translateX(-50%)',
              width: `${HANDLE_WIDTH}px`,
              height: `${HANDLE_HEIGHT}px`,
              // Capsule Glass Effect
              background: 'rgba(255, 255, 255, 0.12)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              borderRadius: '999px',
              border: '1px solid rgba(255, 255, 255, 0.18)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
              display: 'flex',
              alignItems: 'center',
              padding: '0 12px',
              boxSizing: 'border-box',
              transition: 'background 0.2s, border-color 0.2s',
            }}
          >
            {/* Left Dot Indicator (Close/Options icon mimicking Vision Pro) */}
            <div
              style={{
                width: '7px',
                height: '7px',
                background: 'rgba(255, 255, 255, 0.35)',
                borderRadius: '50%',
                marginRight: '12px',
                flexShrink: 0,
              }}
            />

            {/* Center Drag Pill Bar */}
            <div
              style={{
                flex: 1,
                height: '4px',
                background: 'rgba(255, 255, 255, 0.4)',
                borderRadius: '999px',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
