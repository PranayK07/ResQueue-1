import { Pin } from 'lucide-react';
import { cn } from '@/lib/utils';

export type PinMarkProps = {
  /** Name of the station the request is pinned to, when known. */
  stationName: string | undefined;
  className?: string;
};

/** Marks a request the commander pinned to a station. */
export function PinMark({ stationName, className }: PinMarkProps) {
  const label = stationName ? `Pinned to ${stationName}` : 'Pinned to a station';
  return (
    <span role="img" aria-label={label} title={label} className={cn('inline-flex shrink-0 text-foreground', className)}>
      <Pin className="size-3.5" aria-hidden />
    </span>
  );
}
