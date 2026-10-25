import { ChevronRight } from 'lucide-react';
import { unitStatusLabel } from '@/lib/domain/status';
import type { UnitRow } from '@/lib/stdb';
import { Button } from '@/lib/ui/button';
import { cn } from '@/lib/utils';

export type UnitOptionProps = {
  unit: UnitRow;
  onPick: (unitId: number) => void;
};

const seats = (n: number) => `${n} ${n === 1 ? 'seat' : 'seats'}`;

/** One unit as a large tap target: callsign, kind and seats, and its status. */
export function UnitOption({ unit, onPick }: UnitOptionProps) {
  const available = unit.status === 'available';

  return (
    <Button
      type="button"
      variant="secondary"
      onClick={() => onPick(unit.id)}
      className="h-auto min-h-16 w-full justify-start gap-3 rounded-card border-border px-4 py-3 text-left whitespace-normal"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-mono text-xl leading-7 font-semibold tabular-nums text-foreground">
          {unit.callsign}
        </span>
        <span className="text-sm font-normal text-muted-foreground">
          {unit.kind.replace(/_/g, ' ')}
          <span aria-hidden> · </span>
          <span className="tabular-nums">{seats(unit.capacity)}</span>
        </span>
      </span>
      <span className={cn('flex shrink-0 items-center gap-1.5 text-sm', available ? 'text-ok' : 'text-muted-foreground')}>
        <span aria-hidden className={cn('size-2 rounded-full', available ? 'bg-ok' : 'bg-muted-foreground/60')} />
        {unitStatusLabel(unit.status)}
      </span>
      <ChevronRight className="size-5 text-muted-foreground" aria-hidden />
    </Button>
  );
}
