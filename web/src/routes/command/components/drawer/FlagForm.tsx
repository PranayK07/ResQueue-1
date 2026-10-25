import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, ShieldAlert, Siren } from 'lucide-react';
import { Button } from '@/lib/ui/button';
import { Input } from '@/lib/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/lib/ui/toggle-group';
import { DrawerSection } from './DrawerSection';

/** The kinds a commander may raise with flag_request ("unreachable" is raised by the delegation agent). */
export type FlagKind = 'suspect' | 'escalation';

export type FlagFormProps = {
  /** flag_request. */
  onFlag: (kind: FlagKind, detail: string) => void;
  pending: boolean;
  /** Blocks every control, e.g. while offline. */
  disabled: boolean;
  /** Inline error text from the last failed flag. */
  error?: string;
};

const isFlagKind = (v: string): v is FlagKind => v === 'suspect' || v === 'escalation';

/** Raise a suspect or escalation flag on the request. */
export function FlagForm({ onFlag, pending, disabled, error }: FlagFormProps) {
  const [kind, setKind] = useState<FlagKind | undefined>(undefined);
  const [detail, setDetail] = useState('');

  // Clear the form once a flag goes through, so a second click doesn't repeat it by accident.
  const wasPending = useRef(pending);
  useEffect(() => {
    if (wasPending.current && !pending && !error) {
      setKind(undefined);
      setDetail('');
    }
    wasPending.current = pending;
  }, [pending, error]);

  const blocked = disabled || pending;

  return (
    <DrawerSection title="Flag">
      <ToggleGroup
        type="single"
        variant="outline"
        value={kind ?? ''}
        onValueChange={v => {
          if (isFlagKind(v)) setKind(v);
        }}
        disabled={blocked}
        aria-label="Flag kind"
      >
        <ToggleGroupItem value="suspect">
          <ShieldAlert aria-hidden />
          Suspect
        </ToggleGroupItem>
        <ToggleGroupItem value="escalation">
          <Siren aria-hidden />
          Escalation
        </ToggleGroupItem>
      </ToggleGroup>

      <Input
        value={detail}
        onChange={e => setDetail(e.target.value)}
        placeholder="What did you notice? (optional)"
        aria-label="Flag detail"
        disabled={blocked}
      />

      <Button
        variant="outline"
        className="w-full"
        disabled={blocked || !kind}
        onClick={() => {
          if (kind) onFlag(kind, detail.trim());
        }}
      >
        {pending && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}
        Flag request
      </Button>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </DrawerSection>
  );
}
