import { useState } from 'react';
import { ExternalLink, Search } from 'lucide-react';
import { Dwellable } from './Dwellable';
import { IframeApp } from './IframeApp';
import type { AppDef } from './apps';

// YouTube deprecated the `listType=search` embed trick (it now renders
// "This video is unavailable"), and there's no way to embed arbitrary
// text-search results without the YouTube Data API (which needs an API
// key we don't have). So: the default view plays a fixed, always-
// embeddable video, and running a search opens real YouTube search
// results in a new tab instead of pretending to embed them.
const DEFAULT_VIDEO_ID = 'dQw4w9WgXcQ'; // a famously always-embeddable official video

export function YoutubeApp({ app }: { app: AppDef }) {
  const [inputValue, setInputValue] = useState('');
  const [searchQuery, setSearchQuery] = useState<string | null>(null);

  const runSearch = () => {
    const next = inputValue.trim();
    if (next) setSearchQuery(next);
  };

  const defaultApp: AppDef = {
    ...app,
    url: `https://www.youtube.com/embed/${DEFAULT_VIDEO_ID}`,
  };

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/5 px-3 py-2">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch();
          }}
          placeholder="Search YouTube..."
          className="flex-1 rounded-full bg-white/10 px-4 py-2 text-sm text-white placeholder:text-white/40 outline-none ring-1 ring-white/10 focus:ring-teal-400/60"
        />
        <Dwellable onSelect={runSearch}>
          <button
            type="button"
            onClick={runSearch}
            aria-label="Search"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-teal-500 text-black transition-colors duration-200 hover:bg-teal-400"
          >
            <Search className="h-4 w-4" />
          </button>
        </Dwellable>
      </div>

      <div className="flex-1 overflow-hidden">
        {searchQuery ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 bg-neutral-900 px-8 text-center">
            <p className="max-w-sm text-sm text-white/70">
              Inline search results need a YouTube Data API key, which this app doesn't have. Open your
              search for &ldquo;{searchQuery}&rdquo; on YouTube instead.
            </p>
            <a
              href={`https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full bg-teal-500 px-5 py-2 text-sm font-semibold text-black transition-colors duration-200 hover:bg-teal-400"
            >
              <ExternalLink className="h-4 w-4" />
              Open search results
            </a>
            <Dwellable onSelect={() => setSearchQuery(null)}>
              <button
                type="button"
                onClick={() => setSearchQuery(null)}
                className="text-xs text-white/50 underline underline-offset-2 hover:text-white/70"
              >
                Back to video
              </button>
            </Dwellable>
          </div>
        ) : (
          <IframeApp app={defaultApp} key={defaultApp.url} />
        )}
      </div>
    </div>
  );
}
