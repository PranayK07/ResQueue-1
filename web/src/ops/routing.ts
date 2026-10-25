// Shared OSM road routing. Unavailable or blocked routes never become straight-line driving directions.
import { roadRoute, unavailable, type RoadContext, type RoadGraph, type RoadPoint } from './roadGraph.mjs';
type LngLat = [number, number];

export interface RouteStep {
  /** OSRM maneuver type: depart, turn, new name, continue, merge, fork, end of road, roundabout, arrive, … */
  type: string;
  /** left, right, slight left, sharp right, straight, uturn, … */
  modifier: string;
  /** Road the step travels on. */
  name: string;
  distanceM: number;
  durationS: number;
  /** Where the maneuver happens. */
  location: LngLat;
  bearingAfter: number;
  /** Roundabout exit number, if any. */
  exit: number | null;
  /** Distance along the route where this step starts. */
  startM: number;
}

export interface Route {
  points?: RoadPoint[];
  reason?: string;
  coords: LngLat[];
  distanceM: number;
  durationS: number;
  steps: RouteStep[];
  /** Longest named road on the route, for the "via" label. Empty if unknown. */
  via: string;
  /** False when no road route can be provided; coordinates are empty. */
  onRoads: boolean;
}

let context: RoadContext = {};
let revision = '';
let graphPromise: Promise<RoadGraph> | null = null;
const cache = new Map<string, Promise<Route>>();
export function configureRouting(next: RoadContext) {
  const key = JSON.stringify([next.grid, next.fireCells?.map(c => c.cellId), next.closures?.filter(c => c.active).map(c => [c.lat1, c.lon1, c.lat2, c.lon2])]);
  if (key !== revision) { revision = key; context = next; cache.clear(); }
}
export function metersBetween(a: LngLat, b: LngLat) {
  return Math.hypot((a[0] - b[0]) * 111320 * Math.cos((a[1] + b[1]) * Math.PI / 360), (a[1] - b[1]) * 111320);
}
export function fetchRoute(from: LngLat, to: LngLat): Promise<Route> {
  const key = [...from, ...to].map(v => v.toFixed(5)).join(',') + revision;
  let cached = cache.get(key);
  if (!cached) {
    graphPromise ??= fetch(`${import.meta.env.BASE_URL}replay/roads.json`, { signal: AbortSignal.timeout(10000) })
      .then(r => { if (!r.ok) throw new Error('Road network unavailable'); return r.json() as Promise<RoadGraph>; });
    const snapshot = context;
    cached = graphPromise.then(graph => roadRoute(graph, from, to, snapshot)).catch(() => { graphPromise = null; cache.delete(key); return unavailable('Road network unavailable. No driving route has been assumed.'); });
    cache.set(key, cached);
  }
  return cached;
}
