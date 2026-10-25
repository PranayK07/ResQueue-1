import type { OpsRequestRow } from '@/lib/stdb';
import { cn } from '@/lib/utils';
import { AssessingRow } from './AssessingRow';

export type AssessingGroupProps = {
  /** Active requests with no queue entry yet, newest first (buildQueueModel().assessing). */
  requests: readonly OpsRequestRow[];
  stationNameById: ReadonlyMap<number, string>;
  selectedId: string | null;
  onSelect: (requestId: string) => void;
  className?: string;
};

/** Requests the agents are still assessing: active, but in no station's line. Renders nothing when empty. */
export function AssessingGroup({ requests, stationNameById, selectedId, onSelect, className }: AssessingGroupProps) {
  if (requests.length === 0) return null;
  return (
    <section className={cn('flex flex-col gap-1.5', className)}>
      <header className="flex items-center gap-3 px-1">
        <h3 className="label-caps">Assessing</h3>
        <span className="label-caps ml-auto tabular-nums">{requests.length}</span>
      </header>
      <ul className="flex flex-col gap-0.5 rounded-card border border-border bg-surface-2 p-1">
        {requests.map(r => (
          <AssessingRow
            key={String(r.id)}
            request={r}
            pinnedStationName={r.pinnedStationId !== 0 ? stationNameById.get(r.pinnedStationId) : undefined}
            selected={selectedId === String(r.id)}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </section>
  );
}
