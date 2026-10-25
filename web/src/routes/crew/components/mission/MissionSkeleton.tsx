import { Skeleton } from '@/lib/ui/skeleton';
import { cn } from '@/lib/utils';

/** Loading stand-in shaped like CurrentMission. */
export function MissionSkeleton({ className }: { className?: string }) {
  return (
    <div role="status" className={cn('space-y-4 rounded-frame border border-border bg-surface p-4', className)}>
      <span className="sr-only">Loading mission</span>
      <Skeleton className="h-4 w-28" />
      <div className="space-y-2">
        <Skeleton className="h-3 w-36" />
        <Skeleton className="h-12 w-32" />
      </div>
      <div className="flex gap-1.5">
        <Skeleton className="h-6 w-20 rounded-full" />
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
      <Skeleton className="h-44 w-full rounded-card" />
      <Skeleton className="h-14 w-full rounded-card" />
    </div>
  );
}
