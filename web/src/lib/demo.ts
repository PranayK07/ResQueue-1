import { coordsPlace } from './geo';
import type { CallerLocation } from './request';
import type { RowOf } from '../live/tables';

/** A fictional caller near the current perimeter. Never reads device geolocation. */
export function demoLocation(grid: RowOf<'grid'>, fire: readonly RowOf<'fire_cell'>[], seed: number): CallerLocation | null {
  if (!grid.rows || !grid.cols || !fire.length) return null;
  const burning = new Set(fire.map(c => c.cellId));
  for (let i = 0; i < fire.length; i++) {
    const source = fire[(Math.floor(seed * fire.length) + i) % fire.length].cellId;
    for (const [dr, dc] of [[6, 0], [0, 6], [-6, 0], [0, -6], [8, 8]]) {
      const row = Math.floor(source / grid.cols) + dr;
      const col = source % grid.cols + dc;
      if (row < 0 || row >= grid.rows || col < 0 || col >= grid.cols || burning.has(row * grid.cols + col)) continue;
      const lat = grid.originLat + (row + 0.5) * grid.cellSizeM / 111_320;
      const lon = grid.originLon + (col + 0.5) * grid.cellSizeM / (111_320 * Math.cos(grid.originLat * Math.PI / 180));
      return { ...coordsPlace(lat, lon), entrance: '' };
    }
  }
  return null;
}
