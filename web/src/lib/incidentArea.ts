import { coordsPlace } from './geo';
import type { CallerLocation } from './request';
import type { Grid } from '../ops/types';

export type IncidentArea = Pick<Grid, 'originLat' | 'originLon' | 'rows' | 'cols' | 'cellSizeM'>;
type Point = { lat: number; lon: number };

export function validIncidentArea(area: IncidentArea | null | undefined): area is IncidentArea {
  return !!area && [area.originLat, area.originLon, area.cellSizeM, area.rows, area.cols].every(Number.isFinite)
    && area.cellSizeM > 0 && area.rows > 0 && area.cols > 0;
}

/** The same incident rectangle accepted by the request reducers; this is not the fire perimeter. */
export function insideIncidentArea(area: IncidentArea | null | undefined, point: Point): boolean {
  if (!validIncidentArea(area) || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return false;
  const north = area.originLat + area.rows * area.cellSizeM / 111_320;
  const east = area.originLon + area.cols * area.cellSizeM / (111_320 * Math.cos(area.originLat * Math.PI / 180));
  return point.lat >= area.originLat && point.lat <= north && point.lon >= area.originLon && point.lon <= east;
}

/** A stable starting pin near the acquired perimeter, or inside the grid while fire data loads. No GPS. */
export function defaultIncidentLocation(area: IncidentArea | null | undefined, fire: readonly { cellId: number }[], seed = 0.5): CallerLocation | null {
  if (!validIncidentArea(area)) return null;
  const burning = new Set(fire.map(c => c.cellId));
  const at = (cellId: number): CallerLocation => {
    const row = Math.floor(cellId / area.cols), col = cellId % area.cols;
    const lat = area.originLat + (row + 0.5) * area.cellSizeM / 111_320;
    const lon = area.originLon + (col + 0.5) * area.cellSizeM / (111_320 * Math.cos(area.originLat * Math.PI / 180));
    return { ...coordsPlace(lat, lon), entrance: '' };
  };
  const offset = Math.floor((Number.isFinite(seed) ? Math.max(0, Math.min(seed, 1 - Number.EPSILON)) : 0.5) * fire.length);
  for (let i = 0; i < fire.length; i++) {
    const source = fire[(offset + i) % fire.length].cellId;
    for (const [dr, dc] of [[6, 0], [0, 6], [-6, 0], [0, -6], [8, 8]]) {
      const row = Math.floor(source / area.cols) + dr, col = source % area.cols + dc;
      if (row < 0 || row >= area.rows || col < 0 || col >= area.cols || burning.has(row * area.cols + col)) continue;
      return at(row * area.cols + col);
    }
  }
  const center = Math.floor(area.rows / 2) * area.cols + Math.floor(area.cols / 2);
  for (let i = 0; i < area.rows * area.cols; i++) {
    const cell = (center + i) % (area.rows * area.cols);
    if (!burning.has(cell)) return at(cell);
  }
  return at(center);
}
