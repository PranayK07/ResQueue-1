import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { useAnchor } from '@/lib/guide';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/lib/ui/alert-dialog';
import { Button } from '@/lib/ui/button';
import { cn } from '@/lib/utils';

export type SafeActionsProps = {
  /** Confirmed "Close request": close_my_request with outcome "safe". */
  onSafe: () => void;
  /** Confirmed "Stop sharing": close_my_request with outcome "revoked". */
  onStopSharing: () => void;
  /** Which close is in flight, if any. */
  pending: 'safe' | 'revoked' | null;
  /** Both actions unavailable (offline, or no active request). */
  disabled: boolean;
  /** Mapped error copy from a failed close, shown inline. */
  error?: string | null;
  className?: string;
};

const DIALOG_BUTTON = 'h-auto min-h-12';

/** "I'm safe now" and "Stop sharing my location", each behind a confirm dialog. */
export function SafeActions({ onSafe, onStopSharing, pending, disabled, error, className }: SafeActionsProps) {
  const anchor = useAnchor('help.card.safe');
  const off = disabled || pending !== null;

  return (
    <div {...anchor} data-guide-clear className={cn('flex flex-col gap-1', className)}>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="secondary"
            className="h-auto min-h-14 w-full rounded-card border-border text-base font-semibold"
            disabled={off}
            aria-busy={pending === 'safe'}
          >
            {pending === 'safe' && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}
            I'm safe now
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close your request?</AlertDialogTitle>
            <AlertDialogDescription>
              Your location will be deleted and any crew on the way will be released. If you still need help, call
              911.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={DIALOG_BUTTON}>Keep my request</AlertDialogCancel>
            <AlertDialogAction className={DIALOG_BUTTON} onClick={onSafe}>
              Close request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto min-h-12 w-full text-sm text-muted-foreground hover:text-foreground"
            disabled={off}
            aria-busy={pending === 'revoked'}
          >
            {pending === 'revoked' && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}
            Stop sharing my location
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop sharing your location?</AlertDialogTitle>
            <AlertDialogDescription>This cancels your request and deletes your location.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={DIALOG_BUTTON}>Keep sharing</AlertDialogCancel>
            <AlertDialogAction className={DIALOG_BUTTON} onClick={onStopSharing}>
              Stop sharing
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {error && (
        <p role="alert" className="flex items-start gap-2 px-1 pt-1 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
