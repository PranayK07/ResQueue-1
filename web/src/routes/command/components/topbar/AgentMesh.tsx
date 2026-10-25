import { isAgentOnline } from '@/lib/domain/status';
import type { AgentRow } from '@/lib/stdb';
import { tsToMs } from '@/lib/time/sim';
import { cn } from '@/lib/utils';

export type AgentMeshProps = {
  agents: readonly AgentRow[];
  /** Wall-clock ms, for the online check and "Ns ago". */
  nowMs: number;
  className?: string;
};

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

const byRoleThenName = (a: AgentRow, b: AgentRow) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name);

/** Every agent row: online dot, name, role, status, detail and when it was last seen. */
export function AgentMesh({ agents, nowMs, className }: AgentMeshProps) {
  const rows = [...agents].sort(byRoleThenName);
  const online = rows.filter((a) => isAgentOnline(a.lastSeen, nowMs)).length;

  return (
    <div className={cn('flex flex-col', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="label-caps">Agent mesh</span>
        {rows.length > 0 && (
          <span className="mono-tag text-muted-foreground">{`${online}/${rows.length} online`}</span>
        )}
      </div>

      {rows.length === 0 ? (
        <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
          No agents have joined yet.
        </p>
      ) : (
        <ul className="max-h-80 divide-y divide-border overflow-y-auto">
          {rows.map((a) => {
            const isOnline = isAgentOnline(a.lastSeen, nowMs);
            const meta = [a.role, a.status].filter(Boolean).join(' · ');
            return (
              <li key={a.identity.toHexString()} data-online={isOnline} className="flex gap-2.5 px-3 py-2.5">
                <span
                  className={cn('mt-1.5 size-2 shrink-0 rounded-full', isOnline ? 'bg-ok' : 'bg-muted-foreground')}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-xs text-foreground">{a.name || a.role}</span>
                    <span className="mono-tag shrink-0 text-muted-foreground">
                      {`${isOnline ? 'Online' : 'Offline'} · ${ago(nowMs - tsToMs(a.lastSeen))}`}
                    </span>
                  </div>
                  {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
                  {a.detail && (
                    <p className="mt-0.5 line-clamp-2 text-xs break-words text-muted-foreground">{a.detail}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
