import { etaMinutes, type StationLine } from './model';
import { QueueRow } from './QueueRow';

export type StationCardProps = {
  line: StationLine;
  callsignByUnit: ReadonlyMap<number, string>;
  stationNameById: ReadonlyMap<number, string>;
  /** Sim now in seconds. Undefined until sim_clock arrives (ETAs are then left out). */
  simNow: number | undefined;
  selectedId: string | null;
  onSelect: (requestId: string) => void;
  /** Puts the cmd.queue.reason guide anchor on the first row's reason. */
  anchorFirstReason: boolean;
};

/** One station: its name and unit callsigns, then its line by rank. */
export function StationCard({
  line,
  callsignByUnit,
  stationNameById,
  simNow,
  selectedId,
  onSelect,
  anchorFirstReason,
}: StationCardProps) {
  const { station, callsigns, rows } = line;
  return (
    <section className="rounded-card border border-border bg-surface-2">
      <header className="flex items-center gap-3 px-3 pt-2.5 pb-1.5">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{station.name}</h3>
        {callsigns.length > 0 && (
          <span className="mono-tag max-w-[50%] shrink-0 truncate text-muted-foreground">{callsigns.join(' · ')}</span>
        )}
      </header>
      {rows.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground">No one in line.</p>
      ) : (
        <ol className="flex flex-col gap-0.5 px-1 pb-1">
          {rows.map(({ entry, request }, i) => (
            <QueueRow
              key={String(entry.requestId)}
              entry={entry}
              request={request}
              unitCallsign={entry.unitId === 0 ? undefined : callsignByUnit.get(entry.unitId)}
              pinnedStationName={
                request && request.pinnedStationId !== 0 ? stationNameById.get(request.pinnedStationId) : undefined
              }
              etaMin={simNow === undefined ? undefined : etaMinutes(entry.etaS, simNow)}
              selected={selectedId === String(entry.requestId)}
              onSelect={onSelect}
              anchorReason={anchorFirstReason && i === 0}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
