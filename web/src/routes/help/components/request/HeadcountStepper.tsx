import { useId } from 'react';
import { Minus, Plus } from 'lucide-react';
import { HEADCOUNT_MAX, HEADCOUNT_MIN } from '@/lib/domain/limits';
import { Button } from '@/lib/ui/button';

export type HeadcountStepperProps = {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  /** Id of an inline error, so it's read with the field. */
  describedBy?: string;
};

const clamp = (n: number): number =>
  Number.isFinite(n) ? Math.min(HEADCOUNT_MAX, Math.max(HEADCOUNT_MIN, Math.round(n))) : HEADCOUNT_MIN;

/** "How many people?" with 48px minus and plus buttons, clamped to the module's 1..50. */
export function HeadcountStepper({ value, onChange, disabled, describedBy }: HeadcountStepperProps) {
  const labelId = useId();
  // aria-disabled at the limits (not disabled) so keyboard focus stays on the button.
  const atMin = value <= HEADCOUNT_MIN;
  const atMax = value >= HEADCOUNT_MAX;

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      className="flex items-center justify-between gap-4"
    >
      <span id={labelId} className="text-sm leading-none font-medium">
        How many people?
      </span>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-12 rounded-full aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          aria-label="One fewer person"
          aria-disabled={atMin || undefined}
          disabled={disabled}
          onClick={() => {
            if (!atMin) onChange(clamp(value - 1));
          }}
        >
          <Minus className="size-5" aria-hidden />
        </Button>
        <span aria-live="polite" aria-atomic="true" className="min-w-12 text-center text-2xl font-semibold tabular-nums">
          {value}
          <span className="sr-only">{value === 1 ? ' person' : ' people'}</span>
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-12 rounded-full aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          aria-label="One more person"
          aria-disabled={atMax || undefined}
          disabled={disabled}
          onClick={() => {
            if (!atMax) onChange(clamp(value + 1));
          }}
        >
          <Plus className="size-5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
