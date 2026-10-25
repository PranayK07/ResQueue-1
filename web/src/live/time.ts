// Sim time from the sim_clock row. Every fire, forecast and ETA number is an absolute sim second; consent windows
// and log times are wall-clock Timestamps instead.

import type { Timestamp } from 'spacetimedb';
import type { RowOf } from './tables';

/** Most network delay credited between the server's tick and its arrival here. */
const MAX_TRANSIT_MS = 1000;
/** sim_tick credits at most 5 s of real time per tick, so we never extrapolate further. */
const MAX_EXTRAPOLATE_MS = 5000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function tsToMs(ts: Timestamp): number {
  return Number(ts.microsSinceUnixEpoch / 1000n);
}

export interface LiveClock {
  simS: number;
  speed: number;
  running: boolean;
  /** When this browser received the row, less up to 1 s of transit: device clock skew doesn't shift sim time. */
  lastTickMs: number;
}

type ClockRow = Pick<RowOf<'sim_clock'>, 'simS' | 'speed' | 'running' | 'lastTick'>;

/** `receivedAtMs` is store.changedAt('sim_clock'); without it the server's tick time is used as is. */
export function clockFromRow(row: ClockRow, receivedAtMs: number | undefined): LiveClock {
  const tickMs = tsToMs(row.lastTick);
  const lastTickMs = receivedAtMs === undefined ? tickMs : receivedAtMs - clamp(receivedAtMs - tickMs, 0, MAX_TRANSIT_MS);
  return { simS: row.simS, speed: row.speed, running: row.running, lastTickMs };
}

/** Sim seconds now: the row's simS plus at most 5 s of real time since it arrived, at its speed. */
export function simNowAt(clock: LiveClock, nowMs: number): number {
  if (!clock.running) return clock.simS;
  return clock.simS + (clamp(nowMs - clock.lastTickMs, 0, MAX_EXTRAPOLATE_MS) / 1000) * clock.speed;
}

export type TimeBasis = 'incident' | 'scenario' | 'wall';

// The scenario's own T+0, captured once per scenario (and again when a reseed sends simS backwards).
let scenarioOrigin: { scenario: string; originMs: number; lastSimS: number } | null = null;

/**
 * The display time of sim T+0: a replay's real start time when there is an incident row, otherwise the moment the
 * scenario started by this browser's clock. 'wall' marks a 1x run, where that is simply the time of day.
 */
export function clockOrigin(
  row: Pick<RowOf<'sim_clock'>, 'simS' | 'speed' | 'scenario'>,
  clock: LiveClock,
  incidentStartMs: number | null
): { originMs: number; timeBasis: TimeBasis } {
  // Compare stored row values, never extrapolated ones: set_sim drops the partial tick, so only a reseed goes back.
  if (!scenarioOrigin || scenarioOrigin.scenario !== row.scenario || row.simS < scenarioOrigin.lastSimS - 1e-6) {
    scenarioOrigin = { scenario: row.scenario, originMs: clock.lastTickMs - row.simS * 1000, lastSimS: row.simS };
  } else {
    scenarioOrigin.lastSimS = row.simS;
  }
  if (incidentStartMs !== null) return { originMs: incidentStartMs, timeBasis: 'incident' };
  return { originMs: scenarioOrigin.originMs, timeBasis: row.speed === 1 ? 'wall' : 'scenario' };
}

/** Pretty title for an incident or scenario id: recorded sequences get a short name, slugs get words. */
export function incidentTitle(key: string, name: string): string {
  if (name.trim() && !/^(?:recorded-)?sequence-[0-9a-f]+$/i.test(name.trim())) return name.trim();
  const seq = /^(?:recorded-)?sequence-([0-9a-f]+)$/i.exec(key) ?? /^(?:recorded-)?sequence-([0-9a-f]+)$/i.exec(name);
  if (seq) return `Recorded fire · sequence ${seq[1].slice(0, 6).toLowerCase()}`;
  const text = name.trim() || key.trim();
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(text) ? scenarioTitle(text) : text;
}

/** 'paradise-demo' → 'Paradise demo'. */
export function scenarioTitle(slug: string): string {
  const words = slug.trim().replace(/[-_]+/g, ' ');
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}
