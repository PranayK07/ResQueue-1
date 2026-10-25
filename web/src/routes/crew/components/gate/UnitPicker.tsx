import { LogOut, Truck } from 'lucide-react';
import type { UnitRow } from '@/lib/stdb';
import { Button } from '@/lib/ui/button';
import { EmptyState } from '@/lib/ui/EmptyState';
import { GateFrame } from './GateFrame';
import { UnitOption } from './UnitOption';

export type UnitPickerProps = {
  /** From the station row, never hardcoded. */
  stationName: string;
  /** This station's unit rows. */
  units: readonly UnitRow[];
  onPick: (unitId: number) => void;
  onSignOut: () => void;
  className?: string;
};

const byCallsign = (a: UnitRow, b: UnitRow) => a.callsign.localeCompare(b.callsign, undefined, { numeric: true });

/** /crew after sign-in: pick the unit this person is on. The choice is kept locally only. */
export function UnitPicker({ stationName, units, onPick, onSignOut, className }: UnitPickerProps) {
  const sorted = [...units].sort(byCallsign);

  return (
    <GateFrame title="Which unit are you on?" subtitle={stationName} className={className}>
      {sorted.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No units at this station."
          className="rounded-card border border-dashed border-border bg-surface-2 py-6"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {sorted.map(u => (
            <li key={u.id}>
              <UnitOption unit={u} onPick={onPick} />
            </li>
          ))}
        </ul>
      )}

      <Button
        type="button"
        variant="ghost"
        onClick={onSignOut}
        className="h-12 w-full text-sm text-muted-foreground hover:text-foreground"
      >
        <LogOut aria-hidden />
        Sign out
      </Button>
    </GateFrame>
  );
}
