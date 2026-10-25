import { LoaderCircle, TriangleAlert, Undo2 } from 'lucide-react';
import { Button } from '@/lib/ui/button';
import { cn } from '@/lib/utils';

export type ReturningCardProps = {
  /** Back in service: unit_available with the station's lat/lon. */
  onAvailable: () => void;
  /** The call is in flight. The spinner stays until the unit row changes; no optimistic update. */
  pending: boolean;
  /** Actions unavailable, e.g. offline. */
  disabled: boolean;
  /** unit_available is wired (its FEATURES flag is on). The button only renders when true. */
  canAvailable: boolean;
  /** Mapped error copy from a failed call, shown inline. */
  error?: string | null;
  className?: string;
};

/** Shown while the unit is returning to its station. */
export function ReturningCard({ onAvailable, pending, disabled, canAvailable, error, className }: ReturningCardProps) {
  return (
    <section className={cn('rounded-frame border border-border bg-surface p-5', className)}>
      <div className="flex items-start gap-3">
        <Undo2 className="mt-1 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="text-lg leading-snug font-semibold">Heading back to the station.</h2>
      </div>

      {canAvailable && (
        <Button
          className="mt-5 h-auto min-h-14 w-full rounded-card text-base font-semibold"
          disabled={disabled || pending}
          aria-busy={pending}
          onClick={onAvailable}
        >
          {pending && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}
          Back in service
        </Button>
      )}

      {error && (
        <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}
    </section>
  );
}
