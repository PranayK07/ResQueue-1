import { Loader2 } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { Button } from '@/lib/ui/button';
import { cn } from '@/lib/utils';

export type ActionButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'children'> & {
  label: string;
  /** The call is in flight and the row hasn't changed yet: shows a spinner. */
  busy?: boolean;
  /** Primary: light, full width, 56px tall. Otherwise an outline button, 48px tall. */
  primary?: boolean;
};

/**
 * A mission button. No optimistic UI: it spins until the page clears `pending`.
 * Forwards its ref and props so it can be a Radix trigger.
 */
export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton(
  { label, busy = false, primary = false, className, type = 'button', ...rest },
  ref
) {
  return (
    <Button
      ref={ref}
      type={type}
      variant={primary ? 'default' : 'outline'}
      aria-busy={busy || undefined}
      className={cn(
        'h-auto rounded-card whitespace-normal',
        primary ? 'min-h-14 w-full text-base font-semibold' : 'min-h-12 text-sm',
        className
      )}
      {...rest}
    >
      {busy && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}
      {label}
    </Button>
  );
});
