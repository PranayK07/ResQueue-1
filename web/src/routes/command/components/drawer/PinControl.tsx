import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Lock, Pin } from 'lucide-react';
import { isLockedStatus } from '@/lib/domain/status';
import { useAnchor } from '@/lib/guide';
import type { StationRow } from '@/lib/stdb';
import { Button } from '@/lib/ui/button';
import { Input } from '@/lib/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/lib/ui/select';
import { DrawerSection } from './DrawerSection';
import { stationName } from './stationName';

export type PinControlProps = {
  /** request.status. A locked status (crew committed) blocks pin and unpin. */
  status: string;
  /** request.pinnedStationId, 0 when not pinned. */
  pinnedStationId: number;
  stations: readonly StationRow[];
  /** override_assignment. stationId 0 unpins. */
  onPin: (stationId: number, note: string) => void;
  pending: boolean;
  /** Blocks every control, e.g. while offline. */
  disabled: boolean;
  /** Inline error text from the last failed pin or unpin. */
  error?: string;
};

/** Commander pin: a pin beats the policy, and a committed crew is never pulled. */
export function PinControl({ status, pinnedStationId, stations, onPin, pending, disabled, error }: PinControlProps) {
  const anchor = useAnchor('cmd.drawer.pin');
  const noteHintId = useId();
  const [stationValue, setStationValue] = useState('');
  const [note, setNote] = useState('');
  const [lastAction, setLastAction] = useState<'pin' | 'unpin' | null>(null);

  // Clear the form once a pin or unpin goes through.
  const wasPending = useRef(pending);
  useEffect(() => {
    if (wasPending.current && !pending && !error) {
      setStationValue('');
      setNote('');
    }
    wasPending.current = pending;
  }, [pending, error]);

  const locked = isLockedStatus(status);
  const blocked = disabled || pending || locked;
  const sorted = useMemo(() => [...stations].sort((a, b) => a.id - b.id), [stations]);
  const chosen = sorted.find(s => String(s.id) === stationValue);

  const pin = () => {
    if (!chosen) return;
    setLastAction('pin');
    onPin(chosen.id, note.trim());
  };
  const unpin = () => {
    setLastAction('unpin');
    onPin(0, note.trim());
  };

  const spinner = <LoaderCircle className="motion-safe:animate-spin" aria-hidden />;

  return (
    <DrawerSection {...anchor} title="Pin">
      {locked && (
        <p className="flex items-center gap-2 rounded-card border border-border bg-surface-2 px-3 py-2 text-sm">
          <Lock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {"Crew committed: can't be moved"}
        </p>
      )}

      {pinnedStationId !== 0 && (
        <div className="flex items-center gap-2 rounded-card border border-border bg-surface-2 px-3 py-2">
          <Pin className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="min-w-0 text-sm">
            Pinned to <span className="font-medium">{stationName(stations, pinnedStationId)}</span>
          </p>
          <Button variant="outline" size="sm" className="ml-auto" disabled={blocked} onClick={unpin}>
            {pending && lastAction === 'unpin' && spinner}
            Unpin
          </Button>
        </div>
      )}

      <Select value={stationValue} onValueChange={setStationValue} disabled={blocked || sorted.length === 0}>
        <SelectTrigger className="w-full" aria-label="Station to pin to">
          <SelectValue placeholder={sorted.length === 0 ? 'No stations loaded' : 'Choose a station'} />
        </SelectTrigger>
        <SelectContent position="popper">
          {sorted.map(s => (
            <SelectItem key={s.id} value={String(s.id)}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder="Reason for the pin (optional)"
        aria-label="Pin note"
        aria-describedby={noteHintId}
        disabled={blocked}
      />
      <p id={noteHintId} className="text-xs text-muted-foreground">
        The note goes in the event log. Leave out names and addresses.
      </p>

      <Button className="w-full" disabled={blocked || !chosen} onClick={pin}>
        {pending && lastAction === 'pin' && spinner}
        Pin to station
      </Button>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </DrawerSection>
  );
}
