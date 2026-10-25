import { Phone } from 'lucide-react';
import { cn } from '@/lib/utils';

type Call911Size = 'pill' | 'block' | 'big';

type Call911LinkProps = {
  /** pill: compact header pill inside a 48px tap target. block: full width, 48px. big: full width, 64px. */
  size?: Call911Size;
  className?: string;
};

const FACE: Record<Call911Size, string> = {
  pill: 'h-9 gap-1.5 rounded-full px-3.5 text-sm',
  block: 'min-h-12 w-full gap-2 rounded-card px-4 text-base',
  big: 'min-h-16 w-full gap-2.5 rounded-frame px-5 text-lg',
};

/**
 * The tel:911 link. Never hidden or disabled, in any state.
 * Solid destructive with dark text: white on #FF5533 is about 3.2:1, dark text is about 6.4:1.
 * The outer anchor is the tap target (at least 48px); the inner span is the visible face.
 */
export function Call911Link({ size = 'block', className }: Call911LinkProps) {
  return (
    <a
      href="tel:911"
      className={cn(
        'group/call inline-flex min-h-12 min-w-12 shrink-0 items-center justify-center outline-none',
        size !== 'pill' && 'w-full',
        className
      )}
    >
      <span
        className={cn(
          'inline-flex items-center justify-center bg-destructive font-semibold text-background transition-colors duration-150 ease-out',
          'group-hover/call:bg-destructive/90 group-active/call:bg-destructive/80',
          'group-focus-visible/call:ring-3 group-focus-visible/call:ring-ring group-focus-visible/call:ring-offset-2 group-focus-visible/call:ring-offset-background',
          FACE[size]
        )}
      >
        <Phone className={size === 'pill' ? 'size-4' : 'size-5'} aria-hidden />
        Call 911
      </span>
    </a>
  );
}
