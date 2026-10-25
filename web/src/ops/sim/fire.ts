// Simplified wind-driven fire spread (stand-in for the hazard agent).
// Spread from a point is an ellipse stretched downwind; rates scale with wind
// speed and drier air. Forecast = earliest arrival from any burning perimeter
// cell; p10 is a fixed fraction earlier than the median.

import type { Grid } from '../types';
import { M_PER_DEG_LAT, M_PER_DEG_LON } from './scenario';

export interface FireWeather {
  windSpeedMps: number;
  windFromDeg: number;
  gustMps: number;
  includeGusts: boolean;
  includeHumidity: boolean;
  humidityPct: number;
}

export const P10_FACTOR = 0.85;

interface Rates {
  head: number;
  flank: number;
  back: number;
  /** Unit vector the fire runs toward (east, north). */
  ux: number;
  uy: number;
}

export function spreadRates(w: FireWeather): Rates {
  const wind = w.windSpeedMps + (w.includeGusts ? 0.3 * Math.max(0, w.gustMps - w.windSpeedMps) : 0);
  const dryness = w.includeHumidity ? Math.min(1.4, Math.max(0.7, 1 + (30 - w.humidityPct) / 100)) : 1;
  const toward = ((w.windFromDeg + 180) * Math.PI) / 180;
  return {
    head: (0.25 + 0.08 * wind) * dryness,
    flank: (0.2 + 0.02 * wind) * dryness,
    back: 0.1 * dryness,
    ux: Math.sin(toward),
    uy: Math.cos(toward),
  };
}

/** Seconds for the median fire front to get from `a` to `b`. */
function travel(aLat: number, aLon: number, bLat: number, bLon: number, r: Rates) {
  const dx = (bLon - aLon) * M_PER_DEG_LON;
  const dy = (bLat - aLat) * M_PER_DEG_LAT;
  const along = dx * r.ux + dy * r.uy;
  const cross = Math.abs(dx * r.uy - dy * r.ux);
  return Math.hypot(along / (along >= 0 ? r.head : r.back), cross / r.flank);
}

export function cellCenter(grid: Grid, id: number) {
  const row = Math.floor(id / grid.cols);
  const col = id % grid.cols;
  return {
    lat: grid.originLat + ((row + 0.5) * grid.cellSizeM) / M_PER_DEG_LAT,
    lon: grid.originLon + ((col + 0.5) * grid.cellSizeM) / M_PER_DEG_LON,
  };
}

export function cellAt(grid: Grid, lat: number, lon: number) {
  const row = Math.floor(((lat - grid.originLat) * M_PER_DEG_LAT) / grid.cellSizeM);
  const col = Math.floor(((lon - grid.originLon) * M_PER_DEG_LON) / grid.cellSizeM);
  if (row < 0 || col < 0 || row >= grid.rows || col >= grid.cols) return -1;
  return row * grid.cols + col;
}

/** Median arrival (absolute sim s) for every cell, from a single ignition point. */
export function forecastFromPoint(grid: Grid, lat: number, lon: number, ignitedS: number, w: FireWeather) {
  const r = spreadRates(w);
  const out = new Float64Array(grid.rows * grid.cols);
  for (let id = 0; id < out.length; id++) {
    const c = cellCenter(grid, id);
    out[id] = ignitedS + travel(lat, lon, c.lat, c.lon, r);
  }
  return out;
}

/**
 * Median arrival for every unburnt cell, re-forecast from the current
 * perimeter (burning cells with an unburnt neighbour). Burning cells keep
 * their ignition time.
 */
export function forecastFromPerimeter(grid: Grid, burning: Map<number, number>, nowS: number, w: FireWeather) {
  const r = spreadRates(w);
  const perimeter: { lat: number; lon: number }[] = [];
  for (const id of burning.keys()) {
    const row = Math.floor(id / grid.cols);
    const col = id % grid.cols;
    const edge = [
      [row + 1, col],
      [row - 1, col],
      [row, col + 1],
      [row, col - 1],
    ].some(([rr, cc]) => rr >= 0 && cc >= 0 && rr < grid.rows && cc < grid.cols && !burning.has(rr * grid.cols + cc));
    if (edge) perimeter.push(cellCenter(grid, id));
  }
  const out = new Float64Array(grid.rows * grid.cols);
  for (let id = 0; id < out.length; id++) {
    const ignited = burning.get(id);
    if (ignited !== undefined) {
      out[id] = ignited;
      continue;
    }
    const c = cellCenter(grid, id);
    let best = Infinity;
    for (const p of perimeter) best = Math.min(best, travel(p.lat, p.lon, c.lat, c.lon, r));
    out[id] = nowS + best;
  }
  return out;
}

/** p10 (earliest-10%) arrival from a median arrival. */
export const p10 = (medianS: number, nowS: number) => (medianS <= nowS ? medianS : nowS + (medianS - nowS) * P10_FACTOR);
