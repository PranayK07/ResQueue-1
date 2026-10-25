import type { StationRow, UnitRow } from '@/lib/stdb';

/** Horizontal gap between fanned-out unit dots, and how far below the spot they sit. */
const GAP_PX = 28;
const DROP_PX = 14;

// ~10 cm at these latitudes: "the same spot" without float noise.
const spotKey = (lat: number, lon: number) => `${lat.toFixed(6)},${lon.toFixed(6)}`;

/**
 * Screen-pixel nudges for units that share a spot. Units park exactly on their
 * station, so without this the dots cover the station square and each other.
 * Positions on the map stay true; only the drawing moves by a few pixels.
 * Returns offsets keyed by unit id; units alone on their spot get none.
 */
export function unitOffsets(units: readonly UnitRow[], stations: readonly StationRow[]): Map<number, [number, number]> {
  const stationSpots = new Set(stations.map(s => spotKey(s.lat, s.lon)));
  const bySpot = new Map<string, UnitRow[]>();
  for (const u of units) {
    const key = spotKey(u.lat, u.lon);
    const group = bySpot.get(key);
    if (group) group.push(u);
    else bySpot.set(key, [u]);
  }
  const offsets = new Map<number, [number, number]>();
  for (const [key, group] of bySpot) {
    if (group.length === 1 && !stationSpots.has(key)) continue;
    const sorted = [...group].sort((a, b) => a.id - b.id);
    const mid = (sorted.length - 1) / 2;
    sorted.forEach((u, i) => offsets.set(u.id, [(i - mid) * GAP_PX, DROP_PX]));
  }
  return offsets;
}
