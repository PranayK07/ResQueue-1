import { Fragment } from 'react';
import { NEED_LABEL, parseNeeds } from '@/lib/domain/needs';
import { LevelBadge } from '@/lib/ui/LevelBadge';
import { NeedIcon } from '@/lib/ui/NeedChips';
import { cn } from '@/lib/utils';
import { fireText, peopleText } from './lineCopy';
import type { StationLineRow } from './types';

export type LineRowProps = {
  row: StationLineRow;
  className?: string;
};

/** One read-only entry in the line: rank, who and what they need, minutes before fire, level. */
export function LineRow({ row, className }: LineRowProps) {
  const needs = parseNeeds(row.needs);

  return (
    <li data-request-id={row.requestId} className={cn('flex min-h-14 items-center gap-3 px-4 py-3', className)}>
      <span className="min-w-6 shrink-0 text-sm text-muted-foreground tabular-nums">
        <span className="sr-only">Rank </span>
        {row.rank}
      </span>

      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-medium tabular-nums">
          <span>{peopleText(row.headcount)}</span>
          {needs.map(n => (
            <Fragment key={n}>
              <span aria-hidden className="text-muted-foreground">
                ·
              </span>
              <span className="sr-only">,</span>
              <span className="inline-flex items-center gap-1">
                <NeedIcon need={n} className="text-muted-foreground" />
                {NEED_LABEL[n]}
              </span>
            </Fragment>
          ))}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">{fireText(row.minutesBeforeFire)}</p>
      </div>

      <LevelBadge level={row.level} />
    </li>
  );
}
