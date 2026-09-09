import type { LucideIcon } from 'lucide-react';

type ComingSoonAppProps = {
  title: string;
  description: string;
  icon: LucideIcon;
};

// NAYA: shared placeholder shell for apps that are registered on the
// home panel but whose functionality isn't implemented yet
// (Accessibility, Settings, Education, AI Assistant, Maps). Each app
// gets its own thin wrapper component (below-style files) that passes
// its own title/description/icon into this, so swapping in real
// functionality later only means replacing that one wrapper's body.
export function ComingSoonApp({ title, description, icon: Icon }: ComingSoonAppProps) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 text-white/80">
        <Icon className="h-8 w-8" />
      </div>
      <h2 className="text-lg font-medium text-white">{title}</h2>
      <p className="max-w-xs text-sm text-white/60">{description}</p>
      <span className="mt-2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium tracking-wide text-white/50">
        Coming soon
      </span>
    </div>
  );
}
