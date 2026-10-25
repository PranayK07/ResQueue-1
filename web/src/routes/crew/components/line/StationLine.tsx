import { useId, useMemo } from 'react';
import { TriangleAlert, Users } from 'lucide-react';
import { useAnchor } from '@/lib/guide';
import { EmptyState } from '@/lib/ui/EmptyState';
import { cn } from '@/lib/utils';
import { LineRow } from './LineRow';
import { LineSkeleton } from './LineSkeleton';
import type { StationLineRow } from './types';

export type StationLineProps = {
  /** From the `station` row. Never hardcoded. */
  stationName: string;
  /** The rest of this station's ops_queue (current mission excluded). Rendered in rank order. */
  rows: readonly StationLineRow[];
  loading: boolean;
  /** No live connection: the line is grayed and says when it last updated. */
  stale: boolean;
  /** Preformatted time of the last live update, e.g. "14:05". Shown only while stale. */
  lastUpdated?: string;
  /** Mapped error copy when the line can't load. An error is never shown as an empty line. */
  error?: string | null;
  className?: string;
};

/** Who's next at this station, read-only. Responders can't reorder it; no reducer allows that. */
export function StationLine({ stationName, rows, loading, stale, lastUpdated, error, className }: StationLineProps) {
  const anchor = useAnchor('crew.line');
  const headingId = useId();
  const sorted = useMemo(() => [...rows].sort((a, b) => a.rank - b.rank), [rows]);
  const name = stationName.trim() || 'this station';
  const hasRows = !loading && sorted.length > 0;

  const errorLine = error ? (
    <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{error}</span>
    </p>
  ) : null;

  return (
    <section
      {...anchor}
      aria-labelledby={headingId}
      className={cn('transition-[opacity,filter] duration-200 ease-out', stale && 'opacity-60 grayscale', className)}
    >
      <header className="flex items-center justify-between gap-3 px-1 pb-2">
        <h2 id={headingId} className="label-caps">
          Next in line
        </h2>
        {!loading && !error && <span className="label-caps tabular-nums">{sorted.length} waiting</span>}
      </header>

      <div className="overflow-hidden rounded-card border border-border bg-surface-2">
        {loading ? (
          <LineSkeleton />
        ) : hasRows ? (
          <ul className="divide-y divide-border">
            {sorted.map(row => (
              <LineRow key={row.requestId} row={row} />
            ))}
          </ul>
        ) : errorLine ? (
          <div className="p-4">{errorLine}</div>
        ) : (
          <EmptyState icon={Users} title={`No one waiting at ${name}.`} className="py-6" />
        )}
      </div>

      {hasRows && errorLine && <div className="mt-2 px-1">{errorLine}</div>}

      {stale && (
        <p className="mono-tag mt-2 px-1 text-muted-foreground">
          {lastUpdated ? `Last updated ${lastUpdated}` : 'Not updating right now'}
        </p>
      )}
    </section>
  );
}
