import { Users } from 'lucide-react';
import { useAnchor } from '@/lib/guide';
import { NeedChips } from '@/lib/ui/NeedChips';
import { cn } from '@/lib/utils';

export type MissionNeedsProps = {
  headcount: number;
  /** The module's comma list, e.g. "mobility,medical". */
  needs: string;
  /** The resident's raw note, untranslated. Hidden when blank. */
  note: string;
  className?: string;
};

/** Headcount, needs as words and icons, and the resident's note in quotes. */
export function MissionNeeds({ headcount, needs, note, className }: MissionNeedsProps) {
  const anchor = useAnchor('crew.mission.needs');
  const text = note.trim();

  return (
    <div {...anchor} className={cn('space-y-2', className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs text-foreground tabular-nums">
          <Users className="size-3.5 text-muted-foreground" aria-hidden />
          {headcount} {headcount === 1 ? 'person' : 'people'}
        </span>
        <NeedChips needs={needs} />
      </div>
      {text !== '' && (
        <blockquote className="text-sm leading-relaxed break-words text-muted-foreground italic">
          &ldquo;{text}&rdquo;
        </blockquote>
      )}
    </div>
  );
}
