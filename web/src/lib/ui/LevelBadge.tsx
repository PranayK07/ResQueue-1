import { Ban, CircleDashed, Clock, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import { LEVEL_META, toLevel, type Level } from '@/lib/domain/levels';
import { cn } from '@/lib/utils';

const LEVEL_ICON: Record<Level, LucideIcon> = {
  unreachable: Ban,
  critical: OctagonAlert,
  high: TriangleAlert,
  moderate: Clock,
  unknown: CircleDashed,
};

type LevelBadgeProps = {
  level: string;
  size?: 'sm' | 'md';
  className?: string;
};

/** A danger level as label + icon + color, never color alone. */
export function LevelBadge({ level, size = 'sm', className }: LevelBadgeProps) {
  const l = toLevel(level);
  const meta = LEVEL_META[l];
  const Icon = LEVEL_ICON[l];
  return (
    <span
      title={meta.hint}
      data-level={l}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md font-semibold tracking-wide uppercase',
        size === 'sm' ? 'px-1.5 py-0.5 text-[10px] leading-4' : 'px-2 py-1 text-xs',
        className
      )}
      style={{ color: meta.color, backgroundColor: `color-mix(in srgb, ${meta.color} 14%, transparent)` }}
    >
      <Icon className={size === 'sm' ? 'size-3' : 'size-3.5'} aria-hidden />
      {meta.label}
    </span>
  );
}
