import { Inbox } from 'lucide-react';
import { useId, useMemo } from 'react';
import { useAnchor } from '@/lib/guide';
import type { OpsQueueRow, OpsRequestRow, StationRow, UnitRow } from '@/lib/stdb';
import { formatClock } from '@/lib/time/sim';
import { EmptyState } from '@/lib/ui/EmptyState';
import { ScrollArea } from '@/lib/ui/scroll-area';
import { cn } from '@/lib/utils';
import { AssessingGroup } from './AssessingGroup';
import { buildQueueModel } from './model';
import { QueuesSkeleton } from './QueuesSkeleton';
import { StationCard } from './StationCard';

// Radix puts `display: table` on the viewport's content div, which stops `truncate`
// from working inside. Vertical-only scrolling doesn't need it.
const VIEWPORT_BLOCK = '[&_[data-slot=scroll-area-viewport]>div]:block!';

export type StationQueuesProps = {
  stations: readonly StationRow[];
  units: readonly UnitRow[];
  queue: readonly OpsQueueRow[];
  requests: readonly OpsRequestRow[];
  /** Sim now in seconds (useSimNow()). Undefined until sim_clock arrives; ETAs are then left out. */
  simNow: number | undefined;
  /** String(requestId) of the open request, or null. */
  selectedId: string | null;
  onSelect: (requestId: string) => void;
  loading: boolean;
  /** No live connection for a while: data is grayed. */
  stale: boolean;
  /** Wall-clock ms of the last live moment (useConnection().lastLiveAt), shown while stale. */
  lastLiveAt?: number | null;
  className?: string;
};

/** Every station's line, sorted by rank, plus the requests still being assessed. */
export function StationQueues({
  stations,
  units,
  queue,
  requests,
  simNow,
  selectedId,
  onSelect,
  loading,
  stale,
  lastLiveAt = null,
  className,
}: StationQueuesProps) {
  const anchor = useAnchor('cmd.queue');
  const headingId = useId();
  const model = useMemo(() => buildQueueModel(stations, units, queue, requests), [stations, units, queue, requests]);

  let body;
  if (loading) {
    body = <QueuesSkeleton />;
  } else if (requests.length === 0) {
    body = (
      <EmptyState
        icon={Inbox}
        title="No help requests yet."
        body="They appear here the moment a resident taps the button."
      />
    );
  } else {
    body = (
      <>
        {model.lines.length === 0 && <p className="px-1 text-xs text-muted-foreground">No stations loaded.</p>}
        {model.lines.map((line, i) => (
          <StationCard
            key={line.station.id}
            line={line}
            callsignByUnit={model.callsignByUnit}
            stationNameById={model.stationNameById}
            simNow={simNow}
            selectedId={selectedId}
            onSelect={onSelect}
            anchorFirstReason={i === model.firstBusyLine}
          />
        ))}
        <AssessingGroup
          className="mt-1"
          requests={model.assessing}
          stationNameById={model.stationNameById}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      </>
    );
  }

  return (
    <section {...anchor} aria-labelledby={headingId} className={cn('flex h-full min-h-0 flex-col', className)}>
      <header className="flex items-center gap-3 px-1 pb-2">
        <h2 id={headingId} className="label-caps">
          Station lines
        </h2>
        {!loading && (
          <span className={cn('label-caps ml-auto tabular-nums', stale && 'opacity-60')}>{model.activeCount} active</span>
        )}
      </header>
      {stale && lastLiveAt !== null && (
        <p className="mono-tag px-1 pb-2 text-muted-foreground">Last update {formatClock(lastLiveAt, true)}</p>
      )}
      <ScrollArea className={cn('min-h-0 flex-1', VIEWPORT_BLOCK)}>
        <div className={cn('flex flex-col gap-3 pb-2', stale && 'opacity-60 grayscale')}>{body}</div>
      </ScrollArea>
    </section>
  );
}
