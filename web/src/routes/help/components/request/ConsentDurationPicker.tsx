import { useId } from 'react';
import { CONSENT_OPTIONS } from '@/lib/domain/limits';
import { cn } from '@/lib/utils';

export type ConsentDurationPickerProps = {
  /** Minutes. Nothing is pressed if it isn't one of CONSENT_OPTIONS. */
  value: number;
  onChange: (minutes: number) => void;
  disabled?: boolean;
};

/** "30 min", "1 hr", "2 hr", "4 hr". */
const optionLabel = (minutes: number): string => (minutes < 60 ? `${minutes} min` : `${minutes / 60} hr`);

/** "Share for" segmented buttons over CONSENT_OPTIONS. */
export function ConsentDurationPicker({ value, onChange, disabled }: ConsentDurationPickerProps) {
  const labelId = useId();
  return (
    <div className="space-y-2">
      <p id={labelId} className="text-sm leading-none font-medium">
        Share for
      </p>
      <div
        role="group"
        aria-labelledby={labelId}
        className="grid grid-cols-4 gap-1 rounded-card border border-border bg-surface p-1"
      >
        {CONSENT_OPTIONS.map(m => {
          const on = value === m;
          return (
            <button
              key={m}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onChange(m)}
              className={cn(
                'min-h-12 rounded-lg text-sm font-medium tabular-nums transition-colors duration-150 ease-out outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
                on ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
              )}
            >
              {optionLabel(m)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
