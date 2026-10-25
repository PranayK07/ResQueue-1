import { MapPinOff } from 'lucide-react';
import { EmptyState } from '@/lib/ui/EmptyState';

/** grid.rows === 0 or scenario === "none": the seed script hasn't loaded a world. */
export function NoScenario() {
  return (
    <EmptyState
      icon={MapPinOff}
      className="flex-1 py-16"
      title={
        <>
          No scenario loaded. Run{' '}
          <code className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em]">scripts/dev.sh reset</code>.
        </>
      }
    />
  );
}
