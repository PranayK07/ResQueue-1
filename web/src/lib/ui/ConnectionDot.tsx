import type { ConnState } from '@/lib/stdb/connection';
import { useConnection } from '@/lib/stdb/hooks';
import { cn } from '@/lib/utils';

const DOT: Record<ConnState, { cls: string; label: string }> = {
  live: { cls: 'bg-ok', label: 'Live' },
  connecting: { cls: 'bg-muted-foreground', label: 'Connecting' },
  reconnecting: { cls: 'bg-lvl-high', label: 'Reconnecting' },
  offline: { cls: 'bg-muted-foreground', label: 'Offline' },
  error: { cls: 'bg-destructive', label: 'No connection' },
};

/** Connection state as a dot plus a word, for headers. */
export function ConnectionDot({ className }: { className?: string }) {
  const { state } = useConnection();
  const d = DOT[state];
  return (
    <span
      data-connection={state}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border px-2 text-xs text-foreground',
        className
      )}
    >
      <span className={cn('size-1.5 rounded-full', d.cls)} aria-hidden />
      {d.label}
    </span>
  );
}
