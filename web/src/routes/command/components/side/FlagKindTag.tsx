import { Ban, Flag } from 'lucide-react';
import { cn } from '@/lib/utils';

export type FlagKindTagProps = {
  /** ops_flag.kind: unreachable, suspect or escalation. */
  kind: string;
  className?: string;
};

/** A flag's kind as label plus icon. Unreachable carries the unreachable level tint; the rest are muted. */
export function FlagKindTag({ kind, className }: FlagKindTagProps) {
  const unreachable = kind === 'unreachable';
  const Icon = unreachable ? Ban : Flag;
  return (
    <span
      data-kind={kind}
      className={cn(
        'mono-tag inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 uppercase',
        unreachable ? 'bg-lvl-unreachable/15 text-lvl-unreachable' : 'bg-white/5 text-muted-foreground',
        className
      )}
    >
      <Icon className="size-3" aria-hidden />
      {kind || 'flag'}
    </span>
  );
}
