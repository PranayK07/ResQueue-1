import { useId } from 'react';
import { KNOWN_NEEDS, NEED_LABEL, type Need } from '@/lib/domain/needs';
import { NeedIcon } from '@/lib/ui/NeedChips';
import { cn } from '@/lib/utils';

export type NeedsPickerProps = {
  value: Need[];
  /** Always in KNOWN_NEEDS order, deduped. */
  onChange: (n: Need[]) => void;
  disabled?: boolean;
};

/** "What do you need?" as toggle chips, one per known need. */
export function NeedsPicker({ value, onChange, disabled }: NeedsPickerProps) {
  const labelId = useId();

  const toggle = (need: Need) => {
    const on = value.includes(need);
    onChange(KNOWN_NEEDS.filter(n => (n === need ? !on : value.includes(n))));
  };

  return (
    <div className="space-y-3">
      <p id={labelId} className="text-sm leading-none font-medium">
        What do you need?
      </p>
      <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-2">
        {KNOWN_NEEDS.map(need => {
          const on = value.includes(need);
          return (
            <button
              key={need}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => toggle(need)}
              className={cn(
                'inline-flex min-h-12 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors duration-150 ease-out outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
                on ? 'border-foreground bg-foreground text-background' : 'border-border bg-surface text-foreground hover:bg-surface-2'
              )}
            >
              <NeedIcon need={need} className="size-4" />
              {NEED_LABEL[need]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
