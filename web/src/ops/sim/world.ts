// The simulated backend: SpacetimeDB tables + the agents that write them.
// One world per browser tab, shared by the responder phone and incident
// command, so an action on one screen shows up on the other the way it
// would through real subscriptions.

import type {
  CommandSnapshot,
  EventLogEntry,
  FireCell,
  Flag,
  FlagKind,
  ForecastCell,
  HelpRequest,
  MissionOutcome,
  PlanPolicy,
  PositionPin,
  QueueEntry,
  ResponderSnapshot,
  RoadClosure,
  Unit,
  Weather,
} from '../types';
import { cellAt, forecastFromPerimeter, forecastFromPoint, p10, type FireWeather } from './fire';
import { plan, travelS, type Commitment, type Plan, type PlanRequest, type Recommendation } from './planner';
import {
  CLOSURES,
  DEFAULT_POLICY,
  DEFAULT_WEATHER,
  FIRE_AGE_AT_START_S,
  GRID,
  IGNITION,
  INCIDENT,
  M_PER_DEG_LAT,
  M_PER_DEG_LON,
  RESPONDER_ME,
  STATIONS,
  UNITS,
  seedResidents,
} from './scenario';

const TICK_MS = 1000;
const REPLAN_EVERY_S = 20; // agents re-plan on change; ~20 s cadence otherwise
const POSITION_EVERY_S = 3; // unit_position stream cadence
const FORECAST_HORIZON_S = 6 * 3600;
const OTHER_CREW_ON_SCENE_S = 6 * 60; // simulated crews (not the demo phone) finish on their own
const CONSENT_S = 60 * 60;
const COMMANDER = 'commander:A. Lee';

export interface PlanPreview {
  queue: QueueEntry[];
  requests: HelpRequest[];
  recommendations: Recommendation[];
}

interface SimRequest extends HelpRequest {
  blockedUnits: number[];
}

type Listener = () => void;

export interface World {
  /** Station-scoped view for the phone carried by `unitId`. */
  responderSnapshot(unitId: number): ResponderSnapshot;
  /** A phone is open for this unit: its crew completes missions by hand. */
  claimPhone(unitId: number): void;
  commandSnapshot(): CommandSnapshot;
  recommendations(): Recommendation[];
  subscribe(l: Listener): () => void;
  // Responder (station) actions
  completeMission(unitId: number, outcome: MissionOutcome): void;
  // Commander actions
  setRunning(running: boolean): void;
  setWeather(windSpeedMps: number, windFromDeg: number, gustMps: number): void;
  overrideAssignment(requestId: bigint, stationId: number, note: string): void;
  /** Commit a waiting request to one unit (0 releases it to the planner). */
  assignToUnit(requestId: bigint, unitId: number): void;
  /** Visit this unit's waiting stops in this order. */
  /** `actor` defaults to the commander; crews reorder their own stops from the phone. */
  setUnitOrder(unitId: number, requestIds: bigint[], actor?: string): void;
  /** Hand all of a unit's stops back to the automatic plan. */
  releaseUnit(unitId: number, actor?: string): void;
  flagRequest(requestId: bigint, kind: FlagKind, detail: string): void;
  resolveFlag(flagId: bigint, resolution: string): void;
  previewPlan(policy: PlanPolicy, weather: Pick<Weather, 'windSpeedMps' | 'windFromDeg' | 'gustMps'>, pins: PositionPin[]): PlanPreview;
  applyPlan(policy: PlanPolicy, weather: Pick<Weather, 'windSpeedMps' | 'windFromDeg' | 'gustMps'>, pins: PositionPin[], reason: string): void;
}

const offset = (lat: number, lon: number, eastKm: number, northKm: number) => ({
  lat: lat + (northKm * 1000) / M_PER_DEG_LAT,
  lon: lon + (eastKm * 1000) / M_PER_DEG_LON,
});

export function createWorld(): World {
  const startWallMs = Date.now();

  // ─── Tables ───
  let simS = 0;
  let running = true;
  let lastTickMs = startWallMs;
  const speed = 1;

  let weather: Weather = { ...DEFAULT_WEATHER, source: 'scenario', locked: false, updatedAtMs: startWallMs };
  let policy: PlanPolicy = DEFAULT_POLICY;
  let pins: PositionPin[] = [];
  const fireWeather = (w: Pick<Weather, 'windSpeedMps' | 'windFromDeg' | 'gustMps'>, p: PlanPolicy): FireWeather => ({
    windSpeedMps: w.windSpeedMps,
    windFromDeg: w.windFromDeg,
    gustMps: w.gustMps,
    includeGusts: p.includeGusts,
    includeHumidity: p.includeHumidity,
    humidityPct: p.humidityPct,
  });

  // Fire: ignited FIRE_AGE before T+0 under the default wind.
  let median = forecastFromPoint(GRID, IGNITION.lat, IGNITION.lon, -FIRE_AGE_AT_START_S, fireWeather(weather, policy));
  const burning = new Map<number, number>();
  median.forEach((t, id) => t <= 0 && burning.set(id, t));
  let fireUpdatedMs = startWallMs;

  const s02 = STATIONS[1];
  const closures: RoadClosure[] = CLOSURES.map(c => {
    const a = offset(s02.lat, s02.lon, c.from[0], c.from[1]);
    const b = offset(s02.lat, s02.lon, c.to[0], c.to[1]);
    return { id: c.id, name: c.name, lat1: a.lat, lon1: a.lon, lat2: b.lat, lon2: b.lon, active: true, updatedAtMs: startWallMs };
  });

  const requests: SimRequest[] = seedResidents((lat, lon) => {
    const cell = cellAt(GRID, lat, lon);
    return cell < 0 || median[cell] <= 30 * 60; // not burning, and not about to
  }).map(r => ({
    id: r.id,
    lat: r.lat,
    lon: r.lon,
    headcount: r.headcount,
    needs: r.needs,
    note: r.note,
    status: 'queued',
    createdAtMs: startWallMs - r.sentMinAgo * 60_000,
    consentExpiresAtMs: startWallMs - r.sentMinAgo * 60_000 + CONSENT_S * 1000,
    level: 'unknown',
    slackS: null,
    fireEtaS: null,
    extractS: 0,
    pinnedStationId: 0,
    pinnedUnitId: 0,
    blockedUnits: [],
  }));

  const units: Unit[] = UNITS.map(u => ({ ...u }));
  const commitments = new Map<number, Commitment>();
  let queue: QueueEntry[] = [];
  let currentPlan: Plan | null = null;
  const flags: Flag[] = [];
  const events: EventLogEntry[] = [];
  let lastPlan = { atMs: startWallMs, reason: 'Scenario loaded' };
  let sinceReplan = 0;
  let sincePositions = 0;
  // Where each en-route unit set off from, so it can move toward the scene (unit_position).
  const trips = new Map<number, { lat: number; lon: number; departS: number }>();
  let nextFlagId = 1n;
  let nextEventId = 1n;

  const listeners = new Set<Listener>();
  // Phones finish their own missions; other simulated crews finish on a timer.
  const phones = new Set<number>([RESPONDER_ME.unitId]);
  const responderSnaps = new Map<number, ResponderSnapshot>();
  let base: Omit<ResponderSnapshot, 'requests' | 'queue' | 'me' | 'station'>;
  let allRequests: HelpRequest[] = [];
  let commandSnap: CommandSnapshot;

  const code = (id: bigint) => `Q-${String(id).padStart(3, '0')}`;
  const log = (actor: string, kind: string, message: string, requestId = 0n) => {
    events.unshift({ id: nextEventId++, atMs: Date.now(), simS, actor, kind, message, requestId });
    events.length = Math.min(events.length, 200);
  };

  // ─── Agents ───
  const fireEta = (r: { lat: number; lon: number }, m = median, now = simS) => {
    const cell = cellAt(GRID, r.lat, r.lon);
    return cell < 0 ? null : p10(m[cell], now);
  };

  const planInput = (p: PlanPolicy, pinList: PositionPin[], m = median) => ({
    nowS: simS,
    stations: STATIONS,
    units,
    requests: requests.map(
      (r): PlanRequest => ({
        id: r.id,
        lat: r.lat,
        lon: r.lon,
        headcount: r.headcount,
        needs: r.needs,
        fireEtaS: fireEta(r, m),
        pinnedStationId: r.pinnedStationId,
        pinnedUnitId: r.pinnedUnitId,
        blockedUnits: r.blockedUnits,
      })
    ),
    commitments: [...commitments.values()],
    policy: p,
    pins: pinList,
  });

  function replan(reason: string) {
    for (let guard = 0; guard < 10; guard++) {
      currentPlan = plan(planInput(policy, pins));
      // Station agents: a free unit takes its first planned mission (unit_en_route).
      let dispatched = false;
      for (const u of units) {
        if (commitments.has(u.id)) continue;
        const next = currentPlan.queue
          .filter(q => q.unitId === u.id && ![...commitments.values()].some(c => c.requestId === q.requestId))
          .sort((a, b) => a.position - b.position)[0];
        const r = next && requests.find(x => x.id === next.requestId);
        if (!next || !r) continue;
        commitments.set(u.id, { unitId: u.id, requestId: r.id, arriveS: simS + travelS(u, r) });
        trips.set(u.id, { lat: u.lat, lon: u.lon, departS: simS });
        u.status = 'en_route';
        u.currentRequest = r.id;
        r.status = 'en_route';
        // A dispatched mission's position pin has done its job.
        pins = pins.filter(p => p.requestId !== r.id);
        log(`station:${STATIONS.find(s => s.id === u.stationId)!.name}`, 'en_route', `${u.callsign} en route to ${code(r.id)}`, r.id);
        dispatched = true;
      }
      if (!dispatched) break;
    }
    const p = currentPlan!;
    queue = p.queue;
    for (const r of requests) {
      const d = p.danger.get(r.id);
      r.fireEtaS = fireEta(r);
      r.slackS = d?.slackS ?? null;
      r.level = d?.level ?? 'unknown';
      r.extractS = d?.extractS ?? 0;
    }
    for (const u of units) {
      const c = commitments.get(u.id);
      const r = c && requests.find(x => x.id === c.requestId);
      u.freeAtS = c && r ? Math.max(simS, c.arriveS) + r.extractS : simS;
    }
    // Danger agent: raise one open flag per newly unreachable request.
    for (const id of p.escalated) {
      if (!flags.some(f => f.requestId === id && !f.resolved && f.kind === 'unreachable')) {
        flags.push({
          id: nextFlagId++,
          requestId: id,
          kind: 'unreachable',
          detail: 'No ground unit can arrive before the forecast fire (p10).',
          recommendation: 'Review alternate support: air, shelter-in-place guidance, or a manual override.',
          raisedBy: 'danger',
          resolved: false,
          resolution: '',
          createdAtMs: Date.now(),
        });
        log('danger', 'flag', `${code(id)} unreachable by ground; escalated to command`, id);
      }
    }
    lastPlan = { atMs: Date.now(), reason };
    sinceReplan = 0;
    publish();
  }

  function finish(u: Unit, outcome: MissionOutcome, actor: string) {
    const c = commitments.get(u.id);
    commitments.delete(u.id);
    trips.delete(u.id);
    const s = STATIONS.find(x => x.id === u.stationId)!;
    u.status = 'available';
    u.currentRequest = 0n;
    u.lat = s.lat;
    u.lon = s.lon;
    if (!c) return;
    const i = requests.findIndex(r => r.id === c.requestId);
    if (i < 0) return;
    if (outcome === 'aborted') {
      requests[i].status = 'queued';
      requests[i].blockedUnits.push(u.id);
      log(actor, 'aborted', `${u.callsign} couldn't reach ${code(c.requestId)}; back in queue`, c.requestId);
    } else {
      log(actor, 'rescued', `${code(c.requestId)} ${outcome === 'rescued' ? 'rescued' : 'not found'} by ${u.callsign}; location deleted`, c.requestId);
      requests.splice(i, 1);
      pins = pins.filter(p => p.requestId !== c.requestId);
    }
  }

  // ─── Clock ───
  function tick() {
    const now = Date.now();
    if (running) simS += ((now - lastTickMs) / 1000) * speed;
    lastTickMs = now;
    if (!running) return;

    // Hazard agent: cells whose forecast arrival has passed are now burning.
    let grew = false;
    median.forEach((t, id) => {
      if (t <= simS && !burning.has(id)) {
        burning.set(id, t);
        grew = true;
      }
    });
    if (grew) fireUpdatedMs = now;

    // Missions progress on their own clock.
    let changed = false;
    for (const u of units) {
      const c = commitments.get(u.id);
      const r = c && requests.find(x => x.id === c.requestId);
      if (!c || !r) continue;
      const trip = trips.get(u.id);
      if (trip && u.status === 'en_route' && simS < c.arriveS) {
        // Station agents stream unit_position; here the unit closes in at constant speed.
        const f = Math.min(1, (simS - trip.departS) / Math.max(1, c.arriveS - trip.departS));
        u.lat = trip.lat + (r.lat - trip.lat) * f;
        u.lon = trip.lon + (r.lon - trip.lon) * f;
      }
      if (simS >= c.arriveS && u.status !== 'on_scene') {
        u.status = 'on_scene';
        u.lat = r.lat;
        u.lon = r.lon;
        r.status = 'on_scene';
        log(`station:${STATIONS.find(s => s.id === u.stationId)!.name}`, 'on_scene', `${u.callsign} on scene at ${code(r.id)}`, r.id);
        changed = true;
      }
      if (!phones.has(u.id) && simS >= c.arriveS + OTHER_CREW_ON_SCENE_S) {
        finish(u, 'rescued', `station:${STATIONS.find(s => s.id === u.stationId)!.name}`);
        changed = true;
      }
    }

    sinceReplan += TICK_MS / 1000;
    sincePositions += TICK_MS / 1000;
    if (changed) replan('Mission update');
    else if (sinceReplan >= REPLAN_EVERY_S) replan(grew ? 'Fire perimeter update' : 'Scheduled recompute');
    else if (sincePositions >= POSITION_EVERY_S && trips.size) {
      sincePositions = 0;
      publish(); // position-only update
    }
  }

  // ─── Snapshots ───
  function publish() {
    const now = Date.now();
    const fireCells: FireCell[] = [];
    const forecastCells: ForecastCell[] = [];
    median.forEach((t, cellId) => {
      const ignited = burning.get(cellId);
      if (ignited !== undefined) fireCells.push({ cellId, ignitedS: ignited, intensity: Math.max(0.2, 1 - (simS - ignited) / 7200) });
      else if (t - simS <= FORECAST_HORIZON_S) forecastCells.push({ cellId, arrivalEarlyS: p10(t, simS), arrivalMedianS: t });
    });
    base = {
      updatedAtMs: now,
      clock: { simS, speed, running, lastTickMs: now },
      grid: GRID,
      stations: STATIONS,
      units: units.map(u => ({ ...u })),
      fireCells,
      forecastCells,
      closures: closures.map(c => ({ ...c })),
      weather: { ...weather },
      incident: INCIDENT,
    };
    allRequests = requests.map(({ blockedUnits: _b, ...r }) => ({ ...r }));
    responderSnaps.clear(); // rebuilt lazily per unit
    commandSnap = {
      ...base,
      requests: allRequests,
      queue: queue.slice(),
      flags: flags.map(f => ({ ...f })),
      events: events.slice(),
      policy,
      pins: pins.slice(),
      lastPlan,
      sources: { fireMs: fireUpdatedMs, weatherMs: weather.updatedAtMs, closuresMs: Math.max(...closures.map(c => c.updatedAtMs)) },
      startS: 0,
    };
    listeners.forEach(l => l());
  }

  function reforecast(w: Pick<Weather, 'windSpeedMps' | 'windFromDeg' | 'gustMps'>, p: PlanPolicy) {
    return forecastFromPerimeter(GRID, burning, simS, fireWeather(w, p));
  }

  log('scenario', 'scenario', `${INCIDENT.name} loaded: ${requests.length} opt-in requests, ${units.length} units`);
  replan('Scenario loaded');
  setInterval(tick, TICK_MS);

  return {
    responderSnapshot(unitId) {
      let snap = responderSnaps.get(unitId);
      if (!snap) {
        // ops views scoped to a station: only its queue rows and their requests.
        const stationId = units.find(u => u.id === unitId)?.stationId ?? RESPONDER_ME.stationId;
        const myQueue = queue.filter(q => q.stationId === stationId);
        const mine = new Set(myQueue.map(q => q.requestId));
        snap = {
          ...base,
          requests: allRequests.filter(r => mine.has(r.id)),
          queue: myQueue,
          me: { stationId, unitId },
          station: STATIONS.find(s => s.id === stationId)!,
        };
        responderSnaps.set(unitId, snap);
      }
      return snap;
    },
    claimPhone(unitId) {
      phones.add(unitId);
    },
    commandSnapshot: () => commandSnap,
    recommendations: () => currentPlan?.recommendations ?? [],
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },

    completeMission(unitId, outcome) {
      const u = units.find(x => x.id === unitId);
      if (!u || !commitments.has(u.id)) throw new Error('No active mission for this unit.');
      finish(u, outcome, `station:${STATIONS.find(s => s.id === u.stationId)!.name}`);
      replan(outcome === 'aborted' ? 'Crew reported no access' : 'Mission complete');
    },

    setRunning(next) {
      tick();
      running = next;
      lastTickMs = Date.now();
      log(COMMANDER, 'sim', `Simulation ${next ? 'resumed' : 'paused'}`);
      publish();
    },

    setWeather(windSpeedMps, windFromDeg, gustMps) {
      const dir = ((windFromDeg % 360) + 360) % 360;
      weather = { windSpeedMps, windFromDeg: dir, gustMps: Math.max(gustMps, windSpeedMps), source: 'manual', locked: true, updatedAtMs: Date.now() };
      median = reforecast(weather, policy);
      fireUpdatedMs = Date.now();
      log(COMMANDER, 'wind', `Wind now ${(windSpeedMps * 2.237).toFixed(0)} mph from ${dir.toFixed(0)}° (manual)`);
      replan('Wind update');
    },

    overrideAssignment(requestId, stationId, note) {
      const r = requests.find(x => x.id === requestId);
      if (!r) throw new Error(`${code(requestId)} is closed.`);
      r.pinnedStationId = stationId;
      r.pinnedUnitId = 0; // a station override supersedes a unit assignment
      const where = stationId === 0 ? 'unpinned' : `assigned to ${STATIONS.find(s => s.id === stationId)!.name}`;
      log(COMMANDER, 'override', `${code(requestId)} ${where}${note ? `: ${note}` : ''}`, requestId);
      replan('Commander override');
    },

    assignToUnit(requestId, unitId) {
      const r = requests.find(x => x.id === requestId);
      if (!r) throw new Error(`${code(requestId)} is closed.`);
      if ([...commitments.values()].some(c => c.requestId === requestId)) throw new Error(`${code(requestId)} is already dispatched.`);
      const u = units.find(x => x.id === unitId);
      if (unitId && !u) throw new Error('Unit not found.');
      if (u && r.blockedUnits.includes(u.id)) throw new Error(`${u.callsign} reported it can't reach ${code(requestId)}.`);
      r.pinnedUnitId = unitId;
      r.pinnedStationId = u ? u.stationId : 0;
      pins = pins.filter(p => p.requestId !== requestId);
      // Assigning a unit is the commander's answer to an unreachable escalation.
      if (u) {
        for (const f of flags) {
          if (f.requestId === requestId && f.kind === 'unreachable' && !f.resolved) {
            f.resolved = true;
            f.resolution = `Manual ground override: assigned to ${u.callsign}`;
          }
        }
      }
      log(COMMANDER, 'override', u ? `${code(requestId)} assigned to ${u.callsign}` : `${code(requestId)} released to the automatic plan`, requestId);
      replan('Commander unit assignment');
    },

    setUnitOrder(unitId, requestIds, actor = COMMANDER) {
      const u = units.find(x => x.id === unitId);
      if (!u) throw new Error('Unit not found.');
      // Reuse the ground positions these stops already hold, in the new order.
      const committedIds = new Set([...commitments.values()].map(c => c.requestId));
      const waiting = queue.filter(q => q.position > 0 && !committedIds.has(q.requestId)).sort((a, b) => a.position - b.position);
      const posOf = new Map(waiting.map((q, i) => [q.requestId, i + 1]));
      const slots = requestIds.map(id => posOf.get(id)).filter((p): p is number => p !== undefined).sort((a, b) => a - b);
      if (slots.length !== requestIds.length) throw new Error('Those stops changed; refresh and try again.');
      const now = Date.now();
      pins = pins.filter(p => !requestIds.includes(p.requestId));
      requestIds.forEach((id, i) => {
        const r = requests.find(x => x.id === id)!;
        r.pinnedUnitId = unitId;
        r.pinnedStationId = u.stationId;
        pins.push({ requestId: id, position: slots[i], reason: `${u.callsign} stop order`, by: actor, atMs: now });
      });
      log(actor, 'override', `${u.callsign} stop order set: ${requestIds.map(code).join(' → ')}`);
      replan(actor === COMMANDER ? 'Commander unit order' : `${u.callsign} reordered its stops`);
    },

    releaseUnit(unitId, actor = COMMANDER) {
      const u = units.find(x => x.id === unitId);
      const released = requests.filter(r => r.pinnedUnitId === unitId);
      for (const r of released) {
        r.pinnedUnitId = 0;
        r.pinnedStationId = 0;
      }
      pins = pins.filter(p => !released.some(r => r.id === p.requestId));
      log(actor, 'override', `${u?.callsign ?? 'Unit'} stops released to the automatic plan (${released.length})`);
      replan(actor === COMMANDER ? 'Commander released unit' : `${u?.callsign ?? 'Unit'} back on automatic order`);
    },

    flagRequest(requestId, kind, detail) {
      flags.push({
        id: nextFlagId++,
        requestId,
        kind,
        detail,
        recommendation: '',
        raisedBy: COMMANDER,
        resolved: false,
        resolution: '',
        createdAtMs: Date.now(),
      });
      log(COMMANDER, 'flag', `${code(requestId)} flagged ${kind}`, requestId);
      publish();
    },

    resolveFlag(flagId, resolution) {
      const f = flags.find(x => x.id === flagId);
      if (!f) throw new Error('Flag not found.');
      f.resolved = true;
      f.resolution = resolution;
      log(COMMANDER, 'flag_resolved', `${code(f.requestId)} flag resolved: ${resolution}`, f.requestId);
      publish();
    },

    previewPlan(p, w, pinList) {
      const m = w.windSpeedMps === weather.windSpeedMps && w.windFromDeg === weather.windFromDeg && w.gustMps === weather.gustMps &&
        p.includeGusts === policy.includeGusts && p.includeHumidity === policy.includeHumidity && p.humidityPct === policy.humidityPct
        ? median
        : reforecast(w, p);
      const preview = plan(planInput(p, pinList, m));
      return {
        queue: preview.queue,
        recommendations: preview.recommendations,
        requests: requests.map(({ blockedUnits: _b, ...r }) => {
          const d = preview.danger.get(r.id);
          return { ...r, fireEtaS: fireEta(r, m), slackS: d?.slackS ?? null, level: d?.level ?? 'unknown' };
        }),
      };
    },

    applyPlan(p, w, pinList, reason) {
      const weatherChanged = w.windSpeedMps !== weather.windSpeedMps || w.windFromDeg !== weather.windFromDeg || w.gustMps !== weather.gustMps;
      policy = p;
      pins = pinList.map(x => ({ ...x }));
      if (weatherChanged) weather = { ...w, source: 'manual', locked: true, updatedAtMs: Date.now() };
      median = reforecast(weather, policy);
      fireUpdatedMs = Date.now();
      log(COMMANDER, 'policy', `Queue policy applied (${pins.length} manual pin${pins.length === 1 ? '' : 's'})${reason ? `: ${reason}` : ''}`);
      replan('Commander policy applied');
    },
  };
}

let world: World | null = null;
/** The single simulated world for this tab. */
export function getWorld() {
  world ??= createWorld();
  return world;
}
