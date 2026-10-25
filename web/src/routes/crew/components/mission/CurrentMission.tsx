import type { FireCellRow, GridRow, OpsRequestRow, RoadClosureRow, UnitRow } from '@/lib/stdb';
import { cn } from '@/lib/utils';
import { MiniMap } from './MiniMap';
import { MissionActions } from './MissionActions';
import { MissionNeeds } from './MissionNeeds';
import { MissionTime } from './MissionTime';
import { NavigateLink } from './NavigateLink';
import type { MissionCan, MissionOutcome } from './types';

export type CurrentMissionProps = {
  /** The ops_request row for unit.currentRequest. */
  request: OpsRequestRow;
  unit: UnitRow;
  /** Sim now in seconds. Undefined until sim_clock arrives. */
  simNow: number | undefined;
  /** VITE_MAP_STYLE_URL, or undefined for a blank dark map. */
  styleUrl: string | undefined;
  grid: GridRow | undefined;
  fireCells: readonly FireCellRow[];
  closures: readonly RoadClosureRow[];
  /** The MissionAction in flight ('en_route' | 'on_scene' | 'rescued' | 'not_found' | 'aborted' | 'decline'), or null. */
  pending: string | null;
  /** Offline or otherwise unable to send: every action is disabled. */
  disabled: boolean;
  can: MissionCan;
  onEnRoute: () => void;
  onOnScene: () => void;
  onComplete: (outcome: MissionOutcome) => void;
  onDecline: (reason: string) => void;
  /** No live connection: the card is grayed and shows when it last updated. */
  stale?: boolean;
  /** Preformatted time of the last live update, e.g. "14:05". */
  lastUpdated?: string;
  /** Mapped error copy from the last failed action. */
  error?: string | null;
  className?: string;
};

/** The unit's current mission: minutes before the fire, who and what, where, and the next action. */
export function CurrentMission({
  request,
  unit,
  simNow,
  styleUrl,
  grid,
  fireCells,
  closures,
  pending,
  disabled,
  can,
  onEnRoute,
  onOnScene,
  onComplete,
  onDecline,
  stale = false,
  lastUpdated,
  error,
  className,
}: CurrentMissionProps) {
  return (
    <section
      aria-label="Current mission"
      data-status={unit.status}
      className={cn(
        'space-y-4 rounded-frame border border-border bg-surface p-4 transition-[opacity,filter] duration-200 ease-out',
        stale && 'opacity-60 grayscale',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="label-caps">Current mission</p>
        <span className="mono-tag text-muted-foreground">#{String(request.id)}</span>
      </div>

      <MissionTime level={request.level} fireEtaS={request.fireEtaS} simNow={simNow} />

      <MissionNeeds headcount={request.headcount} needs={request.needs} note={request.note} />

      <div className="space-y-2">
        <MiniMap
          styleUrl={styleUrl}
          grid={grid}
          fireCells={fireCells}
          closures={closures}
          unit={unit}
          request={request}
        />
        {request.locationPurged ? (
          <p className="text-sm text-muted-foreground">Location no longer available.</p>
        ) : (
          <NavigateLink lat={request.lat} lon={request.lon} />
        )}
      </div>

      <MissionActions
        status={unit.status}
        pending={pending}
        disabled={disabled}
        can={can}
        onEnRoute={onEnRoute}
        onOnScene={onOnScene}
        onComplete={onComplete}
        onDecline={onDecline}
      />

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {stale && (
        <p className="mono-tag text-muted-foreground">
          {lastUpdated ? `Last updated ${lastUpdated}` : 'Not updating right now'}
        </p>
      )}
    </section>
  );
}
