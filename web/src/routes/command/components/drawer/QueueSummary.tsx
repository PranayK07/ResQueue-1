import type { OpsQueueRow, StationRow, UnitRow } from '@/lib/stdb';
import { DrawerSection } from './DrawerSection';
import { stationName } from './stationName';

export type QueueSummaryProps = {
  /** The request's ops_queue entry. Undefined while it is still being assessed. */
  queue: Pick<OpsQueueRow, 'stationId' | 'rank' | 'unitId' | 'reason'> | undefined;
  stations: readonly StationRow[];
  units: readonly UnitRow[];
};

/** Which station's line the request is in, its rank, the unit and the operator reason. */
export function QueueSummary({ queue, stations, units }: QueueSummaryProps) {
  if (!queue) {
    return (
      <DrawerSection title="Station line">
        <p className="text-sm text-muted-foreground">Not in a line yet (assessing).</p>
      </DrawerSection>
    );
  }

  const callsign = units.find(u => u.id === queue.unitId)?.callsign ?? 'Unknown unit';
  const reason = queue.reason.trim();

  return (
    <DrawerSection title="Station line">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Station</dt>
        <dd className="font-medium">{stationName(stations, queue.stationId)}</dd>

        <dt className="text-muted-foreground">Rank</dt>
        <dd className="tabular-nums">{queue.rank}</dd>

        {queue.unitId !== 0 && (
          <>
            <dt className="text-muted-foreground">Unit</dt>
            <dd className="font-mono">{callsign}</dd>
          </>
        )}

        <dt className="text-muted-foreground">Reason</dt>
        <dd className={reason === '' ? 'text-muted-foreground' : 'leading-relaxed'}>
          {reason === '' ? 'No reason recorded' : reason}
        </dd>
      </dl>
    </DrawerSection>
  );
}
