import { useMemo } from 'react';
import { useAnchor } from '@/lib/guide';
import type { EventLogRow } from '@/lib/stdb';
import { Panel } from '@/lib/ui/Panel';
import { cn } from '@/lib/utils';
import { EventLogItem } from './EventLogItem';
import { SideSkeleton } from './SideSkeleton';
import { StaleNote } from './StaleNote';
import { eventsNewestFirst } from './sort';

export type EventLogProps = {
  /** event_log rows, in any order. Sorted here by `at`, then `simS`, never by id. */
  events: readonly EventLogRow[];
  /** Focus a request (map and drawer). */
  onFocusRequest: (requestId: string) => void;
  /** Rows still arriving: skeleton. */
  loading?: boolean;
  /** Data is old: grayed, and the header stops saying "Live". */
  stale?: boolean;
  /** Wall-clock ms of the last live data, shown as "Last update" while stale. */
  lastUpdateMs?: number | null;
  /** By default it takes the rest of a flex-column rail (at least 12rem) and the list scrolls inside. */
  className?: string;
};

/** Every decision and change, newest first. */
export function EventLog({ events, onFocusRequest, loading, stale, lastUpdateMs, className }: EventLogProps) {
  const anchor = useAnchor('cmd.log');
  const sorted = useMemo(() => eventsNewestFirst(events), [events]);

  return (
    <Panel
      {...anchor}
      title="Event log"
      meta={loading ? undefined : stale ? 'Not live' : 'Live'}
      className={cn('flex min-h-48 flex-1 flex-col', className)}
    >
      {loading ? (
        <SideSkeleton label="Loading the event log" rows={4} />
      ) : sorted.length === 0 ? (
        <p role="status" className="px-4 pb-4 text-sm text-muted-foreground">
          No events yet.
        </p>
      ) : (
        <ol
          aria-label="Events, newest first"
          className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2', stale && 'opacity-60 grayscale')}
        >
          {sorted.map(e => (
            // content-visibility skips layout and paint for rows out of view (the log keeps up to 400).
            <li key={String(e.id)} className="[contain-intrinsic-size:auto_44px] [content-visibility:auto]">
              <EventLogItem event={e} onFocusRequest={onFocusRequest} />
            </li>
          ))}
        </ol>
      )}
      {stale && <StaleNote lastUpdateMs={lastUpdateMs} className="px-4 pb-3" />}
    </Panel>
  );
}
