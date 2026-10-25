import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type StatProps = {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
};

/** A small labeled value ("Crew arrives / about 14 min"). Numbers use tabular figures. */
export function Stat({ label, value, sub, className }: StatProps) {
  return (
    <div className={cn('rounded-card border border-border bg-surface-2 px-3 py-2.5', className)}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-base font-semibold tabular-nums">{value}</div>
      {sub != null && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
