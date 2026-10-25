import { LEVEL_META, toLevel } from '@/lib/domain/levels';
import { useAnchor } from '@/lib/guide';
import { LevelBadge } from '@/lib/ui/LevelBadge';
import { cn } from '@/lib/utils';
import { minsFromNow } from '@/lib/time/sim';

export type MissionTimeProps = {
  /** request.level, from the danger agent. */
  level: string;
  /** request.fireEtaS, an absolute sim second. Undefined until assessed. */
  fireEtaS: number | undefined;
  /** Sim now in seconds. Undefined until sim_clock arrives. */
  simNow: number | undefined;
  className?: string;
};

/** "N min" before the fire reaches this request, with its level as label and icon. */
export function MissionTime({ level, fireEtaS, simNow, className }: MissionTimeProps) {
  const anchor = useAnchor('crew.mission.time');
  const mins =
    fireEtaS !== undefined && simNow !== undefined ? Math.max(0, Math.round(minsFromNow(fireEtaS, simNow))) : undefined;

  return (
    <div {...anchor} className={cn('flex items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <p className="label-caps">Before the fire arrives</p>
        {mins !== undefined ? (
          <p
            className="mt-1 text-5xl leading-none font-semibold tracking-tight tabular-nums"
            style={{ color: LEVEL_META[toLevel(level)].color }}
          >
            {mins} min
          </p>
        ) : (
          <p className="mt-2 text-2xl font-semibold text-muted-foreground">Not assessed yet</p>
        )}
      </div>
      <LevelBadge level={level} size="md" className="mb-1" />
    </div>
  );
}
