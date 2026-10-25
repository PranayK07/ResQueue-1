// Token hex values for MapLibre paint and map markers. MapLibre paint can't
// read CSS variables, so these mirror the tokens in web/src/index.css
// (frontend-spec section 2). Keep the two in sync.
import type { Level } from '@/lib/domain/levels';
import type { UnitStatus } from '@/lib/domain/status';
import type { ForecastBand } from '@/lib/geo/layers';

export const MAP_HEX = {
  bg: '#050607',
  text: '#F2F4F7',
  muted: '#8A93A3',
  ok: '#3DD68C',
  fire: '#FF5533',
} as const;

export const LEVEL_HEX: Record<Level, string> = {
  unreachable: '#C084FC',
  critical: '#FF5533',
  high: '#FF9F1C',
  moderate: '#F2C94C',
  unknown: '#6B7280',
};

/** Forecast band fills, nearest fire first. */
export const BAND_STYLE: Record<ForecastBand, { color: string; opacity: number }> = {
  lt30: { color: '#FF5533', opacity: 0.28 },
  '30to60': { color: '#FF9F1C', opacity: 0.2 },
  gt60: { color: '#F2C94C', opacity: 0.12 },
};

/** Burning cells: opacity = base + perIntensity * intensity (intensity clamped to 0..1). */
export const FIRE_OPACITY = { base: 0.35, perIntensity: 0.55 } as const;

const COMMITTED: readonly UnitStatus[] = ['assigned', 'en_route', 'on_scene'];

export type UnitTone = 'available' | 'committed' | 'idle';

/** Available, committed to a request, or neither (returning, out of service, unknown). */
export function unitTone(status: string): UnitTone {
  if (status === 'available') return 'available';
  return (COMMITTED as readonly string[]).includes(status) ? 'committed' : 'idle';
}

export const UNIT_HEX: Record<UnitTone, string> = {
  available: MAP_HEX.ok,
  committed: MAP_HEX.text,
  idle: MAP_HEX.muted,
};
