import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, RotateCcw } from 'lucide-react';
import { Dwellable } from './Dwellable';

declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

type ListenState = 'idle' | 'listening' | 'error' | 'unsupported';

// Google ka "iframe-friendly" search mode — normal Google Search results
// embedding block kar dete hain, lekin igu=1 param wale results iframe ke
// andar chalte hain (jaisa apps.ts mein already use ho raha tha).
function buildSearchUrl(query: string) {
  return `https://www.google.com/search?igu=1&q=${encodeURIComponent(query)}`;
}

export function VoiceSearch() {
  const [listenState, setListenState] = useState<ListenState>('idle');
  const [query, setQuery] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setListenState('unsupported');
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      const transcript = event.results?.[0]?.[0]?.transcript?.trim();
      setListenState('idle');
      if (transcript) {
        setQuery(transcript);
      }
    };

    recognition.onerror = (event: any) => {
      setErrorMsg(
        event.error === 'not-allowed'
          ? 'Mic permission denied — browser/app settings mein mic allow karo.'
          : `Mic error: ${event.error}`,
      );
      setListenState('error');
    };

    recognition.onend = () => {
      // Agar 'listening' state mein hi khatam hua (results aane se
      // pehle — jaise koi awaaz na aayi), idle pe wapas laao taaki mic
      // button dobara press ho sake.
      setListenState((prev) => (prev === 'listening' ? 'idle' : prev));
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        // already stopped — ignore
      }
    };
  }, []);

  const startListening = useCallback(() => {
    if (!recognitionRef.current || listenState === 'listening') return;
    setErrorMsg(null);
    setListenState('listening');
    try {
      recognitionRef.current.start();
    } catch {
      // start() throws agar already-started state mein call ho — ignore
    }
  }, [listenState]);

  if (listenState === 'unsupported') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-neutral-900 px-8 text-center">
        <MicOff className="h-12 w-12 text-white/40" />
        <p className="max-w-sm text-sm text-white/70">
          Ye browser voice search support nahi karta. Chrome (Android) try karo.
        </p>
      </div>
    );
  }

  // Query mil chuki hai — results dikhao
  if (query) {
    return (
      <div className="flex h-full w-full flex-col bg-black">
        <div className="flex items-center gap-3 border-b border-white/10 bg-white/5 px-4 py-2.5">
          <span className="flex-1 truncate text-sm text-white/80">"{query}"</span>
          <Dwellable onSelect={startListening}>
            <button
              type="button"
              onClick={startListening}
              className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white/80 transition-colors duration-200 hover:bg-white/20"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Search again
            </button>
          </Dwellable>
        </div>
        <iframe
          key={query}
          src={buildSearchUrl(query)}
          title="Google Search results"
          className="h-full w-full flex-1 border-0"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      </div>
    );
  }

  // Abhi tak koi query nahi — mic button dikhao
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 bg-neutral-900 px-8 text-center">
      <Dwellable onSelect={startListening}>
        <button
          type="button"
          onClick={startListening}
          className={`flex h-24 w-24 items-center justify-center rounded-full shadow-xl transition-all duration-300 ${
            listenState === 'listening'
              ? 'scale-110 animate-pulse bg-red-500 shadow-red-500/50'
              : 'bg-gradient-to-br from-sky-400 to-blue-600 hover:scale-105'
          }`}
        >
          <Mic className="h-10 w-10 text-white" />
        </button>
      </Dwellable>
      <p className="text-sm text-white/70">
        {listenState === 'listening' ? 'Sun raha hu... bolo' : 'Mic pe pinch/dwell karo aur bolo kya search karna hai'}
      </p>
      {errorMsg && <p className="text-xs text-red-400">{errorMsg}</p>}
    </div>
  );
}
