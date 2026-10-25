import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useGuide } from './GuideProvider';

/** "Guidance ready · N steps" for the header. Hidden when no step can run right now. */
export function GuidancePill({ className }: { className?: string }) {
  const guide = useGuide();
  if (!guide || guide.stepCount === 0) return null;
  const n = guide.stepCount;
  return (
    <button
      type="button"
      onClick={guide.start}
      aria-pressed={guide.open}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-guide/30 bg-guide/10 px-3 text-xs font-medium text-guide transition-colors hover:bg-guide/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        guide.mode === 'scroll' && 'h-12 px-4',
        className
      )}
    >
      <Sparkles className="size-3.5" aria-hidden />
      Guidance ready · {n} {n === 1 ? 'step' : 'steps'}
    </button>
  );
}
