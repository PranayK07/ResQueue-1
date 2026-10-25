// Danger + delegation (stand-in for those agents). Pure: same inputs → same plan,
// so command can preview a policy change without touching the live queue.
//
//   slack = fire p10 − (now + unit wait + travel + extraction) − margin   (agents/rescue/core/slack.py)
//
// Ground queue: repeatedly take the request with the least slack (within safety
// bands; optional distance preference inside a band), honouring commander
// position pins. Requests no station can reach in time are escalated to
// command instead of entering ground dispatch.

import type { DangerLevel, PlanPolicy, PositionPin, QueueEntry, Station, Unit } from '../types';
import { M_PER_DEG_LAT, M_PER_DEG_LON } from './scenario';

const DRIVE_MPS = 11; // ~40 km/h on fire roads
const ROAD_FACTOR = 1.35; // straight line → road distance
const NEED_EXTRA_S: Record<string, number> = { mobility: 420, medical: 480, oxygen: 360, infant: 120, elderly: 180, pets: 120 };
const TRANSFER_MIN_SAVING_S = 5 * 60;

type Pt = { lat: number; lon: number };

export const distanceM = (a: Pt, b: Pt) => Math.hypot((a.lat - b.lat) * M_PER_DEG_LAT, (a.lon - b.lon) * M_PER_DEG_LON);
export const travelS = (a: Pt, b: Pt) => (distanceM(a, b) * ROAD_FACTOR) / DRIVE_MPS;

export function extractS(headcount: number, needs: string) {
  return 240 + 45 * Math.max(1, headcount) + needs.split(',').reduce((s, n) => s + (NEED_EXTRA_S[n.trim()] ?? 0), 0);
}

export function levelFor(slackS: number): DangerLevel {
  if (slackS < 0) return 'unreachable';
  if (slackS < 600) return 'critical';
  if (slackS < 1800) return 'high';
  return 'moderate';
}

export interface PlanRequest extends Pt {
  id: bigint;
  headcount: number;
  needs: string;
  /** p10 fire arrival (absolute sim s); null = outside the forecast. */
  fireEtaS: number | null;
  pinnedStationId: number;
  /** Commander assignment to a specific unit; 0 = planner chooses. */
  pinnedUnitId: number;
  /** Units a crew reported can't reach it. */
  blockedUnits: number[];
}

export interface Commitment {
  unitId: number;
  requestId: bigint;
  arriveS: number;
}

export interface PlanInput {
  nowS: number;
  stations: Station[];
  units: Unit[];
  requests: PlanRequest[];
  commitments: Commitment[];
  policy: PlanPolicy;
  pins: PositionPin[];
}

export interface Recommendation {
  requestId: bigint;
  fromStationId: number;
  fromUnitId: number;
  toStationId: number;
  toUnitId: number;
  savesS: number;
}

export interface Plan {
  queue: QueueEntry[];
  danger: Map<bigint, { slackS: number | null; level: DangerLevel; extractS: number }>;
  escalated: bigint[];
  recommendations: Recommendation[];
}

function band(slackS: number) {
  return slackS < 600 ? 0 : slackS < 1800 ? 1 : 2; // critical (incl. delayed) · high · moderate
}

export function plan(input: PlanInput): Plan {
  const { nowS, stations, units, requests, commitments, policy, pins } = input;
  const margin = policy.marginS;
  const byId = new Map(requests.map(r => [r.id, r]));
  const queue: QueueEntry[] = [];
  const danger: Plan['danger'] = new Map();
  const stationRank = new Map<number, number>();
  const nextRank = (stationId: number) => {
    const n = (stationRank.get(stationId) ?? 0) + 1;
    stationRank.set(stationId, n);
    return n;
  };
  const slackOf = (r: PlanRequest, etaS: number) =>
    r.fireEtaS === null ? Infinity : r.fireEtaS - (etaS + extractS(r.headcount, r.needs)) - margin;

  // When and where each unit is next free.
  const freeAt = new Map<number, { s: number; at: Pt }>();
  for (const u of units) freeAt.set(u.id, { s: nowS, at: u });

  // 1. Committed missions keep their unit.
  const committed = new Set<bigint>();
  let position = 0;
  for (const c of commitments) {
    const r = byId.get(c.requestId);
    const u = units.find(x => x.id === c.unitId);
    if (!r || !u) continue;
    committed.add(r.id);
    const ex = extractS(r.headcount, r.needs);
    const slack = slackOf(r, c.arriveS);
    danger.set(r.id, { slackS: Number.isFinite(slack) ? slack : null, level: Number.isFinite(slack) ? levelFor(slack) : 'unknown', extractS: ex });
    queue.push({
      requestId: r.id,
      stationId: u.stationId,
      rank: nextRank(u.stationId),
      unitId: u.id,
      etaS: c.arriveS,
      reason: u.status === 'on_scene' ? `${u.callsign} on scene.` : `${u.callsign} en route; committed.`,
      waitS: 0,
      travelS: Math.max(0, c.arriveS - nowS),
      position: ++position,
    });
    freeAt.set(u.id, { s: Math.max(nowS, c.arriveS) + ex, at: r });
  }
  const unitFreeAfterCommitments = new Map(freeAt);

  const pinnedUnit = (r: PlanRequest) =>
    r.pinnedUnitId && !r.blockedUnits.includes(r.pinnedUnitId) ? units.find(u => u.id === r.pinnedUnitId) : undefined;
  const stationOf = (r: PlanRequest) =>
    pinnedUnit(r)?.stationId ||
    r.pinnedStationId ||
    stations.reduce((a, b) => (travelS(b, r) < travelS(a, r) ? b : a)).id;

  // 2. Escalate what no station can reach in time even with an idle unit.
  const escalated: bigint[] = [];
  let pending: PlanRequest[] = [];
  for (const r of requests) {
    if (committed.has(r.id)) continue;
    const ex = extractS(r.headcount, r.needs);
    const best = Math.max(...stations.map(s => slackOf(r, nowS + travelS(s, r))));
    const usable = units.some(u => !r.blockedUnits.includes(u.id) && u.stationId === stationOf(r));
    // A commander's unit assignment is a deliberate ground attempt: dispatch it
    // even when the forecast says it's too late (it shows as unreachable slack).
    if ((best < 0 || !usable) && !pinnedUnit(r)) {
      escalated.push(r.id);
      const slack = Number.isFinite(best) ? best : null;
      danger.set(r.id, { slackS: slack, level: 'unreachable', extractS: ex });
      queue.push({
        requestId: r.id,
        stationId: stationOf(r),
        rank: 0,
        unitId: 0,
        etaS: nowS,
        reason: usable ? 'Unreachable by ground; fire overtakes buffer.' : 'Crews report no ground access; commander review.',
        waitS: 0,
        travelS: 0,
        position: 0,
      });
    } else {
      pending.push(r);
    }
  }

  // 3. Ground queue, least slack first, honouring position pins. Pin positions
  //    count waiting requests only, so a pin doesn't drift as missions finish.
  let waiting = 0;
  const pinAt = new Map(pins.filter(p => pending.some(r => r.id === p.requestId)).map(p => [p.position, p.requestId]));
  const option = (r: PlanRequest) => {
    const sid = stationOf(r);
    let best: { unit: Unit; eta: number; wait: number; travel: number } | null = null;
    const only = pinnedUnit(r);
    for (const u of units) {
      if (u.stationId !== sid || r.blockedUnits.includes(u.id) || (only && u !== only)) continue;
      const slot = freeAt.get(u.id)!;
      const travel = travelS(slot.at, r);
      const eta = slot.s + travel;
      if (!best || eta < best.eta) best = { unit: u, eta, wait: slot.s - nowS, travel };
    }
    return best!;
  };
  const distanceBonus = (r: PlanRequest) =>
    policy.distancePreference.enabled ? (policy.distancePreference.weight * distanceM(stations.find(s => s.id === stationOf(r))!, r)) / 1000 * 120 : 0;

  while (pending.length) {
    position++;
    waiting++;
    const pinnedId = pinAt.get(waiting);
    let pick = pinnedId !== undefined ? pending.find(r => r.id === pinnedId) : undefined;
    if (!pick) {
      const unpinned = pending.filter(r => !pins.some(p => p.requestId === r.id && p.position > waiting));
      const pool = unpinned.length ? unpinned : pending;
      const scored = pool.map(r => {
        const o = option(r);
        const s = slackOf(r, o.eta);
        return { r, key: [band(s), s - distanceBonus(r)] as const };
      });
      pick = scored.reduce((a, b) => (b.key[0] < a.key[0] || (b.key[0] === a.key[0] && b.key[1] < a.key[1]) ? b : a)).r;
    }
    const r = pick;
    const o = option(r);
    const slack = slackOf(r, o.eta);
    const ex = extractS(r.headcount, r.needs);
    danger.set(r.id, { slackS: Number.isFinite(slack) ? slack : null, level: Number.isFinite(slack) ? levelFor(slack) : 'unknown', extractS: ex });
    queue.push({
      requestId: r.id,
      stationId: o.unit.stationId,
      rank: nextRank(o.unit.stationId),
      unitId: o.unit.id,
      etaS: o.eta,
      reason: explain(r, o, slack, ex, nowS, pins.some(p => p.requestId === r.id), stations),
      waitS: o.wait,
      travelS: o.travel,
      position,
    });
    freeAt.set(o.unit.id, { s: o.eta + ex, at: r });
    pending = pending.filter(x => x !== r);
  }

  // 4. Transfers worth a commander's look: another station gets there clearly sooner.
  const recommendations: Recommendation[] = [];
  for (const q of queue) {
    const r = byId.get(q.requestId);
    if (!r || q.unitId === 0 || committed.has(r.id) || r.pinnedStationId || r.pinnedUnitId) continue;
    for (const s of stations) {
      if (s.id === q.stationId) continue;
      for (const u of units.filter(x => x.stationId === s.id && !r.blockedUnits.includes(x.id))) {
        const slot = unitFreeAfterCommitments.get(u.id)!;
        const eta = slot.s + travelS(slot.at, r);
        if (q.etaS - eta >= TRANSFER_MIN_SAVING_S) {
          recommendations.push({ requestId: r.id, fromStationId: q.stationId, fromUnitId: q.unitId, toStationId: s.id, toUnitId: u.id, savesS: q.etaS - eta });
        }
      }
    }
  }
  recommendations.sort((a, b) => b.savesS - a.savesS);

  return { queue, danger, escalated, recommendations: dedupe(recommendations) };
}

function dedupe(recs: Recommendation[]) {
  const seen = new Set<bigint>();
  return recs.filter(r => (seen.has(r.requestId) ? false : (seen.add(r.requestId), true)));
}

/** Operator-facing "why this rank" (never shown to residents). */
function explain(
  r: PlanRequest,
  o: { unit: Unit; wait: number; travel: number },
  slack: number,
  extract: number,
  nowS: number,
  manual: boolean,
  stations: Station[]
) {
  if (r.pinnedUnitId === o.unit.id) return `Commander assigned to ${o.unit.callsign}${manual ? ' in a set order' : ''}.`;
  if (manual) return 'Commander pinned this ground position.';
  if (r.pinnedStationId) return `Commander assigned to ${stations.find(s => s.id === r.pinnedStationId)?.name ?? 'station'}.`;
  if (r.blockedUnits.length) return 'A crew reported no access; rerouted to another unit.';
  const mins = Math.round(slack / 60);
  if (r.fireEtaS !== null && r.fireEtaS - nowS < 40 * 60) return `Near forecast edge; ${mins}-minute buffer.`;
  if (o.wait > o.travel && o.wait > 5 * 60) return 'Unit wait leaves a narrow buffer.';
  if (extract > 600) return 'Longer extraction for specific needs.';
  if (slack >= 1800) return 'Fire arrival well beyond reach time.';
  return `Least slack first; ${mins}-minute buffer.`;
}
