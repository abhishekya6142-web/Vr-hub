import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { AppDef } from './apps';

// A generous grace period before we give up and assume the frame is
// blocked. Long enough to not misclassify a merely-slow load as blocked,
// but still a fallback in case neither onLoad nor onError ever fires.
const BLOCK_FALLBACK_MS = 8000;

// Detects an X-Frame-Options / CSP frame-ancestors block: when framing is
// denied, the frame's document stays at "about:blank" and (being same-
// origin, empty) is readable without a cross-origin exception. A
// successfully loaded cross-origin page throws on access instead. We also
// race a timeout in case the load event never fires at all.
export function IframeApp({ app }: { app: AppDef }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'blocked'>('loading');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const settledRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    settledRef.current = false;
    setState('loading');
    const timeoutId = setTimeout(() => settle('blocked'), BLOCK_FALLBACK_MS);
    return () => {
      mountedRef.current = false;
      clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.url]);

  function settle(next: 'loaded' | 'blocked') {
    if (settledRef.current || !mountedRef.current) return;
    settledRef.current = true;
    setState(next);
  }

  function handleLoad() {
    try {
      const href = iframeRef.current?.contentWindow?.location.href;
      settle(href === 'about:blank' ? 'blocked' : 'loaded');
    } catch {
      // Cross-origin access threw, which only happens once real content
      // from the destination has actually loaded into the frame.
      settle('loaded');
    }
  }

  function handleError() {
    settle('blocked');
  }

  return (
    <div className="relative h-full w-full bg-black">
      <iframe
        ref={iframeRef}
        src={app.url}
        title={app.name}
        className={`h-full w-full border-0 transition-opacity duration-300 ${state === 'loaded' ? 'opacity-100' : 'opacity-0'}`}
        onLoad={handleLoad}
        onError={handleError}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />

      {state === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-900">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-teal-400/30 border-t-teal-400" />
        </div>
      )}

      {state === 'blocked' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-neutral-900 px-8 text-center">
          <p className="max-w-sm text-sm text-white/70">
            {app.name} doesn't allow being shown inside another app. Open it in a new tab instead.
          </p>
          <a
            href={app.externalUrl ?? app.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full bg-teal-500 px-5 py-2 text-sm font-semibold text-black transition-colors duration-200 hover:bg-teal-400"
          >
            <ExternalLink className="h-4 w-4" />
            Open {app.name}
          </a>
        </div>
      )}
    </div>
  );
}
