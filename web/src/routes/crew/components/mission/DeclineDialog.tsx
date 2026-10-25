import { useId, useState } from 'react';
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
import { Label } from '@/lib/ui/label';
import { Textarea } from '@/lib/ui/textarea';
import { ActionButton } from './ActionButton';

/** UI cap only: the module logs the reason to the event log, so keep it short. */
const REASON_MAX = 200;

export type DeclineDialogProps = {
  /** decline_mission is in flight: the Decline button spins. */
  busy: boolean;
  disabled: boolean;
  /** Called with the trimmed reason, or "declined" when left blank. */
  onDecline: (reason: string) => void;
  className?: string;
};

/** The secondary "Decline" button plus a confirm dialog that asks for a reason. */
export function DeclineDialog({ busy, disabled, onDecline, className }: DeclineDialogProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const fieldId = useId();
  const hintId = useId();

  const onOpenChange = (next: boolean) => {
    if (next) setReason('');
    setOpen(next);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>
        <ActionButton label="Decline" busy={busy} disabled={disabled} className={className} />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Decline this mission?</AlertDialogTitle>
          <AlertDialogDescription>
            The request goes back to the station line and this unit becomes available.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-2">
          <Label htmlFor={fieldId}>Reason (optional)</Label>
          <Textarea
            id={fieldId}
            aria-describedby={hintId}
            value={reason}
            maxLength={REASON_MAX}
            rows={3}
            onChange={e => setReason(e.target.value)}
          />
          <p id={hintId} className="text-xs text-muted-foreground">
            Shown in the event log. Leave out names and addresses.
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-12">Keep mission</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="min-h-12"
            disabled={disabled}
            onClick={() => onDecline(reason.trim() || 'declined')}
          >
            Decline mission
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
