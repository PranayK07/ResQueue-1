import { memo } from 'react';
import type { OpsRequestRow } from '@/lib/stdb';
import { LevelBadge } from '@/lib/ui/LevelBadge';
import { HeadcountNeeds } from './HeadcountNeeds';
import { PinMark } from './PinMark';
import { ASSESSING_ROW_STYLE, rowButtonClass } from './styles';
import { useRevealSelected } from './useRevealSelected';

export type AssessingRowProps = {
  request: OpsRequestRow;
  /** Name of the station the request is pinned to, when pinned and known. */
  pinnedStationName: string | undefined;
  selected: boolean;
  onSelect: (requestId: string) => void;
};

/** An active request that isn't in any station's line yet. */
export const AssessingRow = memo(function AssessingRow({ request, pinnedStationName, selected, onSelect }: AssessingRowProps) {
  const ref = useRevealSelected<HTMLButtonElement>(selected);
  const id = String(request.id);
  return (
    <li style={ASSESSING_ROW_STYLE}>
      <button
        ref={ref}
        type="button"
        aria-current={selected || undefined}
        onClick={() => onSelect(id)}
        className={rowButtonClass(selected, 'flex flex-wrap items-center gap-x-2 gap-y-1')}
      >
        <span className="mono-tag shrink-0 text-foreground">#{id}</span>
        <HeadcountNeeds headcount={request.headcount} needs={request.needs} />
        {request.pinnedStationId !== 0 && <PinMark stationName={pinnedStationName} />}
        <LevelBadge level={request.level} className="ml-auto" />
      </button>
    </li>
  );
});
