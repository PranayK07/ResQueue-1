// Incident-command views over the snapshot rows. Pure; works on real or simulated rows.

import { simNow, simToMs } from '../ops/derive';
import type { CommandSnapshot, DangerLevel, HelpRequest, QueueEntry, Station, Unit } from '../ops/types';

export interface CommandRow {
  request: HelpRequest;
  entry: QueueEntry;
  station: Station;
  unit: Unit | null;
  /** Escalated to command: outside ground dispatch. */
  escalated: boolean;
  /** A unit is committed (en route / on scene). */
  committed: boolean;
}

/** All requests, escalations first, then ground-queue order (planner position). */
export function commandRows(s: CommandSnapshot): CommandRow[] {
  const rows = s.queue.flatMap(entry => {
    const request = s.requests.find(r => r.id === entry.requestId);
    const station = s.stations.find(st => st.id === entry.stationId);
    if (!request || !station) return [];
    const unit = s.units.find(u => u.id === entry.unitId) ?? null;
    return [{ request, entry, station, unit, escalated: entry.position === 0, committed: unit?.currentRequest === request.id }];
  });
  return rows.sort((a, b) =>
    a.escalated !== b.escalated
      ? Number(b.escalated) - Number(a.escalated)
      : a.escalated
        ? (a.request.slackS ?? 0) - (b.request.slackS ?? 0)
        : a.entry.position - b.entry.position
  );
}

/** Overview order: escalations first, then least slack first ("SLACK ↑"). */
export function bySlack(rows: CommandRow[]) {
  return rows.slice().sort((a, b) =>
    a.escalated !== b.escalated ? Number(b.escalated) - Number(a.escalated) : (a.request.slackS ?? Infinity) - (b.request.slackS ?? Infinity)
  );
}

export type AlertTone = 'red' | 'amber' | 'blue' | 'muted';

/** Where an alert stands right now, for the queue's STATUS column. */
export function alertStatus(row: CommandRow, s: CommandSnapshot): { label: string; tone: AlertTone; flagged: boolean } {
  const flagged = s.flags.some(f => f.requestId === row.request.id && !f.resolved && f.kind !== 'unreachable');
  if (row.escalated) return { label: 'Escalated', tone: 'red', flagged };
  if (row.committed) return row.unit?.status === 'on_scene' ? { label: 'On scene', tone: 'amber', flagged } : { label: 'Unit en route', tone: 'blue', flagged };
  return { label: 'Waiting', tone: 'muted', flagged }; // the planned unit is in STATION / UNIT
}

/** A unit's journey: its dispatched mission, then its planned stops in order. */
export function unitJourney(rows: CommandRow[], unitId: number) {
  const current = rows.find(r => r.committed && r.unit?.id === unitId) ?? null;
  const stops = rows.filter(r => !r.committed && !r.escalated && r.entry.unitId === unitId).sort((a, b) => a.entry.position - b.entry.position);
  return { current, stops };
}

export const UNIT_STATUS: Record<string, string> = {
  available: 'Available',
  assigned: 'Assigned',
  en_route: 'En route',
  on_scene: 'On scene',
  returning: 'Returning',
  out_of_service: 'Out of service',
};

export function counts(s: CommandSnapshot, rows: CommandRow[]) {
  const by = (l: DangerLevel) => rows.filter(r => !r.escalated && r.request.level === l).length;
  const available = s.units.filter(u => u.status === 'available' && u.currentRequest === 0n).length;
  return {
    requests: rows.length,
    people: rows.reduce((n, r) => n + r.request.headcount, 0),
    escalated: rows.filter(r => r.escalated).length,
    critical: by('critical') + by('unreachable'), // delayed-but-dispatched counts as critical
    high: by('high'),
    moderate: by('moderate'),
    unitsAvailable: available,
    unitsTotal: s.units.length,
    stations: s.stations.length,
  };
}

// ─── Formatting ────────────────────────────────────────────────────────────

export const pad2 = (n: number) => String(n).padStart(2, '0');

/** "T+00:47" since scenario start. */
export function tPlus(s: CommandSnapshot, nowMs: number) {
  const mins = Math.max(0, Math.floor((simNow(s.clock, nowMs) - s.startS) / 60));
  return `T+${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
}

const SHORT_NEED: Record<string, string> = {
  mobility: 'wheelchair',
  medical: 'medical',
  oxygen: 'oxygen support',
  infant: 'infant',
  elderly: 'elderly',
  pets: 'pets',
};
const LONG_NEED: Record<string, string> = {
  mobility: 'mobility assistance',
  medical: 'medical needs',
  oxygen: 'oxygen support',
  infant: 'infant',
  elderly: 'elderly resident',
  pets: 'pets',
};

const needList = (r: HelpRequest) => r.needs.split(',').map(n => n.trim()).filter(Boolean);

/** "3 · wheelchair" */
export function peopleNeeds(r: HelpRequest) {
  const needs = needList(r).map(n => SHORT_NEED[n] ?? n);
  return `${r.headcount} · ${needs.length ? needs.join(', ') : 'no listed needs'}`;
}

/** "3 people · mobility assistance" */
export function peopleNeedsLong(r: HelpRequest) {
  const needs = needList(r).map(n => LONG_NEED[n] ?? n);
  return `${r.headcount} ${r.headcount === 1 ? 'person' : 'people'}${needs.length ? ` · ${needs.join(', ')}` : ''}`;
}

export const slackMin = (slackS: number | null) => (slackS === null ? null : Math.round(slackS / 60));

export function slackText(slackS: number | null) {
  const m = slackMin(slackS);
  if (m === null) return '—';
  return m < 0 ? `−${Math.abs(m)} min` : `+${m} min`;
}

/** "S02 / E21" ("S03 / Review" for escalations). */
export function stationUnit(row: CommandRow) {
  const s = row.station.name.split(' ')[0];
  return `${s} / ${row.escalated ? 'Review' : (row.unit?.callsign ?? '—')}`;
}

/**
 * The slack formula with this request's numbers, in whole minutes:
 * "38 − (4 + 10 + 8) − 5 = 11 min". Rounding each term can make the shown
 * sum differ from the exact slack by a minute; the result shown is the exact one.
 */
export function slackBreakdown(row: CommandRow, s: CommandSnapshot, marginS: number) {
  const { request: r, entry } = row;
  if (r.fireEtaS === null) return null;
  const now = s.clock.simS;
  const toFire = Math.round((r.fireEtaS - now) / 60);
  const wait = Math.round(entry.waitS / 60);
  const travel = Math.round(entry.travelS / 60);
  const extract = Math.round(r.extractS / 60);
  const margin = Math.round(marginS / 60);
  return {
    text: `${toFire} − (${wait} + ${travel} + ${extract}) − ${margin} = ${slackText(r.slackS).replace(' min', '')} min`,
    fireP10Ms: simToMs(s.clock, r.fireEtaS),
    wait,
    travel,
  };
}

export function unitAvailability(u: Unit | null, s: CommandSnapshot, nowMs: number) {
  if (!u) return 'No unit assigned';
  if (u.status === 'available' && u.currentRequest === 0n) return 'Available now';
  const mins = Math.max(0, Math.ceil((u.freeAtS - simNow(s.clock, nowMs)) / 60));
  const state = u.status === 'on_scene' ? 'On scene' : u.status === 'en_route' ? 'En route' : 'Busy';
  return `${state} · available in ${mins} min`;
}

/** Compass point for a wind direction. */
export function compass(deg: number) {
  const pts = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return pts[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

export const mph = (mps: number) => Math.round(mps * 2.23694);
export const mps = (mphValue: number) => mphValue / 2.23694;
