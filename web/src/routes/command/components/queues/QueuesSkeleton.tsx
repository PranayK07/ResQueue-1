import { Skeleton } from '@/lib/ui/skeleton';
import { cn } from '@/lib/utils';

/** Placeholder card count while loading. Not data. */
const PLACEHOLDER_CARDS = 3;
// bg-accent so the bars show on the raised surface-2 cards; no pulse for reduced motion.
const BAR = 'bg-accent motion-reduce:animate-none';

/** Loading stand-in shaped like a few station cards. */
export function QueuesSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading station lines</span>
      {Array.from({ length: PLACEHOLDER_CARDS }, (_, i) => (
        <div key={i} className="rounded-card border border-border bg-surface-2 p-3">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className={cn(BAR, 'h-4 w-32')} />
            <Skeleton className={cn(BAR, 'h-3 w-14')} />
          </div>
          <Skeleton className={cn(BAR, 'mt-3 h-12 w-full')} />
          <Skeleton className={cn(BAR, 'mt-2 h-12 w-full')} />
        </div>
      ))}
    </div>
  );
}
