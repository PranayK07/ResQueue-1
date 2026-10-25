// Grid math, mirroring insideGrid() in spacetimedb/src/index.ts.
// cellId = row * cols + col. Row 0 is the south edge; the origin is the SW corner.
import type { GridRow } from '@/lib/stdb/rows';

export type GridGeom = Pick<GridRow, 'originLat' | 'originLon' | 'cellSizeM' | 'rows' | 'cols'>;
export type LatLon = { lat: number; lon: number };
export type Bounds = { south: number; west: number; north: number; east: number };
/** GeoJSON position, [lon, lat]. */
export type Position = [number, number];

const M_PER_DEG_LAT = 111_320;

const cosLat = (g: GridGeom) => Math.cos((g.originLat * Math.PI) / 180);
const cellDLat = (g: GridGeom) => g.cellSizeM / M_PER_DEG_LAT;
const cellDLon = (g: GridGeom) => g.cellSizeM / (M_PER_DEG_LAT * cosLat(g));

/** False until a scenario is loaded (the module starts with an all-zero grid). */
export function hasScenario(g: GridGeom | undefined): g is GridGeom {
  return !!g && g.rows > 0 && g.cols > 0 && g.cellSizeM > 0;
}

/** Incident area. Same expressions as the module, so edges agree exactly. */
export function gridBounds(g: GridGeom): Bounds {
  const dLat = (g.rows * g.cellSizeM) / M_PER_DEG_LAT;
  const dLon = (g.cols * g.cellSizeM) / (M_PER_DEG_LAT * cosLat(g));
  return { south: g.originLat, west: g.originLon, north: g.originLat + dLat, east: g.originLon + dLon };
}

/**
 * Same answer as the module. Like the module, it accepts any point while no
 * scenario is loaded, so screens must check hasScenario() themselves.
 */
export function insideGrid(lat: number, lon: number, g: GridGeom | undefined): boolean {
  if (!g || g.rows === 0) return true;
  const b = gridBounds(g);
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

export function cellRowCol(cellId: number, g: GridGeom): { row: number; col: number } {
  return { row: Math.floor(cellId / g.cols), col: cellId % g.cols };
}

export function cellBounds(cellId: number, g: GridGeom): Bounds {
  const { row, col } = cellRowCol(cellId, g);
  const south = g.originLat + row * cellDLat(g);
  const west = g.originLon + col * cellDLon(g);
  return { south, west, north: south + cellDLat(g), east: west + cellDLon(g) };
}

export function cellCenter(cellId: number, g: GridGeom): LatLon {
  const b = cellBounds(cellId, g);
  return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
}

/** Closed GeoJSON ring, counter-clockwise from the SW corner. */
export function cellPolygon(cellId: number, g: GridGeom): Position[] {
  const b = cellBounds(cellId, g);
  return [
    [b.west, b.south],
    [b.east, b.south],
    [b.east, b.north],
    [b.west, b.north],
    [b.west, b.south],
  ];
}

/** The cell containing a point, or undefined outside the grid. */
export function cellIdAt(lat: number, lon: number, g: GridGeom): number | undefined {
  if (!hasScenario(g)) return undefined;
  const row = Math.floor((lat - g.originLat) / cellDLat(g));
  const col = Math.floor((lon - g.originLon) / cellDLon(g));
  if (row < 0 || col < 0 || row >= g.rows || col >= g.cols) return undefined;
  return row * g.cols + col;
}

/** A point at fractions (0..1) of the grid's width and height, from the SW corner. */
export function pointAt(fx: number, fy: number, g: GridGeom): LatLon {
  const b = gridBounds(g);
  return { lat: b.south + fy * (b.north - b.south), lon: b.west + fx * (b.east - b.west) };
}

/** [[west, south], [east, north]], the shape MapLibre's fitBounds takes. */
export function toLngLatBounds(b: Bounds): [Position, Position] {
  return [
    [b.west, b.south],
    [b.east, b.north],
  ];
}
