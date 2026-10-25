import { LogOut, RefreshCw } from 'lucide-react';
import { APP_NAME } from '@/lib/app';
import { GuidancePill, useAnchor } from '@/lib/guide';
import type { AgentRow } from '@/lib/stdb';
import { formatT } from '@/lib/time/sim';
import { Button } from '@/lib/ui/button';
import { ConnectionDot } from '@/lib/ui/ConnectionDot';
import { SimChip } from '@/lib/ui/SimChip';
import { Skeleton } from '@/lib/ui/skeleton';
import { cn } from '@/lib/utils';
import { AgentsOnlineButton } from './AgentsOnlineButton';
import { SimControls } from './SimControls';

export type TopBarProps = {
  /** sim_clock.scenario. Pass "" while sim_clock is still loading (renders a skeleton). */
  scenario: string;
  /** Sim seconds from useSimNow(), undefined until sim_clock arrives. */
  simNow: number | undefined;
  running: boolean;
  speed: number | undefined;
  /** Shows Run/Pause and the speed picker (set_sim). */
  canControlSim: boolean;
  onSetSim: (running: boolean, speed: number) => void;
  simPending: boolean;
  agents: readonly AgentRow[];
  /** Wall-clock ms for the agent online check. */
  nowMs: number;
  /** forecast_meta.weatherVersion < world_version.weather. */
  forecastUpdating: boolean;
  /** Connection isn't live: controls are off and live values are grayed. */
  disabled: boolean;
  operatorName?: string;
  onSignOut?: () => void;
  className?: string;
};

/** The /command header: scenario, sim clock and controls, connection, agents, guidance, operator. */
export function TopBar({
  scenario,
  simNow,
  running,
  speed,
  canControlSim,
  onSetSim,
  simPending,
  agents,
  nowMs,
  forecastUpdating,
  disabled,
  operatorName,
  onSignOut,
  className,
}: TopBarProps) {
  const clockAnchor = useAnchor('cmd.clock');

  return (
    <header
      className={cn('flex h-14 shrink-0 items-center gap-4 border-b border-border bg-background px-4', className)}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="size-6 shrink-0 rounded-md bg-linear-to-br from-lvl-high to-lvl-critical" aria-hidden />
          <span className="truncate text-sm font-semibold text-foreground">{APP_NAME}</span>
        </div>

        {scenario ? (
          <span
            title="Scenario"
            className="mono-tag inline-flex h-6 max-w-44 shrink-0 items-center rounded-md border border-border px-2 text-muted-foreground"
          >
            <span className="sr-only">Scenario </span>
            <span className="truncate">{scenario}</span>
          </span>
        ) : (
          <Skeleton className="h-6 w-24 shrink-0 motion-reduce:animate-none" aria-hidden />
        )}

        <span
          {...clockAnchor}
          title="Simulated time"
          className={cn(
            'shrink-0 font-mono text-sm tabular-nums',
            disabled || simNow === undefined ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {simNow === undefined ? 'T+--:--' : formatT(simNow)}
        </span>

        <SimChip />

        {canControlSim && (
          <SimControls running={running} speed={speed} onSetSim={onSetSim} pending={simPending} disabled={disabled} />
        )}

        <ConnectionDot />

        <AgentsOnlineButton agents={agents} nowMs={nowMs} stale={disabled} />

        {forecastUpdating && (
          <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border px-2 text-xs text-muted-foreground">
            <RefreshCw className="size-3 motion-safe:animate-spin" aria-hidden />
            Forecast updating
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <GuidancePill />
        {operatorName && (
          <span title={operatorName} className="max-w-40 truncate text-sm text-muted-foreground">
            {operatorName}
          </span>
        )}
        {onSignOut && (
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            <LogOut aria-hidden />
            Sign out
          </Button>
        )}
      </div>
    </header>
  );
}
