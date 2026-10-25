import { LoaderCircle } from 'lucide-react';
import { Button } from '@/lib/ui/button';
import { cn } from '@/lib/utils';

type HelpButtonProps = {
  onPress: () => void;
  disabled?: boolean;
  /** Defaults to "I need help". While loading, pass "Connecting..." with disabled to get the spinner. */
  label?: string;
  className?: string;
};

const CONNECTING_LABEL = 'Connecting...';

/** The one big ask-for-help button: full width, at least 72px tall. */
export function HelpButton({ onPress, disabled = false, label = 'I need help', className }: HelpButtonProps) {
  const connecting = disabled && label === CONNECTING_LABEL;
  return (
    <Button
      type="button"
      onClick={() => onPress()}
      disabled={disabled}
      className={cn(
        // rounded-(--radius-frame), not rounded-frame: cn doesn't know the custom radius name,
        // so it would keep the base rounded-lg, which Tailwind emits later and which then wins.
        'h-auto min-h-[72px] w-full gap-2.5 rounded-(--radius-frame) px-6 text-xl font-semibold whitespace-normal',
        className
      )}
    >
      {connecting && <LoaderCircle className="size-6 motion-safe:animate-spin" aria-hidden />}
      {label}
    </Button>
  );
}
