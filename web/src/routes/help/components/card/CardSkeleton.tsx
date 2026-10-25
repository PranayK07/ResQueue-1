import { Skeleton } from '@/lib/ui/skeleton';
import { cn } from '@/lib/utils';

const BLOCK = 'motion-reduce:animate-none';

/** Loading stand-in shaped like the StatusCard frame. */
export function CardSkeleton({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn('rounded-frame border border-border bg-surface p-5', className)}
    >
      <span className="sr-only">Loading your request</span>
      <Skeleton className={cn(BLOCK, 'h-4 w-28')} />
      <Skeleton className={cn(BLOCK, 'mt-3 h-9 w-3/4')} />
      <Skeleton className={cn(BLOCK, 'mt-2 h-4 w-1/2')} />
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Skeleton className={cn(BLOCK, 'h-16 rounded-card')} />
        <Skeleton className={cn(BLOCK, 'h-16 rounded-card')} />
      </div>
      <Skeleton className={cn(BLOCK, 'mt-4 h-20 rounded-card')} />
    </div>
  );
}
