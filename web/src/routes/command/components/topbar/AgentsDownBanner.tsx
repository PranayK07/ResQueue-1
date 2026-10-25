import { BotOff } from 'lucide-react';
import { cn } from '@/lib/utils';

type WatchedRole = 'danger' | 'delegation';

export type AgentsDownBannerProps = {
  /** Agent roles that are missing or stale. Renders nothing when empty. */
  roles: readonly WatchedRole[];
  className?: string;
};

const ORDER: readonly WatchedRole[] = ['delegation', 'danger'];

const COPY: Record<WatchedRole, string> = {
  delegation: "Delegation agent offline: queues aren't updating.",
  danger: "Danger agent offline: levels aren't updating.",
};

/** Warns that queues or levels are frozen because an agent stopped heartbeating. */
export function AgentsDownBanner({ roles, className }: AgentsDownBannerProps) {
  const down = ORDER.filter((r) => roles.includes(r));
  if (down.length === 0) return null;

  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-card border border-lvl-high/30 bg-lvl-high/10 px-3 py-2 text-sm text-foreground',
        className
      )}
    >
      <BotOff className="mt-0.5 size-4 shrink-0 text-lvl-high" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        {down.map((r) => (
          <p key={r} data-role={r}>
            {COPY[r]}
          </p>
        ))}
      </div>
    </div>
  );
}
