// Turn-by-turn guidance over a `Route`: where the vehicle is along it, which
// maneuver is next, and how to say it. Pure functions.

import { metersBetween, type Route, type RouteStep } from './routing';

type LngLat = [number, number];

export interface Progress {
  /** Distance travelled along the route (m). */
  alongM: number;
  /** Distance from the position to the route line (m). */
  offRouteM: number;
  /** Index of the next maneuver to perform. */
  nextStep: number;
  /** Distance to that maneuver (m). */
  toNextM: number;
  remainingM: number;
  /** The position snapped onto the route. */
  snapped: LngLat;
}

/** Snap a position onto the route and work out the next maneuver. */
export function progressAlong(route: Route, pos: LngLat): Progress {
  const k = Math.cos((pos[1] * Math.PI) / 180);
  let best = { d: Infinity, along: 0, point: route.coords[0] };
  let travelled = 0;
  for (let i = 0; i < route.coords.length - 1; i++) {
    const a = route.coords[i];
    const b = route.coords[i + 1];
    const ax = (a[0] - pos[0]) * k;
    const ay = a[1] - pos[1];
    const bx = (b[0] - pos[0]) * k;
    const by = b[1] - pos[1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const point: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const d = metersBetween(point, pos);
    const seg = metersBetween(a, b);
    if (d < best.d) best = { d, along: travelled + seg * t, point };
    travelled += seg;
  }
  // Scale geometric distance to OSRM's own metres so step offsets line up.
  const along = travelled ? (best.along / travelled) * route.distanceM : 0;
  let nextStep = route.steps.findIndex(s => s.startM > along + 1);
  if (nextStep < 0) nextStep = route.steps.length - 1;
  return {
    alongM: along,
    offRouteM: best.d,
    nextStep,
    toNextM: Math.max(0, route.steps[nextStep].startM - along),
    remainingM: Math.max(0, route.distanceM - along),
    snapped: best.point,
  };
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

/** Spoken-style instruction for a maneuver. */
export function instruction(step: RouteStep, destination: string) {
  const onto = step.name ? ` onto ${step.name}` : '';
  const mod = step.modifier === 'uturn' ? 'U-turn' : step.modifier;
  switch (step.type) {
    case 'depart':
      return `Head ${COMPASS[Math.round(step.bearingAfter / 45) % 8]}${step.name ? ` on ${step.name}` : ''}`;
    case 'arrive':
      return `Arrive at ${destination}${step.modifier === 'left' || step.modifier === 'right' ? `, on the ${step.modifier}` : ''}`;
    case 'turn':
      return mod === 'U-turn' ? `Make a U-turn${onto}` : `Turn ${mod}${onto}`;
    case 'new name':
      return `Continue${onto}`;
    case 'continue':
      return mod && mod !== 'straight' ? `Bear ${mod}${step.name ? ` to stay on ${step.name}` : ''}` : `Continue straight${step.name ? ` on ${step.name}` : ''}`;
    case 'end of road':
      return `At the end of the road, turn ${mod}${onto}`;
    case 'fork':
      return `Keep ${mod} at the fork${onto}`;
    case 'merge':
      return `Merge ${mod}${onto}`;
    case 'on ramp':
      return `Take the ramp${onto}`;
    case 'off ramp':
      return `Take the exit${onto}`;
    case 'roundabout':
    case 'rotary':
      return `At the roundabout, take exit ${step.exit ?? 1}${onto}`;
    default:
      return `${step.type[0].toUpperCase()}${step.type.slice(1)}${onto}`;
  }
}

/** Arrow glyph for a maneuver. */
export function maneuverIcon(step: RouteStep) {
  if (step.type === 'arrive') return '⚑';
  if (step.type === 'depart') return '↑';
  if (step.type === 'roundabout' || step.type === 'rotary') return '⟳';
  return (
    {
      left: '↰',
      right: '↱',
      'slight left': '↖',
      'slight right': '↗',
      'sharp left': '↲',
      'sharp right': '↳',
      straight: '↑',
      uturn: '↶',
    } as Record<string, string>
  )[step.modifier] ?? '↑';
}

/** US units for road directions: feet under 0.1 mi, then miles. */
export function distanceText(m: number) {
  const mi = m / 1609.344;
  if (mi < 0.1) return `${Math.max(50, Math.round((m * 3.28084) / 50) * 50)} ft`;
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}

/** Hand the trip to Google Maps (app on phones, web elsewhere). No API key needed. */
export function googleMapsUrl(origin: LngLat | null, destination: LngLat, waypoints: LngLat[] = []) {
  const p = new URLSearchParams({ api: '1', destination: `${destination[1]},${destination[0]}`, travelmode: 'driving' });
  if (origin) p.set('origin', `${origin[1]},${origin[0]}`);
  if (waypoints.length) p.set('waypoints', waypoints.map(w => `${w[1]},${w[0]}`).join('|'));
  return `https://www.google.com/maps/dir/?${p}`;
}
