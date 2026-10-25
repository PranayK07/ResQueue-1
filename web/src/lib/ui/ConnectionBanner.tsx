import { LoaderCircle, TriangleAlert, WifiOff } from 'lucide-react';
import { useConnection } from '@/lib/stdb/hooks';
import { formatClock } from '@/lib/time/sim';
import { cn } from '@/lib/utils';

type BannerState = 'reconnecting' | 'offline' | 'error';
export type BannerCopy = Partial<Record<BannerState, string>>;

const DEFAULT_COPY: Record<BannerState, string> = {
  reconnecting: 'Reconnecting. What you see may be out of date.',
  offline: 'No connection. Nothing can be sent.',
  error: "Can't reach the server. Still trying.",
};

const ICON = { reconnecting: LoaderCircle, offline: WifiOff, error: TriangleAlert };

/** Shown while the connection isn't live. Each screen passes its own copy (spec states tables). */
export function ConnectionBanner({ copy, className }: { copy?: BannerCopy; className?: string }) {
  const c = useConnection();
  if (c.state === 'live' || c.state === 'connecting') return null;
  const Icon = ICON[c.state];
  return (
    <div
      role="status"
      aria-live="polite"
      data-connection={c.state}
      className={cn(
        'flex items-center gap-2 rounded-card border border-lvl-high/30 bg-lvl-high/10 px-3 py-2 text-sm text-foreground',
        className
      )}
    >
      <Icon className={cn('size-4 shrink-0 text-lvl-high', c.state === 'reconnecting' && 'motion-safe:animate-spin')} aria-hidden />
      <span className="min-w-0 flex-1">{copy?.[c.state] ?? DEFAULT_COPY[c.state]}</span>
      {c.lastLiveAt !== null && (
        <span className="mono-tag shrink-0 text-muted-foreground">Last update {formatClock(c.lastLiveAt, true)}</span>
      )}
    </div>
  );
}
