import { Slider as SliderPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export type WindSliderProps = {
  /** Short visible label. Also the thumb's accessible name. */
  label: string;
  /** What a screen reader hears for the value, e.g. "12.0 meters per second". */
  valueText: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  /** Every step while dragging or on a key press. */
  onChange: (v: number) => void;
  /** Once per finished drag or key press. */
  onCommit: (v: number) => void;
  /** Pointer went down on the slider. */
  onDragStart: () => void;
  /** Pointer released or cancelled. */
  onDragEnd: () => void;
  className?: string;
};

/**
 * The Radix slider with shadcn styling. Built here rather than from '@/lib/ui/slider'
 * because that wrapper can't give the thumb an accessible name.
 */
export function WindSlider({
  label,
  valueText,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
  onCommit,
  onDragStart,
  onDragEnd,
  className,
}: WindSliderProps) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span aria-hidden className="w-12 shrink-0 text-xs text-muted-foreground">
        {label}
      </span>
      <SliderPrimitive.Root
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={v => {
          const n = v[0];
          if (n !== undefined) onChange(n);
        }}
        onValueCommit={v => {
          const n = v[0];
          if (n !== undefined) onCommit(n);
        }}
        onPointerDown={disabled ? undefined : onDragStart}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onLostPointerCapture={onDragEnd}
        className="relative flex h-6 w-full touch-none items-center select-none data-disabled:cursor-not-allowed data-disabled:opacity-50"
      >
        <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-white/10">
          <SliderPrimitive.Range className="absolute h-full bg-primary" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-label={label}
          aria-valuetext={valueText}
          className="block size-4 rounded-full border border-ring bg-white shadow-sm ring-ring/50 transition-[box-shadow] hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden"
        />
      </SliderPrimitive.Root>
    </div>
  );
}
