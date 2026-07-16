export function HomeScreen({ onOpenApp }: HomeScreenProps) {
  const now = useClock();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  const { registerScrollTarget } = useDwellEngine();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    return registerScrollTarget(el);
  }, [registerScrollTarget]);

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-4 pb-24">
      <div
        ref={scrollRef}
        className="flex h-[70vh] w-[92vw] max-w-3xl flex-col items-center gap-10 overflow-y-auto rounded-2xl border border-white/10 bg-neutral-900/85 px-6 pb-10 pt-12 shadow-2xl shadow-black/70 backdrop-blur-[2px] transition-opacity duration-300 sm:h-[75vh] sm:w-[80vw] sm:pt-16"
      >
        <div className="text-center">
          <div className="font-mono text-6xl font-light tracking-tight text-white drop-shadow-lg sm:text-7xl">
            {time}
          </div>
          <div className="mt-2 text-sm font-medium text-white/60">{date}</div>
        </div>

        <div className="grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4">
          {APPS.map((app) => (
            <AppIcon key={app.id} app={app} onOpenApp={onOpenApp} />
          ))}
        </div>
      </div>
    </div>
  );
}
