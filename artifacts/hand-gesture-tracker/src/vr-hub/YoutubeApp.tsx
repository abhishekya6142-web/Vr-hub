import { useState } from 'react';
import { Search } from 'lucide-react';
import { Dwellable } from './Dwellable';
import { IframeApp } from './IframeApp';
import type { AppDef } from './apps';

const DEFAULT_QUERY = 'trending';

// The plain youtube.com homepage/video pages refuse to be framed
// (X-Frame-Options), so instead of loading youtube.com directly we build an
// "embed search" URL, which YouTube does allow inside an iframe:
//   https://www.youtube.com/embed?listType=search&list=<query>
// This renders a playable, playlist-style results player for the query.
function buildEmbedUrl(query: string): string {
  const q = query.trim() || DEFAULT_QUERY;
  return `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(q)}`;
}

export function YoutubeApp({ app }: { app: AppDef }) {
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [inputValue, setInputValue] = useState('');

  const runSearch = () => {
    const next = inputValue.trim();
    if (next) setQuery(next);
  };

  const embeddedApp: AppDef = {
    ...app,
    url: buildEmbedUrl(query),
    externalUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
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
        <IframeApp app={embeddedApp} key={embeddedApp.url} />
      </div>
    </div>
  );
}
