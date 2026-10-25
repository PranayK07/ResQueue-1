import { Hourglass } from 'lucide-react';
import { cn } from '@/lib/utils';

export type IdleCardProps = {
  className?: string;
};

/** Shown in place of the mission card while this unit has no assignment. */
export function IdleCard({ className }: IdleCardProps) {
  return (
    <section className={cn('rounded-frame border border-border bg-surface p-5', className)}>
      <div className="flex items-start gap-3">
        <Hourglass className="mt-1 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div>
          <h2 className="text-lg leading-snug font-semibold">No assignment.</h2>
          <p className="mt-1 text-sm text-muted-foreground">The delegation agent assigns the next person.</p>
        </div>
      </div>
    </section>
  );
}
