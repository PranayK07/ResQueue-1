import { Skeleton } from '@/lib/ui/skeleton';
import { cn } from '@/lib/utils';

export type SideSkeletonProps = {
  /** Read to screen readers while loading, e.g. "Loading the event log". */
  label: string;
  rows?: number;
  className?: string;
};

/** Placeholder bars while a side panel waits for its first rows. */
export function SideSkeleton({ label, rows = 3, className }: SideSkeletonProps) {
  return (
    <div role="status" className={cn('flex flex-col gap-2 px-4 pb-4', className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full rounded-card" />
      ))}
    </div>
  );
}
