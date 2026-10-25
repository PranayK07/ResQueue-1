import { useId, useState, type FormEvent } from 'react';
import { KeyRound, LoaderCircle, TriangleAlert } from 'lucide-react';
import { Button } from '@/lib/ui/button';
import { Input } from '@/lib/ui/input';
import { Label } from '@/lib/ui/label';
import { cn } from '@/lib/utils';

export type OperatorGateProps = {
  /** Called with the trimmed name and the passcode as typed. Nothing is stored here. */
  onSubmit: (name: string, passcode: string) => void;
  /** claim_operator is in flight. */
  pending: boolean;
  /** Mapped error copy from a failed claim ("Wrong passcode."). */
  error?: string | null;
  /** Connection isn't live: sign-in can't be sent. */
  disabled: boolean;
  className?: string;
};

/** Commander sign-in: name and passcode. */
export function OperatorGate({ onSubmit, pending, error, disabled, className }: OperatorGateProps) {
  const id = useId();
  const [name, setName] = useState('');
  const [passcode, setPasscode] = useState('');
  const ready = name.trim() !== '' && passcode !== '';
  const off = disabled || pending || !ready;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (off) return;
    onSubmit(name.trim(), passcode);
  };

  return (
    <div className={cn('flex w-full flex-1 items-center justify-center px-6 py-16', className)}>
      <form
        onSubmit={submit}
        aria-labelledby={`${id}-title`}
        className="flex w-full max-w-sm flex-col gap-5 rounded-frame border border-border bg-surface p-6"
      >
        <div className="flex flex-col gap-1.5">
          <span className="mb-2 grid size-9 place-items-center rounded-card border border-border bg-surface-2">
            <KeyRound className="size-4 text-muted-foreground" aria-hidden />
          </span>
          <h1 id={`${id}-title`} className="text-lg font-semibold text-foreground">
            Incident command
          </h1>
          <p className="text-sm text-muted-foreground">Sign in to see every request and step in on judgment calls.</p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            className="h-10"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            disabled={pending}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-passcode`}>Passcode</Label>
          <Input
            id={`${id}-passcode`}
            className="h-10"
            type="password"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            autoComplete="off"
            disabled={pending}
          />
        </div>

        {error && (
          <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{error}</span>
          </p>
        )}

        <div className="flex flex-col gap-2">
          <Button type="submit" size="lg" className="h-10" disabled={off} aria-busy={pending}>
            {pending && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}
            Sign in
          </Button>
          {disabled && !pending && (
            <p className="text-center text-xs text-muted-foreground">Waiting for a live connection.</p>
          )}
        </div>
      </form>
    </div>
  );
}
