import { Construction, LoaderCircle, Route } from 'lucide-react';
import type { RoadClosureRow } from '@/lib/stdb';
import { Button } from '@/lib/ui/button';
import { cn } from '@/lib/utils';

export type ClosureListItemProps = {
  closure: RoadClosureRow;
  /** set_road_closure_active. The Reopen/Close button shows only when this is set. */
  onToggle?: (id: string, active: boolean) => void;
  /** This closure's toggle call is in flight. */
  pending: boolean;
  disabled: boolean;
  className?: string;
};

/** One closure: name, source, closed or reopened (label and icon), and an optional toggle. */
export function ClosureListItem({ closure, onToggle, pending, disabled, className }: ClosureListItemProps) {
  const id = String(closure.id);
  const StateIcon = closure.active ? Construction : Route;
  const action = closure.active ? 'Reopen' : 'Close';

  return (
    <li className={cn('flex items-center gap-2 py-1.5', className)}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{closure.name}</p>
        <p className="mono-tag truncate text-muted-foreground">{closure.source}</p>
      </div>
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 text-xs',
          closure.active ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        <StateIcon className="size-3.5" aria-hidden />
        {closure.active ? 'Closed' : 'Reopened'}
      </span>
      {onToggle && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={disabled || pending}
          aria-label={`${action} ${closure.name}`}
          aria-busy={pending || undefined}
          onClick={() => onToggle(id, !closure.active)}
        >
          {pending && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}
          {action}
        </Button>
      )}
    </li>
  );
}
