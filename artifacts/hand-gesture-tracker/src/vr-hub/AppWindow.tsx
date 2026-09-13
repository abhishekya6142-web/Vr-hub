import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { X } from 'lucide-react';
import { Dwellable } from './Dwellable';
import { IframeApp } from './IframeApp';
import { YoutubeApp } from './YoutubeApp';
import { Calculator } from './Calculator';
import { Theatre } from './Theatre';
import { GamesHub } from './GamesHub';
import { VoiceSearch } from './VoiceSearch';
import { AccessibilityApp } from './AccessibilityApp';
import { SettingsApp } from './SettingsApp';
import { EducationApp } from './EducationApp';
import { AiAssistantApp } from './AiAssistantApp';
import { MapsApp } from './MapsApp';
import type { AppDef } from './apps';

type AppWindowProps = {
  app: AppDef;
  originRect: DOMRect | null;
  closing: boolean;
  onClose: () => void;
  // FIX (grey/washed-out camera view bug): AppWindow's own card chrome
  // — bg-neutral-900/95 background, border, shadow, and the header bar
  // with the app name + close button — was ALWAYS rendered, even while
  // AccessibilityApp had switched itself into full-screen mode
  // (accessibilityMode.setFullScreen(true), which makes VRHubInner hide
  // its own world-locked panel UI). AccessibilityApp's own full-screen
  // view had already had its "bg-black" removed so the real WebXR
  // camera passthrough would show through, but this OUTER AppWindow
  // wrapper still painted its ~95%-opaque dark background + header bar
  // on top of everything, which is what actually caused the
  // grey/hazy tint and the overlapping "Accessibility" title text seen
  // on screen.
  //
  // When true, this component renders ONLY app.type's inner content —
  // no background, no border/shadow, no header bar — so the content
  // (here, AccessibilityApp's own full-screen overlay) has a fully
  // transparent path down to the real camera passthrough underneath.
  fullScreenTransparent?: boolean;
};

// Renders as a fill-parent panel now (the parent <Panel> from
// react-resizable-panels controls actual size/position on screen), rather
// than a fixed-size, self-centered modal. The open/close scale+fade
// animation (growing from the icon's on-screen rect) is unchanged.
export function AppWindow({ app, originRect, closing, onClose, fullScreenTransparent = false }: AppWindowProps) {
  const winRef = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState(false);
  const [originTransform, setOriginTransform] = useState('scale(0.3)');
  const raf1Ref = useRef<number>(0);
  const raf2Ref = useRef<number>(0);

  useLayoutEffect(() => {
    let cancelled = false;
    const el = winRef.current;
    if (!el || !originRect) {
      setOpened(true);
      return;
    }
    const finalRect = el.getBoundingClientRect();
    const scaleX = Math.max(originRect.width / finalRect.width, 0.05);
    const scaleY = Math.max(originRect.height / finalRect.height, 0.05);
    const dx = originRect.left + originRect.width / 2 - (finalRect.left + finalRect.width / 2);
    const dy = originRect.top + originRect.height / 2 - (finalRect.top + finalRect.height / 2);
    setOriginTransform(`translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`);
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        if (!cancelled) setOpened(true);
      });
      raf2Ref.current = raf2;
    });
    raf1Ref.current = raf1;
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1Ref.current);
      cancelAnimationFrame(raf2Ref.current);
    };
  }, [originRect]);

  const showOpen = opened && !closing;
  const style: CSSProperties = {
    transform: showOpen ? 'translate(0, 0) scale(1, 1)' : originTransform,
    opacity: showOpen ? 1 : 0,
    transition: 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease',
  };

  const content = (
    <div className="flex-1 overflow-hidden">
      {app.type === 'calculator' ? (
        <Calculator />
      ) : app.type === 'theatre' ? (
        <Theatre />
      ) : app.type === 'games' ? (
        <GamesHub />
      ) : app.type === 'voiceSearch' ? (
        // FIX: naya keyboard-free search — mic se query lo, phir
        // results dikhao. Purana IframeApp (jo hardcoded "hello" query
        // dikhata tha aur type karne ka koi tareeka nahi tha) yahan se
        // hata diya, sirf 'search' app ke liye.
        <VoiceSearch />
      ) : app.type === 'accessibility' ? (
        <AccessibilityApp />
      ) : app.type === 'settings' ? (
        // NAYA (placeholder shell)
        <SettingsApp />
      ) : app.type === 'education' ? (
        // NAYA (placeholder shell)
        <EducationApp />
      ) : app.type === 'aiAssistant' ? (
        // NAYA (placeholder shell)
        <AiAssistantApp />
      ) : app.type === 'maps' ? (
        // NAYA (placeholder shell)
        <MapsApp />
      ) : app.id === 'youtube' ? (
        <YoutubeApp app={app} />
      ) : (
        <IframeApp app={app} />
      )}
    </div>
  );

  // FIX (grey/washed-out camera view bug): when fullScreenTransparent
  // is true, skip the card chrome entirely — no background, no
  // border/shadow, no header bar. Just the animated wrapper (still
  // needed for the open/close scale+fade transition) plus the raw
  // content.
  if (fullScreenTransparent) {
    return (
      <div ref={winRef} style={style} className="flex h-full w-full flex-col overflow-hidden">
        {content}
      </div>
    );
  }

  return (
    <div
      ref={winRef}
      style={style}
      className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-900/95 shadow-2xl shadow-black/70"
    >
      <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-4 py-2.5">
        <span className="text-sm font-medium text-white/90">{app.name}</span>
        <Dwellable onSelect={onClose}>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors duration-200 hover:bg-red-500/80 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </Dwellable>
      </div>
      {content}
    </div>
  );
}
