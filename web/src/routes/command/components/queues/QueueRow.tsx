import { Fragment, memo, type ReactNode } from 'react';
import { isLockedStatus, requestStatusLabel } from '@/lib/domain/status';
import { useAnchor } from '@/lib/guide';
import type { OpsQueueRow, OpsRequestRow } from '@/lib/stdb';
import { LevelBadge } from '@/lib/ui/LevelBadge';
import { HeadcountNeeds } from './HeadcountNeeds';
import { slackMinutes } from './model';
import { PinMark } from './PinMark';
import { QUEUE_ROW_STYLE, rowButtonClass } from './styles';
import { useRevealSelected } from './useRevealSelected';

export type QueueRowProps = {
  entry: OpsQueueRow;
  /** The joined ops_request row. Undefined until it arrives; request fields are then left out. */
  request: OpsRequestRow | undefined;
  /** Callsign of entry.unitId. Undefined while waiting or when the unit isn't known. */
  unitCallsign: string | undefined;
  /** Name of the station the request is pinned to, when pinned and known. */
  pinnedStationName: string | undefined;
  /** Whole minutes until the crew arrives. Undefined until sim time is known. */
  etaMin: number | undefined;
  selected: boolean;
  onSelect: (requestId: string) => void;
  /** Puts the cmd.queue.reason guide anchor on this row's reason. */
  anchorReason?: boolean;
};

type MetaPart = { key: string; node: ReactNode };

/**
 * One request in a station's line. Memoized and given whole minutes rather than
 * sim time, so it re-renders only when something it shows changes.
 */
export const QueueRow = memo(function QueueRow({
  entry,
  request,
  unitCallsign,
  pinnedStationName,
  etaMin,
  selected,
  onSelect,
  anchorReason = false,
}: QueueRowProps) {
  const reasonAnchor = useAnchor('cmd.queue.reason');
  const ref = useRevealSelected<HTMLButtonElement>(selected);
  const id = String(entry.requestId);
  const slackS = request?.slackS;

  const meta: MetaPart[] = [];
  if (entry.unitId === 0) {
    meta.push({ key: 'unit', node: 'waiting' });
  } else if (unitCallsign !== undefined) {
    meta.push({
      key: 'unit',
      node: (
        <>
          <span className="font-mono text-foreground">{unitCallsign}</span>
          {request && isLockedStatus(request.status) && ` ${requestStatusLabel(request.status).toLowerCase()}`}
        </>
      ),
    });
  }
  if (etaMin !== undefined) meta.push({ key: 'eta', node: `ETA ${etaMin} min` });
  if (slackS !== undefined) meta.push({ key: 'slack', node: `slack ${slackMinutes(slackS)} min` });
  if (request && request.hopCount > 0) meta.push({ key: 'hops', node: `moved ${request.hopCount}×` });

  return (
    <li style={QUEUE_ROW_STYLE}>
      <button
        ref={ref}
        type="button"
        aria-current={selected || undefined}
        onClick={() => onSelect(id)}
        className={rowButtonClass(selected, 'flex items-start gap-2.5')}
      >
        <span className="mono-tag min-w-5 shrink-0 pt-px text-right text-muted-foreground">{entry.rank}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="mono-tag shrink-0 text-foreground">#{id}</span>
            {request && <HeadcountNeeds headcount={request.headcount} needs={request.needs} />}
            {request && request.pinnedStationId !== 0 && <PinMark stationName={pinnedStationName} />}
            {request && <LevelBadge level={request.level} className="ml-auto" />}
          </span>
          {meta.length > 0 && (
            <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground tabular-nums">
              {meta.map((part, i) => (
                <Fragment key={part.key}>
                  {i > 0 && <span aria-hidden>·</span>}
                  <span>{part.node}</span>
                </Fragment>
              ))}
            </span>
          )}
          {entry.reason !== '' && (
            <span {...(anchorReason ? reasonAnchor : {})} className="line-clamp-2 text-xs text-muted-foreground">
              {entry.reason}
            </span>
          )}
        </span>
      </button>
    </li>
  );
});
