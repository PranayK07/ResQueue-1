// Sim time. Every fire, forecast and ETA number is an absolute sim second.
// Consent countdowns use wall-clock Timestamps instead.
import type { Timestamp } from 'spacetimedb';
import { useSingleton } from '@/lib/stdb/hooks';
import type { SimClockRow } from '@/lib/stdb/rows';
import { store } from '@/lib/stdb/store';
import { useNow } from './now';

export { useNow } from './now';

/** sim_tick credits at most 5 s of real time per tick, so we extrapolate no further. */
const MAX_EXTRAPOLATE_S = 5;
/** Most network delay we credit between the server tick and its arrival here. */
const MAX_TRANSIT_MS = 1000;

export type ClockLike = Pick<SimClockRow, 'simS' | 'speed' | 'running' | 'lastTick'>;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function tsToMs(ts: Timestamp): number {
  return Number(ts.microsSinceUnixEpoch / 1000n);
}

export function tsToDate(ts: Timestamp): Date {
  return new Date(tsToMs(ts));
}

/**
 * The spec formula: simS + (running ? min((now - lastTick) / 1000, 5) * speed : 0).
 * Given the time the row arrived here, elapsed time is measured from the arrival
 * (plus up to 1 s of transit), so a device clock that is off doesn't shift sim time.
 */
export function simNowAt(clock: ClockLike, nowMs: number, receivedAtMs?: number): number {
  if (!clock.running) return clock.simS;
  const lastTickMs = tsToMs(clock.lastTick);
  const elapsedMs =
    receivedAtMs === undefined
      ? nowMs - lastTickMs
      : nowMs - receivedAtMs + clamp(receivedAtMs - lastTickMs, 0, MAX_TRANSIT_MS);
  return clock.simS + clamp(elapsedMs / 1000, 0, MAX_EXTRAPOLATE_S) * clock.speed;
}

/** Minutes from now until an absolute sim second (negative once it has passed). */
export function minsFromNow(s: number, simS: number): number {
  return (s - simS) / 60;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "T+mm:ss", or "T+h:mm:ss" past the first hour. */
export function formatT(simS: number): string {
  const total = Math.max(0, Math.floor(simS));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `T+${h}:${pad2(m)}:${pad2(s)}` : `T+${pad2(m)}:${pad2(s)}`;
}

/** Wall-clock "hh:mm" (or with seconds) for "Last updated" lines. */
export function formatClock(ms: number, withSeconds = false): string {
  const d = new Date(ms);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return withSeconds ? `${hm}:${pad2(d.getSeconds())}` : hm;
}

/** Sim now in seconds, re-rendered every 250 ms. Undefined until sim_clock arrives. */
export function useSimNow(): number | undefined {
  const clock = useSingleton('sim_clock');
  useNow(250);
  if (!clock) return undefined;
  // Date.now() rather than the ticker value, so a fresh row is never measured against an older tick.
  return simNowAt(clock, Date.now(), store.lastChangedAt('sim_clock'));
}
