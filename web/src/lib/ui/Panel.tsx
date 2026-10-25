import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type PanelProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  /** Small uppercase label, e.g. "Station lines". */
  title?: ReactNode;
  /** Right side of the header, e.g. a count or "Live". */
  meta?: ReactNode;
  /** A raised 12px card instead of a 20px frame. */
  raised?: boolean;
};

/** A rounded product frame with an optional label header. Spreads extra props, so anchors work. */
export function Panel({ title, meta, raised, className, children, ...rest }: PanelProps) {
  return (
    <section
      className={cn(
        'border border-border',
        raised ? 'rounded-card bg-surface-2' : 'rounded-frame bg-surface',
        className
      )}
      {...rest}
    >
      {(title != null || meta != null) && (
        <header className="flex items-center gap-3 px-4 pt-3 pb-2">
          {title != null && <h2 className="label-caps">{title}</h2>}
          {meta != null && <div className="label-caps ml-auto">{meta}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
