import { isAgentOnline } from '@/lib/domain/status';
import type { AgentRow } from '@/lib/stdb';
import { Button } from '@/lib/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/lib/ui/popover';
import { cn } from '@/lib/utils';
import { AgentMesh } from './AgentMesh';

export type AgentsOnlineButtonProps = {
  agents: readonly AgentRow[];
  nowMs: number;
  /** Connection isn't live: the count may be out of date, so it's grayed. */
  stale: boolean;
};

/** "N/M agents online". Opens the AgentMesh popover. Read-only, so it stays usable offline. */
export function AgentsOnlineButton({ agents, nowMs, stale }: AgentsOnlineButtonProps) {
  const total = agents.length;
  const online = agents.filter((a) => isAgentOnline(a.lastSeen, nowMs)).length;
  const dot = total === 0 ? 'bg-muted-foreground' : online === total ? 'bg-ok' : 'bg-lvl-high';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('shrink-0 tabular-nums', stale ? 'text-muted-foreground' : 'text-foreground')}
        >
          <span className={cn('size-1.5 rounded-full', dot)} aria-hidden />
          {`${online}/${total} agents online`}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 gap-0 overflow-hidden p-0">
        <AgentMesh agents={agents} nowMs={nowMs} />
      </PopoverContent>
    </Popover>
  );
}
