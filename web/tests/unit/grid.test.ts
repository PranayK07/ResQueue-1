import { describe, expect, it } from 'vitest';
import {
  cellBounds,
  cellCenter,
  cellIdAt,
  cellPolygon,
  cellRowCol,
  gridBounds,
  hasScenario,
  insideGrid,
  pointAt,
} from '@/lib/geo/grid';

const g = { originLat: 39.7, originLon: -121.68, cellSizeM: 300, rows: 60, cols: 80 };
// The module's insideGrid math, written out independently.
const dLat = (g.rows * g.cellSizeM) / 111_320;
const dLon = (g.cols * g.cellSizeM) / (111_320 * Math.cos((g.originLat * Math.PI) / 180));
const empty = { originLat: 0, originLon: 0, cellSizeM: 0, rows: 0, cols: 0 };

describe('grid', () => {
  it('matches the module bounds exactly', () => {
    expect(gridBounds(g)).toEqual({ south: 39.7, west: -121.68, north: 39.7 + dLat, east: -121.68 + dLon });
  });

  it('insideGrid accepts the edges and rejects points just outside', () => {
    expect(insideGrid(39.7, -121.68, g)).toBe(true);
    expect(insideGrid(39.7 + dLat, -121.68 + dLon, g)).toBe(true);
    expect(insideGrid(39.7 - 1e-9, -121.6, g)).toBe(false);
    expect(insideGrid(39.8, -121.68 + dLon + 1e-9, g)).toBe(false);
    expect(insideGrid(Number.NaN, -121.6, g)).toBe(false);
  });

  it('insideGrid accepts anything while no scenario is loaded, like the module', () => {
    expect(hasScenario(empty)).toBe(false);
    expect(hasScenario(undefined)).toBe(false);
    expect(insideGrid(0, 0, empty)).toBe(true);
    expect(insideGrid(0, 0, undefined)).toBe(true);
    expect(hasScenario(g)).toBe(true);
  });

  it('numbers cells row * cols + col with row 0 on the south edge', () => {
    expect(cellRowCol(0, g)).toEqual({ row: 0, col: 0 });
    expect(cellRowCol(81, g)).toEqual({ row: 1, col: 1 });
    expect(cellBounds(0, g).south).toBe(39.7);
    expect(cellBounds(80, g).south).toBeGreaterThan(cellBounds(0, g).south);
    expect(cellBounds(1, g).west).toBeGreaterThan(cellBounds(0, g).west);
  });

  it('cells tile the grid: the last cell ends at the grid corner', () => {
    const last = cellBounds(g.rows * g.cols - 1, g);
    const b = gridBounds(g);
    expect(last.north).toBeCloseTo(b.north, 9);
    expect(last.east).toBeCloseTo(b.east, 9);
  });

  it('cellIdAt inverts cellCenter and rejects points outside', () => {
    for (const id of [0, 79, 80, 2345, g.rows * g.cols - 1]) {
      const c = cellCenter(id, g);
      expect(cellIdAt(c.lat, c.lon, g)).toBe(id);
    }
    expect(cellIdAt(39.69, -121.6, g)).toBeUndefined();
    expect(cellIdAt(39.7, -121.6, empty)).toBeUndefined();
  });

  it('cellPolygon is a closed counter-clockwise ring in [lon, lat]', () => {
    const ring = cellPolygon(0, g);
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    expect(ring[0]).toEqual([-121.68, 39.7]);
    expect(ring[1]![0]).toBeGreaterThan(ring[0]![0]);
    expect(ring[2]![1]).toBeGreaterThan(ring[1]![1]);
  });

  it('pointAt maps fractions of the incident area', () => {
    expect(pointAt(0, 0, g)).toEqual({ lat: 39.7, lon: -121.68 });
    const mid = pointAt(0.5, 0.5, g);
    expect(mid.lat).toBeCloseTo(39.7 + dLat / 2, 12);
    expect(mid.lon).toBeCloseTo(-121.68 + dLon / 2, 12);
    expect(insideGrid(mid.lat, mid.lon, g)).toBe(true);
  });
});
