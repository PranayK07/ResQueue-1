import { useAnchor } from '@/lib/guide';
import { cn } from '@/lib/utils';
import { ActionButton } from './ActionButton';
import { DeclineDialog } from './DeclineDialog';
import type { MissionAction, MissionCan, MissionOutcome } from './types';

export type MissionActionsProps = {
  /** unit.status. Picks which actions show (spec 4.3 table). */
  status: string;
  /** The MissionAction in flight, or null. Its button spins; every button is disabled meanwhile. */
  pending: string | null;
  /** Offline, stale or otherwise unable to send. */
  disabled: boolean;
  can: MissionCan;
  onEnRoute: () => void;
  onOnScene: () => void;
  onComplete: (outcome: MissionOutcome) => void;
  onDecline: (reason: string) => void;
  className?: string;
};

/** Mission buttons by unit status. No optimistic UI. */
export function MissionActions({
  status,
  pending,
  disabled,
  can,
  onEnRoute,
  onOnScene,
  onComplete,
  onDecline,
  className,
}: MissionActionsProps) {
  const anchor = useAnchor('crew.mission.actions');
  const locked = disabled || pending !== null;
  const busy = (key: MissionAction) => pending === key;

  const showAssigned = status === 'assigned' && (can.enRoute || can.decline);
  const showEnRoute = status === 'en_route' && can.onScene;
  const showOnScene = status === 'on_scene' && can.complete;

  return (
    <div {...anchor} data-guide-clear className={cn('grid gap-2', className)}>
      {showAssigned && (
        <>
          {can.enRoute && (
            <ActionButton primary label="En route" busy={busy('en_route')} disabled={locked} onClick={onEnRoute} />
          )}
          {can.decline && <DeclineDialog busy={busy('decline')} disabled={locked} onDecline={onDecline} />}
        </>
      )}

      {showEnRoute && (
        <ActionButton primary label="On scene" busy={busy('on_scene')} disabled={locked} onClick={onOnScene} />
      )}

      {showOnScene && (
        <>
          <ActionButton
            primary
            label="Rescued"
            busy={busy('rescued')}
            disabled={locked}
            onClick={() => onComplete('rescued')}
          />
          <div className="grid grid-cols-2 gap-2">
            <ActionButton
              label="Not found"
              busy={busy('not_found')}
              disabled={locked}
              onClick={() => onComplete('not_found')}
            />
            <ActionButton
              label="Abort, back to line"
              busy={busy('aborted')}
              disabled={locked}
              onClick={() => onComplete('aborted')}
            />
          </div>
        </>
      )}

      {!showAssigned && !showEnRoute && !showOnScene && (
        <p className="text-sm text-muted-foreground">No action available right now.</p>
      )}
    </div>
  );
}
