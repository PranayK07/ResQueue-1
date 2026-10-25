// Road route + turn-by-turn steps, via the public OSRM demo server
// (OpenStreetMap roads, no key; light use only). Advisory: it doesn't know
// about closures or fire. Falls back to a straight line if unavailable.
//
// This is the one place to swap in another routing engine (e.g. Google
// Directions API with a key); everything else consumes `Route`.

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
  coords: LngLat[];
  distanceM: number;
  durationS: number;
  steps: RouteStep[];
  /** Longest named road on the route, for the "via" label. Empty if unknown. */
  via: string;
  /** False when we fell back to a straight line. */
  onRoads: boolean;
}

const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const cache = new Map<string, Promise<Route>>();

interface OsrmStep {
  name: string;
  distance: number;
  duration: number;
  maneuver: { type: string; modifier?: string; location: LngLat; bearing_after?: number; exit?: number };
}

interface OsrmResponse {
  code: string;
  routes: {
    distance: number;
    duration: number;
    geometry: { coordinates: LngLat[] };
    legs: { steps: OsrmStep[] }[];
  }[];
}

const M_PER_DEG = 111_320;
export function metersBetween(a: LngLat, b: LngLat) {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * M_PER_DEG * k, (a[1] - b[1]) * M_PER_DEG);
}

function straight(from: LngLat, to: LngLat): Route {
  const d = metersBetween(from, to);
  return {
    coords: [from, to],
    distanceM: d,
    durationS: d / 11,
    steps: [
      { type: 'depart', modifier: '', name: '', distanceM: d, durationS: d / 11, location: from, bearingAfter: 0, exit: null, startM: 0 },
      { type: 'arrive', modifier: '', name: '', distanceM: 0, durationS: 0, location: to, bearingAfter: 0, exit: null, startM: d },
    ],
    via: '',
    onRoads: false,
  };
}

export function fetchRoute(from: LngLat, to: LngLat): Promise<Route> {
  // ~10 m precision is plenty and keeps the cache effective.
  const key = [...from, ...to].map(v => v.toFixed(4)).join(',');
  let route = cache.get(key);
  if (!route) {
    route = fetch(`${OSRM}/${from.join(',')};${to.join(',')}?overview=full&geometries=geojson&steps=true`, { signal: AbortSignal.timeout(10_000) })
      .then(res => (res.ok ? (res.json() as Promise<OsrmResponse>) : Promise.reject(new Error(String(res.status)))))
      .then(data => {
        const r = data.routes[0];
        if (data.code !== 'Ok' || !r) return straight(from, to);
        const raw = r.legs.flatMap(l => l.steps);
        let along = 0;
        const steps: RouteStep[] = raw.map(s => {
          const step = {
            type: s.maneuver.type,
            modifier: s.maneuver.modifier ?? '',
            name: s.name,
            distanceM: s.distance,
            durationS: s.duration,
            location: s.maneuver.location,
            bearingAfter: s.maneuver.bearing_after ?? 0,
            exit: s.maneuver.exit ?? null,
            startM: along,
          };
          along += s.distance;
          return step;
        });
        const byName = new Map<string, number>();
        for (const s of raw) if (s.name) byName.set(s.name, (byName.get(s.name) ?? 0) + s.distance);
        const via = [...byName.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
        return { coords: r.geometry.coordinates, distanceM: r.distance, durationS: r.duration, steps, via, onRoads: true };
      })
      .catch(() => {
        cache.delete(key); // retry next time
        return straight(from, to);
      });
    cache.set(key, route);
  }
  return route;
}
