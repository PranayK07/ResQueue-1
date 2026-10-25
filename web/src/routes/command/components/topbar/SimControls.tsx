import { LoaderCircle, Pause, Play } from 'lucide-react';
import { Button } from '@/lib/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/lib/ui/select';

export type SimControlsProps = {
  running: boolean;
  /** sim_clock.speed, undefined until sim_clock arrives. */
  speed: number | undefined;
  onSetSim: (running: boolean, speed: number) => void;
  /** A set_sim call is in flight. */
  pending: boolean;
  disabled: boolean;
};

const SPEEDS: readonly number[] = [10, 30, 60, 120];
const DEFAULT_SPEED = 30;

const speedLabel = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}×`;

/** Run/Pause and the speed picker (set_sim). */
export function SimControls({ running, speed, onSetSim, pending, disabled }: SimControlsProps) {
  const off = disabled || pending;
  // Keep a speed set elsewhere (not one of the presets) selectable, so the picker never shows blank.
  const options =
    speed === undefined || SPEEDS.includes(speed) ? SPEEDS : [...SPEEDS, speed].sort((a, b) => a - b);
  const Icon = pending ? LoaderCircle : running ? Pause : Play;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        disabled={off}
        aria-busy={pending}
        onClick={() => onSetSim(!running, speed ?? DEFAULT_SPEED)}
      >
        <Icon className={pending ? 'motion-safe:animate-spin' : undefined} aria-hidden />
        {running ? 'Pause' : 'Run'}
      </Button>
      <Select
        value={speed === undefined ? '' : String(speed)}
        onValueChange={(v) => onSetSim(running, Number(v))}
        disabled={off}
      >
        <SelectTrigger size="sm" aria-label="Sim speed" className="font-mono tabular-nums">
          <SelectValue placeholder="Speed" />
        </SelectTrigger>
        <SelectContent>
          {options.map((n) => (
            <SelectItem key={n} value={String(n)} className="font-mono tabular-nums">
              {speedLabel(n)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
