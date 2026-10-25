type Point = [number, number];
type Trip = { fromLat: number; fromLon: number; toLat: number; toLon: number; departS: number; arriveS: number; route?: { coords: Point[] } };
type Vehicle = { lat: number; lon: number; status: string; trip?: Trip | null };
const geometry = new WeakMap<Trip, { points: Point[]; distances: number[]; total: number }>();

/** Sample a fixed, shared leg using the replay clock. Marker and attached title use the same position. */
export function vehiclePositionAt(unit: Vehicle, nowS: number): Point {
  const trip = unit.trip;
  if (!trip || !['en_route', 'returning'].includes(unit.status)) return [unit.lon, unit.lat];
  let path = geometry.get(trip);
  if (!path) {
    const points = trip.route?.coords.length ? trip.route.coords : [[trip.fromLon, trip.fromLat], [trip.toLon, trip.toLat]] as Point[];
    const distances = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      distances.push(distances[i - 1] + Math.hypot((b[0] - a[0]) * Math.cos((a[1] + b[1]) * Math.PI / 360), b[1] - a[1]));
    }
    path = { points, distances, total: distances.at(-1)! };
    geometry.set(trip, path);
  }
  const fraction = Math.max(0, Math.min(1, (nowS - trip.departS) / Math.max(1, trip.arriveS - trip.departS)));
  const target = fraction * path.total;
  let lo = 0, hi = path.distances.length - 1;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (path.distances[mid] < target) lo = mid + 1; else hi = mid; }
  if (lo === 0) return path.points[0];
  const a = path.points[lo - 1], b = path.points[lo];
  const f = (target - path.distances[lo - 1]) / Math.max(Number.EPSILON, path.distances[lo] - path.distances[lo - 1]);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

export function vehicleStatus(unit: Vehicle, nowS: number): string {
  if (unit.status === 'assigned') return 'Preparing route';
  if (unit.status === 'on_scene') return 'On scene · extraction';
  if (unit.status === 'en_route' || unit.status === 'returning') {
    const minutes = Math.max(0, Math.ceil(((unit.trip?.arriveS ?? nowS) - nowS) / 60));
    return `${unit.status === 'returning' ? 'Returning' : 'Approaching'} · ${minutes} min`;
  }
  return unit.status === 'available' ? 'Available' : 'Out of service';
}
