import React, { useState, useRef, useEffect } from 'react';

// Window ka data structure
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
  // Mock windows setup - tum isme apni marzi ke kitne bhi windows add kar sakte ho
  const [windows, setWindows] = useState<VisionWindow[]>([
    {
      id: 'win-1',
      title: 'Browser',
      x: 100,
      y: 150,
      width: 400,
      height: 300,
      content: <div style={{ padding: '20px', color: '#fff' }}>🌐 Welcome to dr.versal.app</div>,
    },
    {
      id: 'win-2',
      title: 'YouTube Player',
      x: 550,
      y: 200,
      width: 450,
      height: 280,
      content: <div style={{ padding: '20px', color: '#fff' }}>📺 Video Player Content Here</div>,
    },
    {
      id: 'win-3',
      title: 'Settings',
      x: 300,
      y: 400,
      width: 350,
      height: 250,
      content: <div style={{ padding: '20px', color: '#fff' }}>⚙️ System Configurations</div>,
    },
  ]);

  // Dragging state ko bina lag ke monitor karne ke liye Ref
  const dragStateRef = useRef<{
    windowId: string;
    offsetX: number;
    offsetY: number;
  } | null>(null);

  useEffect(() => {
    // Agar koi pinch nahi kar raha, toh drag state khatam
    if (pinchMarkers.length === 0) {
      dragStateRef.current = null;
      return;
    }

    // Pehla active pinch point pakadte hain
    const marker = pinchMarkers[0];

    // Case 1: Agar abhi tak koi window pakdi (drag) nahi hai, toh check karo hit-test
    if (!dragStateRef.current) {
      // Piche se loop chalayenge taaki Z-index mein jo window sabse upar ho, pehle wo select ho
      for (let i = windows.length - 1; i >= 0; i--) {
        const win = windows[i];
        
        // Vision Pro style bottom bar handle check (Window ke thik neeche 30px ki bar)
        const handleTop = win.y + win.height;
        const handleBottom = handleTop + 30;
        const handleLeft = win.x + (win.width / 2) - 60; // Center se aligned pill handle
        const handleRight = handleLeft + 120;

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

          // Jis window ko pakda hai use array ke end mein bhej do taaki wo active/top z-index par aa jaye
          setWindows((prev) => {
            const filtered = prev.filter((w) => w.id !== win.id);
            return [...filtered, win];
          });
          break;
        }
      }
    } else {
      // Case 2: Agar window already pakdi hui hai, toh pinch marker ke saath use move karo
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
            zIndex: index, // Array index hi iska dynamic Z-index ban jata hai
            pointerEvents: 'auto',
            display: 'flex',
            flexDirection: 'column',
            // --- Vision Pro Glassmorphism Effect ---
            background: 'rgba(255, 255, 255, 0.1)',
            backdropFilter: 'blur(25px) saturate(120%)',
            WebkitBackdropFilter: 'blur(25px) saturate(120%)',
            borderRadius: '16px',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            boxShadow: '0 20px 50px rgba(0, 0, 0, 0.3)',
            overflow: 'visible', // Taaki handle bar bahar dikhe
          }}
        >
          {/* Header Bar */}
          <div
            style={{
              padding: '12px 16px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.15)',
              color: 'rgba(255, 255, 255, 0.9)',
              fontWeight: 600,
              fontSize: '14px',
              letterSpacing: '0.5px',
            }}
          >
            {win.title}
          </div>

          {/* Window Body Content */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {win.content}
          </div>

          {/* --- Vision Pro Bottom Drag Pill Handle --- */}
          <div
            style={{
              position: 'absolute',
              bottom: '-25px',
              left: '50%',
              transform: 'translateX(-50%)',
              width: '120px',
              height: '8px',
              background: 'rgba(255, 255, 255, 0.35)',
              borderRadius: '999px',
              cursor: 'grab',
              boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
              border: '1px solid rgba(255,255,255,0.1)',
              transition: 'background 0.2s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.6)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.35)')}
          />
        </div>
      ))}
    </div>
  );
}
