import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type MapNoteProps = {
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
};

/** Small muted chip for map status lines (style missing, last update). */
export function MapNote({ icon: Icon, children, className }: MapNoteProps) {
  return (
    <p
      className={cn(
        'flex w-fit items-center gap-1.5 rounded-full border border-border bg-surface/90 px-2.5 py-1 text-[11px] leading-4 text-muted-foreground backdrop-blur-sm',
        className
      )}
    >
      {Icon && <Icon className="size-3 shrink-0" aria-hidden />}
      {children}
    </p>
  );
}
