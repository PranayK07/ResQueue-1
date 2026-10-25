import { formatClock } from '@/lib/time/sim';
import { cn } from '@/lib/utils';

export type StaleNoteProps = {
  /** Wall-clock ms of the last live data. Nothing renders without it. */
  lastUpdateMs?: number | null;
  className?: string;
};

/** "Last update hh:mm:ss" under grayed, stale data. */
export function StaleNote({ lastUpdateMs, className }: StaleNoteProps) {
  if (lastUpdateMs == null) return null;
  return (
    <p className={cn('mono-tag text-muted-foreground', className)}>Last update {formatClock(lastUpdateMs, true)}</p>
  );
}
