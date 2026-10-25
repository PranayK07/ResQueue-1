import type { StationRow } from '@/lib/stdb';

/** A station's name from the live station table. Never a hardcoded name. */
export function stationName(stations: readonly Pick<StationRow, 'id' | 'name'>[], id: number): string {
  return stations.find(s => s.id === id)?.name ?? 'Unknown station';
}
