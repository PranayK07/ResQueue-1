import { NEED_LABEL, parseNeeds } from '@/lib/domain/needs';
import { NeedIcon } from '@/lib/ui/NeedChips';
import { cn } from '@/lib/utils';
import { headcountLabel } from './model';

export type HeadcountNeedsProps = {
  headcount: number;
  /** The module's comma list, e.g. "mobility,medical". */
  needs: string;
  className?: string;
};

/** "2 people" plus one icon per need, each titled and labeled with the need's name. */
export function HeadcountNeeds({ headcount, needs, className }: HeadcountNeedsProps) {
  const list = parseNeeds(needs);
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <span className="text-xs whitespace-nowrap text-foreground tabular-nums">{headcountLabel(headcount)}</span>
      {list.map(n => (
        <span key={n} role="img" aria-label={NEED_LABEL[n]} title={NEED_LABEL[n]} className="inline-flex text-muted-foreground">
          <NeedIcon need={n} />
        </span>
      ))}
    </span>
  );
}
