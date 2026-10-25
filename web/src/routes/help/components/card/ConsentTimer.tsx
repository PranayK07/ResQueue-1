import { LoaderCircle, MapPin, TriangleAlert } from 'lucide-react';
import { useAnchor } from '@/lib/guide';
import { Button } from '@/lib/ui/button';
import { cn } from '@/lib/utils';

export type ConsentTimerProps = {
  /** consentExpiresAt in wall-clock ms. */
  expiresAtMs: number;
  /** Wall-clock now in ms (the parent ticks it). */
  nowMs: number;
  /** Show "Extend" (extend_consent is available and the request is active). */
  canExtend: boolean;
  onExtend: () => void;
  /** extend_consent is in flight. */
  extending: boolean;
  /** Mapped error copy from a failed extend, shown inline. */
  error?: string | null;
  className?: string;
};

/** "Sharing location for N more min" with an optional Extend action. */
export function ConsentTimer({
  expiresAtMs,
  nowMs,
  canExtend,
  onExtend,
  extending,
  error,
  className,
}: ConsentTimerProps) {
  const anchor = useAnchor('help.card.consent');
  const msLeft = expiresAtMs - nowMs;
  const minsLeft = Math.max(0, Math.ceil(msLeft / 60000));
  const text =
    msLeft < 60000 ? 'Sharing location for less than a minute' : `Sharing location for ${minsLeft} more min`;

  return (
    <div {...anchor} className={cn('rounded-card border border-border bg-surface', className)}>
      <div className="flex min-h-14 items-center gap-3 py-1 pr-1 pl-4">
        <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 text-sm tabular-nums">{text}</p>
        {canExtend && (
          <Button
            variant="ghost"
            className="h-auto min-h-12 min-w-12 shrink-0 px-3 text-sm"
            disabled={extending}
            aria-busy={extending}
            onClick={onExtend}
          >
            {extending && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}
            Extend
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="flex items-start gap-2 px-4 pb-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
