import { useSingleton } from '@/lib/stdb/hooks';
import { cn } from '@/lib/utils';

const formatSpeed = (speed: number) => (Number.isInteger(speed) ? String(speed) : speed.toFixed(1));

/** "SIM 30×" from sim_clock.speed. Always visible on ops screens: everything here is simulated. */
export function SimChip({ className }: { className?: string }) {
  const clock = useSingleton('sim_clock');
  return (
    <span
      title="Everything here is simulated"
      className={cn(
        'mono-tag inline-flex h-6 shrink-0 items-center rounded-md border border-lvl-high/40 px-2 text-lvl-high',
        className
      )}
    >
      SIM{clock ? ` ${formatSpeed(clock.speed)}×` : ''}
      {clock && !clock.running ? ' · paused' : ''}
    </span>
  );
}
