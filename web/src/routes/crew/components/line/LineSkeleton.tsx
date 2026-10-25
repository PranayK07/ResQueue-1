import { Skeleton } from '@/lib/ui/skeleton';
import { cn } from '@/lib/utils';

const BLOCK = 'motion-reduce:animate-none';
const ROW_COUNT = 3;

/** Loading stand-in shaped like the line's rows. */
export function LineSkeleton({ className }: { className?: string }) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">Loading the line</span>
      <div className="divide-y divide-border">
        {Array.from({ length: ROW_COUNT }, (_, i) => (
          <div key={i} className="flex min-h-14 items-center gap-3 px-4 py-3">
            <Skeleton className={cn(BLOCK, 'size-4')} />
            <div className="flex-1 space-y-1.5">
              <Skeleton className={cn(BLOCK, 'h-4 w-2/3')} />
              <Skeleton className={cn(BLOCK, 'h-3 w-1/3')} />
            </div>
            <Skeleton className={cn(BLOCK, 'h-5 w-16')} />
          </div>
        ))}
      </div>
    </div>
  );
}
