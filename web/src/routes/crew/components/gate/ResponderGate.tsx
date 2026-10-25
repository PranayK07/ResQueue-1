import { useId, useState, type FormEvent } from 'react';
import { CircleAlert, LoaderCircle } from 'lucide-react';
import type { StationRow } from '@/lib/stdb';
import { Button } from '@/lib/ui/button';
import { Input } from '@/lib/ui/input';
import { Label } from '@/lib/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/lib/ui/select';
import { GateFrame } from './GateFrame';

export type ResponderGateProps = {
  /** Every station row. The responder picks theirs by name. */
  stations: readonly StationRow[];
  /** Called with the trimmed name, the passcode as typed and the picked station id. */
  onSubmit: (name: string, passcode: string, stationId: number) => void;
  /** claim_operator is in flight. */
  pending: boolean;
  /** Mapped error copy from a failed sign-in, shown inline. */
  error?: string | null;
  /** Blocks Sign in, for example while offline. Fields stay editable. */
  disabled: boolean;
  className?: string;
};

const FIELD = 'h-12 px-3 text-base';

/** /crew signed-out state: name, passcode and station, then Sign in. The passcode is never kept after submit. */
export function ResponderGate({ stations, onSubmit, pending, error, disabled, className }: ResponderGateProps) {
  const nameId = useId();
  const passcodeId = useId();
  const stationFieldId = useId();
  const stationHintId = useId();
  const errorId = useId();

  const [name, setName] = useState('');
  const [passcode, setPasscode] = useState('');
  const [stationValue, setStationValue] = useState('');

  // If the picked station leaves the list (scenario reload), fall back to the placeholder.
  const station = stations.find(s => String(s.id) === stationValue) ?? null;
  const noStations = stations.length === 0;
  const canSubmit = !disabled && !pending && station !== null && passcode !== '';

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (canSubmit && station) onSubmit(name.trim(), passcode, station.id);
  };

  return (
    <GateFrame title="Responder sign-in" subtitle="Sign in to see your station's line." className={className}>
      <form noValidate onSubmit={submit} aria-busy={pending || undefined} className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor={nameId}>Name</Label>
          <Input
            id={nameId}
            value={name}
            onChange={e => setName(e.target.value)}
            readOnly={pending}
            autoComplete="name"
            autoCapitalize="words"
            className={FIELD}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={passcodeId}>Passcode</Label>
          <Input
            id={passcodeId}
            type="password"
            value={passcode}
            onChange={e => setPasscode(e.target.value)}
            readOnly={pending}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={error ? errorId : undefined}
            className={FIELD}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={stationFieldId}>Station</Label>
          <Select value={station ? stationValue : ''} onValueChange={setStationValue} disabled={pending || noStations}>
            <SelectTrigger
              id={stationFieldId}
              aria-describedby={noStations ? stationHintId : undefined}
              className="h-12 w-full px-3 text-base data-[size=default]:h-12"
            >
              <SelectValue placeholder="Pick your station" />
            </SelectTrigger>
            <SelectContent>
              {stations.map(s => (
                <SelectItem key={s.id} value={String(s.id)} className="min-h-12 text-base">
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {noStations && (
            <p id={stationHintId} className="text-sm text-muted-foreground">
              No stations available yet.
            </p>
          )}
        </div>

        {error && (
          <p id={errorId} role="alert" className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{error}</span>
          </p>
        )}

        <Button type="submit" className="h-14 w-full text-base" disabled={!canSubmit} aria-busy={pending || undefined}>
          {pending ? (
            <>
              <LoaderCircle className="size-5 motion-safe:animate-spin" aria-hidden />
              Signing in...
            </>
          ) : (
            'Sign in'
          )}
        </Button>
      </form>
    </GateFrame>
  );
}
