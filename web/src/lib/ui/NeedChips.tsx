import { Accessibility, Baby, Cylinder, Languages, PawPrint, PersonStanding, Stethoscope, type LucideIcon } from 'lucide-react';
import { NEED_LABEL, parseNeeds, type Need } from '@/lib/domain/needs';
import { cn } from '@/lib/utils';

const NEED_ICON: Record<Need, LucideIcon> = {
  mobility: Accessibility,
  medical: Stethoscope,
  oxygen: Cylinder,
  infant: Baby,
  elderly: PersonStanding,
  pets: PawPrint,
  language: Languages,
};

export function NeedIcon({ need, className }: { need: Need; className?: string }) {
  const Icon = NEED_ICON[need];
  return <Icon className={cn('size-3.5', className)} aria-hidden />;
}

type NeedChipsProps = {
  /** The module's comma list, e.g. "mobility,medical". */
  needs: string;
  className?: string;
};

/** Needs as words with icons. Renders nothing when there are none. */
export function NeedChips({ needs, className }: NeedChipsProps) {
  const list = parseNeeds(needs);
  if (list.length === 0) return null;
  return (
    <ul className={cn('flex flex-wrap gap-1.5', className)} aria-label="Needs">
      {list.map(n => (
        <li
          key={n}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs text-foreground"
        >
          <NeedIcon need={n} className="text-muted-foreground" />
          {NEED_LABEL[n]}
        </li>
      ))}
    </ul>
  );
}
