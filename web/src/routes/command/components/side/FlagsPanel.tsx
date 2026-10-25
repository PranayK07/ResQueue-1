import { useMemo } from 'react';
import { useAnchor } from '@/lib/guide';
import type { OpsFlagRow } from '@/lib/stdb';
import { Panel } from '@/lib/ui/Panel';
import { cn } from '@/lib/utils';
import { FlagCard } from './FlagCard';
import { SideSkeleton } from './SideSkeleton';
import { StaleNote } from './StaleNote';
import { openFlagsNewestFirst } from './sort';

export type FlagsPanelProps = {
  /** ops_flag rows. Resolved ones are filtered out here. */
  flags: readonly OpsFlagRow[];
  /** resolve_flag({ flagId, resolution }). */
  onResolve: (flagId: string, resolution: string) => void;
  /** Open that request (RequestDrawer). */
  onSelectRequest: (requestId: string) => void;
  /** Flag whose resolve call is in flight. While set, every card's controls are off. */
  pendingId: string | null;
  /** Every control off (not live). */
  disabled: boolean;
  /** Rows still arriving: skeleton. */
  loading?: boolean;
  /** Data is old: grayed. */
  stale?: boolean;
  /** Mapped error copy from a failed resolve, shown on that flag's card. */
  error?: { flagId: string; message: string } | null;
  /** Wall-clock ms of the last live data, shown as "Last update" while stale. */
  lastUpdateMs?: number | null;
  className?: string;
};

/** "Needs a decision": unresolved flags, newest first. */
export function FlagsPanel({
  flags,
  onResolve,
  onSelectRequest,
  pendingId,
  disabled,
  loading,
  stale,
  error,
  lastUpdateMs,
  className,
}: FlagsPanelProps) {
  const anchor = useAnchor('cmd.flags');
  const open = useMemo(() => openFlagsNewestFirst(flags), [flags]);

  return (
    <Panel
      {...anchor}
      title="Needs a decision"
      meta={loading ? undefined : <span className="tabular-nums">{open.length}</span>}
      aria-busy={pendingId !== null || undefined}
      className={cn('flex flex-col', className)}
    >
      {loading ? (
        <SideSkeleton label="Loading decisions" rows={2} />
      ) : open.length === 0 ? (
        <p role="status" className="px-4 pb-4 text-sm text-muted-foreground">
          No open decisions.
        </p>
      ) : (
        <ul
          aria-label="Open decisions, newest first"
          className={cn('flex max-h-96 flex-col gap-2 overflow-y-auto px-3 pb-3', stale && 'opacity-60 grayscale')}
        >
          {open.map(f => {
            const id = String(f.id);
            return (
              <li key={id}>
                <FlagCard
                  flag={f}
                  onResolve={onResolve}
                  onSelectRequest={onSelectRequest}
                  pending={pendingId === id}
                  disabled={disabled || pendingId !== null}
                  error={error && error.flagId === id ? error.message : null}
                />
              </li>
            );
          })}
        </ul>
      )}
      {stale && <StaleNote lastUpdateMs={lastUpdateMs} className="px-4 pb-3" />}
    </Panel>
  );
}
