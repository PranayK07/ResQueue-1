import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type MonoTagProps = {
  children: ReactNode;
  /** guide: the blue anchor tag of the guide layer. plain: ids, callsigns, sim time. */
  tone?: 'guide' | 'plain';
  className?: string;
};

/** A small mono label, like Jimo's "Interface Context" tags. */
export function MonoTag({ children, tone = 'plain', className }: MonoTagProps) {
  return (
    <span
      className={cn(
        'mono-tag inline-flex items-center rounded-md px-1.5 py-0.5',
        tone === 'guide' ? 'bg-guide/15 text-guide' : 'bg-surface-2 text-muted-foreground',
        className
      )}
    >
      {children}
    </span>
  );
}
