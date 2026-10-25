// GeoJSON builders for the map layers: fire, forecast bands, the incident
// area, closures and pins. Ids that are u64 go into properties as strings.
import type { Feature, FeatureCollection, Geometry, LineString, Point, Polygon } from 'geojson';
import type { FireCellRow, ForecastCellRow, OpsQueueRow, OpsRequestRow, RoadClosureRow, StationRow, UnitRow } from '@/lib/stdb/rows';
import { minsFromNow } from '@/lib/time/sim';
import { cellPolygon, gridBounds, type GridGeom } from './grid';

export type ForecastBand = 'lt30' | '30to60' | 'gt60';

/** Spec 4.2: under 30 min, 30 to 60, over 60. */
export function forecastBand(minutes: number): ForecastBand {
  if (minutes < 30) return 'lt30';
  return minutes <= 60 ? '30to60' : 'gt60';
}

const collection = <G extends Geometry, P>(features: Feature<G, P>[]): FeatureCollection<G, P> => ({
  type: 'FeatureCollection',
  features,
});

export function fireLayer(cells: readonly FireCellRow[], g: GridGeom) {
  return collection<Polygon, { cellId: number; intensity: number }>(
    cells.map(c => ({
      type: 'Feature',
      id: c.cellId,
      geometry: { type: 'Polygon', coordinates: [cellPolygon(c.cellId, g)] },
      properties: { cellId: c.cellId, intensity: c.intensity },
    }))
  );
}

/** Bands from arrivalEarlyS (p10, what the plan uses) minus sim now. */
export function forecastLayer(cells: readonly ForecastCellRow[], g: GridGeom, simNow: number) {
  return collection<Polygon, { cellId: number; minutes: number; band: ForecastBand }>(
    cells.map(c => {
      const minutes = minsFromNow(c.arrivalEarlyS, simNow);
      return {
        type: 'Feature',
        id: c.cellId,
        geometry: { type: 'Polygon', coordinates: [cellPolygon(c.cellId, g)] },
        properties: { cellId: c.cellId, minutes, band: forecastBand(minutes) },
      };
    })
  );
}

export function gridOutlineLayer(g: GridGeom) {
  const b = gridBounds(g);
  return collection<Polygon, Record<string, never>>([
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [b.west, b.south],
            [b.east, b.south],
            [b.east, b.north],
            [b.west, b.north],
            [b.west, b.south],
          ],
        ],
      },
      properties: {},
    },
  ]);
}

/** Active closures only: a straight segment, not snapped to roads. */
export function closuresLayer(closures: readonly RoadClosureRow[]) {
  return collection<LineString, { id: string; name: string; source: string }>(
    closures
      .filter(c => c.active)
      .map(c => ({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [c.lon1, c.lat1],
            [c.lon2, c.lat2],
          ],
        },
        properties: { id: String(c.id), name: c.name, source: c.source },
      }))
  );
}

export function stationsLayer(stations: readonly StationRow[]) {
  return collection<Point, { id: number; name: string }>(
    stations.map(s => ({
      type: 'Feature',
      id: s.id,
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { id: s.id, name: s.name },
    }))
  );
}

export function unitsLayer(units: readonly UnitRow[]) {
  return collection<Point, { id: number; callsign: string; status: string; stationId: number }>(
    units.map(u => ({
      type: 'Feature',
      id: u.id,
      geometry: { type: 'Point', coordinates: [u.lon, u.lat] },
      properties: { id: u.id, callsign: u.callsign, status: u.status, stationId: u.stationId },
    }))
  );
}

export type RequestPinProps = {
  id: string;
  level: string;
  status: string;
  /** Rank in its station's line, 0 while not queued. */
  rank: number;
  stationId: number;
  pinned: boolean;
};

/** Request pins. Rows whose location was purged are skipped (lat/lon are 0). */
export function requestsLayer(requests: readonly OpsRequestRow[], queue: readonly OpsQueueRow[]) {
  const byRequest = new Map(queue.map(q => [String(q.requestId), q]));
  return collection<Point, RequestPinProps>(
    requests
      .filter(r => !r.locationPurged)
      .map(r => {
        const q = byRequest.get(String(r.id));
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
          properties: {
            id: String(r.id),
            level: r.level,
            status: r.status,
            rank: q?.rank ?? 0,
            stationId: q?.stationId ?? 0,
            pinned: r.pinnedStationId !== 0,
          },
        };
      })
  );
}
