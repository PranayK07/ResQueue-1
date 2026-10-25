// Pure functions from snapshot rows to what the screens show. No I/O, no state:
// these work identically on simulated rows and on real SpacetimeDB rows.

import type { Feature, FeatureCollection, MultiLineString } from 'geojson';
import type { DangerLevel, FireCell, ForecastCell, Grid, HelpRequest, ResponderSnapshot, SimClock } from './types';

type LngLat = [number, number];

const M_PER_DEG_LAT = 111_320;
const mPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

// ─── Time ──────────────────────────────────────────────────────────────────

/** Live clocks (originMs set) arrive every second: extrapolate at most the 5 s the server credits per tick. */
const MAX_EXTRAPOLATE_MS = 5000;

/** Sim time now, extrapolated from the last clock row. */
export function simNow(clock: SimClock, nowMs = Date.now()) {
  if (!clock.running) return clock.simS;
  const elapsedMs = nowMs - clock.lastTickMs;
  // The simulation publishes its clock only every few seconds, so it extrapolates freely.
  if (clock.originMs === undefined) return clock.simS + (elapsedMs / 1000) * clock.speed;
  return clock.simS + (Math.min(Math.max(elapsedMs, 0), MAX_EXTRAPOLATE_MS) / 1000) * clock.speed;
}

/** Clock time (ms) for an absolute sim second: on the live clock's display origin, else now at the current speed. */
export function simToMs(clock: SimClock, s: number) {
  if (clock.originMs !== undefined) return clock.originMs + s * 1000;
  return clock.lastTickMs + ((s - clock.simS) * 1000) / clock.speed;
}

const hm = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hmTz = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
const hmsTz = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});

export const clockHM = (ms: number) => hm.format(ms);
export const clockHMTz = (ms: number) => hmTz.format(ms);
export const clockHMSTz = (ms: number) => hmsTz.format(ms);

/** "+6 min" / "−3 min" (true minus sign for legibility). */
export function formatSlack(slackS: number | null) {
  if (slackS === null) return '—';
  if (Math.abs(slackS) > 1e8) return 'No ground route';
  const m = Math.round(slackS / 60);
  if (slackS < 0 && m === 0) return '−<1 min';
  return m < 0 ? `−${Math.abs(m)} min` : `+${m} min`;
}

export function etaMinutes(etaS: number, nowS: number) {
  return Math.max(0, Math.ceil((etaS - nowS) / 60));
}

// ─── Labels ────────────────────────────────────────────────────────────────

/** "Q-018" */
export const requestCode = (id: bigint) => `Q-${String(id).padStart(3, '0')}`;

export const LEVEL_LABEL: Record<DangerLevel, string> = {
  unreachable: 'Unreachable',
  critical: 'Critical',
  high: 'High',
  moderate: 'Moderate',
  low: 'Low',
  unknown: 'Assessing',
};

const NEED_LINE: Record<string, string> = {
  mobility: 'Wheelchair / mobility',
  medical: 'Medical needs',
  oxygen: 'Oxygen',
  infant: 'Infant',
  elderly: 'Elderly',
  pets: 'Pets',
};

export const peopleLabel = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

/** Specific needs, one per line; empty if none. */
export function needLines(r: HelpRequest) {
  return r.needs
    .split(',')
    .map(n => n.trim())
    .filter(Boolean)
    .map(n => NEED_LINE[n] ?? n);
}

// ─── Queue ─────────────────────────────────────────────────────────────────

export interface QueueItem {
  request: HelpRequest;
  rank: number;
  unitId: number;
  unitCallsign: string;
  etaS: number;
  reason: string;
  /** A unit is already committed to it (en route or on scene), not just planned. */
  committed: boolean;
}

/** Station queue joined with requests and units, in rank order. */
type QueueRows = Pick<ResponderSnapshot, 'queue' | 'requests' | 'units'>;

export function queueItems(s: QueueRows): QueueItem[] {
  return s.queue
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .flatMap(q => {
      const request = s.requests.find(r => r.id === q.requestId);
      if (!request) return [];
      const unit = s.units.find(u => u.id === q.unitId);
      const committed = unit?.currentRequest === request.id;
      return [{ request, rank: q.rank, unitId: q.unitId, unitCallsign: unit?.callsign ?? 'Unassigned', etaS: q.etaS, reason: q.reason, committed }];
    });
}

/** The mission this phone's unit is committed to, if any. */
export function activeMission(s: ResponderSnapshot, items: QueueItem[]) {
  const me = s.units.find(u => u.id === s.me.unitId);
  if (!me || me.currentRequest === 0n) return null;
  return items.find(i => i.request.id === me.currentRequest) ?? null;
}

// ─── Grid geometry ─────────────────────────────────────────────────────────

export function cellIdAt(grid: Grid, lat: number, lon: number) {
  const row = Math.floor(((lat - grid.originLat) * M_PER_DEG_LAT) / grid.cellSizeM);
  const col = Math.floor(((lon - grid.originLon) * mPerDegLon(grid.originLat)) / grid.cellSizeM);
  if (row < 0 || col < 0 || row >= grid.rows || col >= grid.cols) return -1;
  return row * grid.cols + col;
}

function cellCorners(grid: Grid, cellId: number) {
  const row = Math.floor(cellId / grid.cols);
  const col = cellId % grid.cols;
  const dLat = grid.cellSizeM / M_PER_DEG_LAT;
  const dLon = grid.cellSizeM / mPerDegLon(grid.originLat);
  const s = grid.originLat + row * dLat;
  const w = grid.originLon + col * dLon;
  return { s, w, n: s + dLat, e: w + dLon };
}

/** Filled squares for a set of cells (fire area). */
export function cellsToPolygons(grid: Grid, cellIds: Iterable<number>): FeatureCollection {
  const features: Feature[] = [];
  for (const id of cellIds) {
    const { s, w, n, e } = cellCorners(grid, id);
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Outer edges of a set of cells: the boundary between inside and outside. */
export function cellsOutline(grid: Grid, cellIds: Set<number>): Feature<MultiLineString> {
  const lines: LngLat[][] = [];
  const has = (row: number, col: number) =>
    row >= 0 && col >= 0 && row < grid.rows && col < grid.cols && cellIds.has(row * grid.cols + col);
  for (const id of cellIds) {
    const row = Math.floor(id / grid.cols);
    const col = id % grid.cols;
    const { s, w, n, e } = cellCorners(grid, id);
    if (!has(row + 1, col)) lines.push([[w, n], [e, n]]);
    if (!has(row - 1, col)) lines.push([[w, s], [e, s]]);
    if (!has(row, col + 1)) lines.push([[e, s], [e, n]]);
    if (!has(row, col - 1)) lines.push([[w, s], [w, n]]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } };
}

/** Cells the fire is forecast (p10) to reach by `untilS`, including those already burning. */
export function forecastArea(fire: FireCell[], forecast: ForecastCell[], untilS: number) {
  const ids = new Set(fire.map(c => c.cellId));
  for (const c of forecast) if (c.arrivalEarlyS <= untilS) ids.add(c.cellId);
  return ids;
}

/** Centre of the cell in a set nearest to `to`: where a label about that area matters most. */
export function nearestCellPoint(grid: Grid, cellIds: Set<number>, to: LngLat): LngLat | null {
  const k = mPerDegLon(to[1]) / M_PER_DEG_LAT;
  let best: LngLat | null = null;
  let bestD = Infinity;
  for (const id of cellIds) {
    const { s, w, n, e } = cellCorners(grid, id);
    const p: LngLat = [(w + e) / 2, (s + n) / 2];
    const d = ((p[0] - to[0]) * k) ** 2 + (p[1] - to[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

export function centroid(grid: Grid, cellIds: Iterable<number>): LngLat | null {
  let lat = 0;
  let lon = 0;
  let count = 0;
  for (const id of cellIds) {
    const { s, w, n, e } = cellCorners(grid, id);
    lat += (s + n) / 2;
    lon += (w + e) / 2;
    count++;
  }
  return count ? [lon / count, lat / count] : null;
}

// ─── Route exposure ────────────────────────────────────────────────────────

export type Exposure = 'lower' | 'elevated' | 'highest';

/** Fire within this many minutes of when the crew passes → that exposure class. */
const HIGHEST_WITHIN_S = 15 * 60;
const ELEVATED_WITHIN_S = 45 * 60;

/**
 * Split a route into runs by exposure: how close (p10) fire arrival is to the
 * moment the unit passes each point, assuming constant speed from `departS`
 * to `arriveS`.
 */
export function routeExposure(
  coords: LngLat[],
  departS: number,
  arriveS: number,
  grid: Grid,
  fire: FireCell[],
  forecast: ForecastCell[]
): { exposure: Exposure; coords: LngLat[] }[] {
  if (coords.length < 2) return [];
  const burning = new Set(fire.map(c => c.cellId));
  const arrival = new Map(forecast.map(c => [c.cellId, c.arrivalEarlyS]));

  const segLen = coords.slice(1).map((p, i) => Math.hypot((p[1] - coords[i][1]) * M_PER_DEG_LAT, (p[0] - coords[i][0]) * mPerDegLon(p[1])));
  const total = segLen.reduce((a, b) => a + b, 0) || 1;

  const classify = (p: LngLat, passS: number): Exposure => {
    const cell = cellIdAt(grid, p[1], p[0]);
    if (burning.has(cell)) return 'highest';
    const fireAt = arrival.get(cell);
    if (fireAt === undefined) return 'lower';
    const margin = fireAt - passS;
    return margin < HIGHEST_WITHIN_S ? 'highest' : margin < ELEVATED_WITHIN_S ? 'elevated' : 'lower';
  };

  const runs: { exposure: Exposure; coords: LngLat[] }[] = [];
  let travelled = 0;
  for (let i = 0; i < segLen.length; i++) {
    const mid: LngLat = [(coords[i][0] + coords[i + 1][0]) / 2, (coords[i][1] + coords[i + 1][1]) / 2];
    const passS = departS + ((travelled + segLen[i] / 2) / total) * (arriveS - departS);
    const exposure = classify(mid, passS);
    const last = runs[runs.length - 1];
    if (last?.exposure === exposure) last.coords.push(coords[i + 1]);
    else runs.push({ exposure, coords: [coords[i], coords[i + 1]] });
    travelled += segLen[i];
  }
  return runs;
}
