import { Ban, CircleDashed, Clock, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { Level } from '@/lib/domain/levels';

/**
 * Same icons as LevelBadge (lib/ui), so a level reads the same on the map and
 * in the panels. LevelBadge doesn't export its map, hence this copy.
 */
export const LEVEL_ICON: Record<Level, LucideIcon> = {
  unreachable: Ban,
  critical: OctagonAlert,
  high: TriangleAlert,
  moderate: Clock,
  unknown: CircleDashed,
};
