import { unitStatusLabel } from '@/lib/domain/status';
import { GuidancePill } from '@/lib/guide';
import type { UnitRow } from '@/lib/stdb';
import { ConnectionDot } from '@/lib/ui/ConnectionDot';
import { SimChip } from '@/lib/ui/SimChip';
import { Skeleton } from '@/lib/ui/skeleton';
import { cn } from '@/lib/utils';

/** Grows a small control's hit area to 48px tall without changing how it looks. */
const TALL_HIT = 'relative after:absolute after:inset-x-0 after:-inset-y-2.5';

export type CrewHeaderProps = {
  /** From the station row. Empty while it loads (shows a skeleton). */
  stationName: string;
  /** The unit this phone holds, or undefined before one is picked. */
  unit: UnitRow | undefined;
  /** Shows a small "Switch" button that goes back to the unit picker. */
  onSwitchUnit?: () => void;
  className?: string;
};

/** Sticky /crew header: station, unit callsign and status, sim chip, connection, guidance. */
export function CrewHeader({ stationName, unit, onSwitchUnit, className }: CrewHeaderProps) {
  return (
    <header
      className={cn(
        'sticky top-0 z-20 border-b border-border bg-background/90 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur',
        className
      )}
    >
      <div className="flex items-center justify-between gap-3">
        {stationName ? (
          <h1 className="min-w-0 truncate text-base font-semibold">{stationName}</h1>
        ) : (
          <Skeleton className="h-5 w-40" />
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          <SimChip />
          <ConnectionDot />
        </div>
      </div>

      <div className="mt-1 flex items-center justify-between gap-3">
        <p className="mono-tag min-w-0 truncate text-muted-foreground">
          {unit ? `${unit.callsign} · ${unitStatusLabel(unit.status)}` : 'No unit picked'}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <GuidancePill className={TALL_HIT} />
          {onSwitchUnit && (
            <button
              type="button"
              onClick={onSwitchUnit}
              aria-label="Switch unit"
              className={cn(
                TALL_HIT,
                'inline-flex h-7 items-center rounded-full px-2.5 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
              )}
            >
              Switch
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
