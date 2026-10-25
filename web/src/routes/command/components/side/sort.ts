// Display order for the side rail. Ids are never a sort key: they are
// auto-increment with gaps and say nothing about time.
import type { EventLogRow, OpsFlagRow, RoadClosureRow } from '@/lib/stdb';

/** Descending bigint compare without converting to number. */
const desc = (a: bigint, b: bigint): number => (a === b ? 0 : a > b ? -1 : 1);

/** event_log newest first: by `at`, then by `simS`. */
export function eventsNewestFirst(events: readonly EventLogRow[]): EventLogRow[] {
  return [...events].sort(
    (a, b) => desc(a.at.microsSinceUnixEpoch, b.at.microsSinceUnixEpoch) || b.simS - a.simS
  );
}

/** Unresolved flags, newest `createdAt` first. */
export function openFlagsNewestFirst(flags: readonly OpsFlagRow[]): OpsFlagRow[] {
  return flags
    .filter(f => !f.resolved)
    .sort((a, b) => desc(a.createdAt.microsSinceUnixEpoch, b.createdAt.microsSinceUnixEpoch));
}

/** Active closures first, then by name. */
export function closuresInOrder(closures: readonly RoadClosureRow[]): RoadClosureRow[] {
  return [...closures].sort(
    (a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || a.name.localeCompare(b.name)
  );
}
