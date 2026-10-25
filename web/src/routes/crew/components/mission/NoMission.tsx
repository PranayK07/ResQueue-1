import { Radio } from 'lucide-react';
import { EmptyState } from '@/lib/ui/EmptyState';
import { cn } from '@/lib/utils';

/** Idle state (spec 4.3): the unit has no current mission. */
export function NoMission({ className }: { className?: string }) {
  return (
    <EmptyState
      icon={Radio}
      title="No assignment."
      body="The delegation agent assigns the next person."
      className={cn('rounded-frame border border-border bg-surface', className)}
    />
  );
}
