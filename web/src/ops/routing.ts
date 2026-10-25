// Road route from a unit to a request, via the public OSRM demo server
// (OpenStreetMap roads, no key; light use only). Advisory: it doesn't know
// about closures or fire. Falls back to a straight line if unavailable.

type LngLat = [number, number];

export interface Route {
  coords: LngLat[];
  distanceM: number;
  /** Longest named road on the route, for the "via" label. Empty if unknown. */
  via: string;
  /** False when we fell back to a straight line. */
  onRoads: boolean;
}

const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const cache = new Map<string, Promise<Route>>();

interface OsrmResponse {
  code: string;
  routes: {
    distance: number;
    geometry: { coordinates: LngLat[] };
    legs: { steps: { name: string; distance: number }[] }[];
  }[];
}

function straight(from: LngLat, to: LngLat): Route {
  return { coords: [from, to], distanceM: 0, via: '', onRoads: false };
}

export function fetchRoute(from: LngLat, to: LngLat): Promise<Route> {
  // ~10 m precision is plenty and keeps the cache effective.
  const key = [...from, ...to].map(v => v.toFixed(4)).join(',');
  let route = cache.get(key);
  if (!route) {
    route = fetch(`${OSRM}/${from.join(',')};${to.join(',')}?overview=full&geometries=geojson&steps=true`)
      .then(res => (res.ok ? (res.json() as Promise<OsrmResponse>) : Promise.reject(new Error(String(res.status)))))
      .then(data => {
        const r = data.routes[0];
        if (data.code !== 'Ok' || !r) return straight(from, to);
        const byName = new Map<string, number>();
        for (const step of r.legs.flatMap(l => l.steps)) {
          if (step.name) byName.set(step.name, (byName.get(step.name) ?? 0) + step.distance);
        }
        const via = [...byName.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
        return { coords: r.geometry.coordinates, distanceM: r.distance, via, onRoads: true };
      })
      .catch(() => {
        cache.delete(key); // retry next time
        return straight(from, to);
      });
    cache.set(key, route);
  }
  return route;
}
