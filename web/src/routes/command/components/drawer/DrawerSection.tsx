import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type DrawerSectionProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  /** Small uppercase label, e.g. "Station line". */
  title: ReactNode;
};

/** One labeled block of the request drawer. Spreads extra props, so guide anchors work. */
export function DrawerSection({ title, className, children, ...rest }: DrawerSectionProps) {
  return (
    <section className={cn('space-y-2.5', className)} {...rest}>
      <h3 className="label-caps">{title}</h3>
      {children}
    </section>
  );
}
