import type { ReactNode } from 'react';

type LegendRowProps = {
  swatch: ReactNode;
  children: ReactNode;
};

/** One legend entry: a swatch drawn like the map feature, then its words. */
export function LegendRow({ swatch, children }: LegendRowProps) {
  return (
    <li className="flex items-center gap-2">
      <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
        {swatch}
      </span>
      <span>{children}</span>
    </li>
  );
}
