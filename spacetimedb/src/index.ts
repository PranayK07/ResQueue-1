// Reducers, scheduled jobs and role-gated views for the Wildfire Rescue Queue.
//
// Write path:   Fetch.ai agents / phones / dashboard ──call──▶ reducers (validated, transactional)
// Read path:    everyone ──subscribe──▶ public tables + per-sender views
//
// Invariants the database enforces (so no agent can break them):
//  * a request already assigned to a unit cannot be moved by the policy
//  * a unit can only serve requests in its own station's queue, one at a time
//  * a commander pin always beats the policy
//  * location is purged the moment a request closes or consent expires
import { ScheduleAt, Timestamp } from 'spacetimedb';
import {
  SenderError,
  t,
  type InferSchema,
  type ReducerCtx,
  type ViewCtx,
} from 'spacetimedb/server';
import spacetimedb, {
  AssessmentInput,
  RiskSnapshotInput,
  RequestRiskInput,
  requestRisk,
  DangerInput,
  FireCellInput,
  NewsInput,
  NewsScore,
  SituationInput,
  ForecastCellInput,
  FireRiskCellInput,
  fireRiskCell,
  unitRoute,
  RoadPoint,
  MockRequestInput,
  PlanEntryInput,
  StationInput,
  TravelInput,
  UnitInput,
  UnreachableInput,
  consentTimer,
  fieldReport,
  helpRequest,
  operator,
  reportAssessment,
  requestMessage,
  simTickTimer,
  queueEntry,
  travelEstimate,
  flag,
} from './schema';

export default spacetimedb;

type Schema = InferSchema<typeof spacetimedb>;
type Ctx = ReducerCtx<Schema>;
type VCtx = ViewCtx<Schema>;
type Request = NonNullable<ReturnType<Ctx['db']['helpRequest']['id']['find']>>;

const SIM_TICK_MICROS = 1_000_000n;
// Python/Rust/V8 JSON f64 round trips can differ by an ulp; timestamps have microsecond precision.
const CLOCK_EPS_S = 0.000001;
const NEWS_CONTENT_MAX = 8_000;
const NEWS_KEEP = 300;
const SITUATION_KEEP = 2000;
const EVENT_LOG_KEEP = 400n;
const MIN_CONSENT_MIN = 15;
const MAX_CONSENT_MIN = 24 * 60; // a request (and the location it shares) lives at most 24 h unless extended; "I'm safe" deletes it at once
const LOCKED_EXTENSION_MICROS = 15n * 60n * 1_000_000n;
const MAX_MOCK_PINGS = 25;
const MOCK_CONSENT_MIN = MAX_CONSENT_MIN; // a replay at 30x runs for hours of real time

const AGENT_ROLES = [
  'hazard', 'news', 'fire', 'weather', 'closures', 'forecast', 'danger', 'delegation',
  'station', 'intake', 'commander', 'scenario',
];
const LEVELS = ['unknown', 'unreachable', 'critical', 'high', 'moderate', 'low'];
const ACTIVE = ['pending', 'queued', 'assigned', 'en_route', 'on_scene'];
const LOCKED = ['assigned', 'en_route', 'on_scene']; // a unit is committed
const KNOWN_NEEDS = ['mobility', 'medical', 'oxygen', 'infant', 'elderly', 'pets', 'language'];

const isActive = (r: Request) => ACTIVE.includes(r.status);
const isLocked = (r: Request) => LOCKED.includes(r.status);

// ─── Helpers ────────────────────────────────────────────────────────────────

function simNow(ctx: Ctx): number {
  return ctx.db.simClock.id.find(0)?.simS ?? 0;
}

function log(ctx: Ctx, actor: string, kind: string, message: string, requestId = 0n) {
  const row = ctx.db.eventLog.insert({
    id: 0n,
    at: ctx.timestamp,
    simS: simNow(ctx),
    actor,
    kind,
    message,
    requestId,
  });
  if (row.id > EVENT_LOG_KEEP) ctx.db.eventLog.id.delete(row.id - EVENT_LOG_KEEP);
}

function bump(ctx: Ctx, field: 'weather' | 'fire' | 'roads' | 'requests' | 'forecast' | 'danger' | 'plan'): bigint {
  const v = ctx.db.worldVersion.id.find(0)!;
  const next = v[field] + 1n;
  ctx.db.worldVersion.id.update({ ...v, [field]: next });
  return next;
}

function callerAgent(ctx: Ctx) {
  return ctx.db.agent.identity.find(ctx.sender) ?? undefined;
}

/** Throws unless the caller is a registered agent with one of `roles`. */
function requireAgent(ctx: Ctx, ...roles: string[]) {
  const a = callerAgent(ctx);
  if (!a || !roles.includes(a.role)) {
    throw new SenderError(`requires agent role: ${roles.join('|')}`);
  }
  ctx.db.agent.identity.update({ ...a, lastSeen: ctx.timestamp });
  return a;
}

/** Commander = a human commander operator, or the commander/scenario agent
 *  acting for one. Returns a display name for the audit log. */
function requireCommander(ctx: Ctx): string {
  const op = ctx.db.operator.identity.find(ctx.sender);
  if (op && op.role === 'commander') return `commander:${op.name}`;
  const a = callerAgent(ctx);
  if (a && (a.role === 'commander' || a.role === 'scenario')) return `${a.role}:${a.name}`;
  throw new SenderError('requires commander');
}

/** Station agent or responder operator for `stationId`, or a commander. */
function requireStationActor(ctx: Ctx, stationId: number): string {
  const a = callerAgent(ctx);
  if (a && a.role === 'station' && a.stationId === stationId) return `station:${a.name}`;
  const op = ctx.db.operator.identity.find(ctx.sender);
  if (op && op.role === 'responder' && op.stationId === stationId) return `responder:${op.name}`;
  return requireCommander(ctx);
}

function requireRequest(ctx: Ctx, requestId: bigint): Request {
  const r = ctx.db.helpRequest.id.find(requestId);
  if (!r) throw new SenderError(`request ${requestId} not found`);
  return r;
}

function requireUnit(ctx: Ctx, unitId: number) {
  const u = ctx.db.unit.id.find(unitId);
  if (!u) throw new SenderError(`unit ${unitId} not found`);
  return u;
}

function cleanNeeds(needs: string): string {
  return needs
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => KNOWN_NEEDS.includes(s))
    .filter((s, i, all) => all.indexOf(s) === i)
    .join(',');
}

function needsSummary(r: Request): string {
  const n = r.needs ? `, ${r.needs.replaceAll(',', '/')}` : '';
  return `${r.headcount} ${r.headcount === 1 ? 'person' : 'people'}${n}`;
}

function insideGrid(ctx: Ctx, lat: number, lon: number): boolean {
  const g = ctx.db.grid.id.find(0);
  if (!g || g.rows === 0) return true; // no scenario loaded yet; accept
  const dLat = (g.rows * g.cellSizeM) / 111_320;
  const dLon = (g.cols * g.cellSizeM) / (111_320 * Math.cos((g.originLat * Math.PI) / 180));
  return lat >= g.originLat && lat <= g.originLat + dLat && lon >= g.originLon && lon <= g.originLon + dLon;
}

/** Sample the same published road polyline used by the browser before a mission changes. */
function roadPosition(ctx: Ctx, u: ReturnType<typeof requireUnit>) {
  const route = ctx.db.unitRoute.unitId.find(u.id);
  if (!route?.points.length) return { lat: u.lat, lon: u.lon };
  const f = u.status === 'assigned' ? 0 : u.status === 'on_scene' ? 1 : Math.max(0, Math.min(1, (simNow(ctx) - route.departS) / Math.max(1, route.durationS)));
  const lengths = route.points.slice(1).map((p, i) => Math.hypot((p.lon - route.points[i].lon) * Math.cos((p.lat + route.points[i].lat) * Math.PI / 360), p.lat - route.points[i].lat));
  let left = f * lengths.reduce((sum, n) => sum + n, 0);
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i]) {
      const ratio = lengths[i] ? left / lengths[i] : 0, a = route.points[i], b = route.points[i + 1];
      return { lat: a.lat + (b.lat - a.lat) * ratio, lon: a.lon + (b.lon - a.lon) * ratio };
    }
    left -= lengths[i];
  }
  const last = route.points[route.points.length - 1];
  return { lat: last.lat, lon: last.lon };
}

/** Start the return leg at the current scene/road position and the current replay time. */
function returningUnit(ctx: Ctx, u: ReturnType<typeof requireUnit>) {
  const position = roadPosition(ctx, u), home = ctx.db.station.id.find(u.stationId);
  const dy = home ? (home.lat - position.lat) * 111_320 : 0;
  const dx = home ? (home.lon - position.lon) * 111_320 * Math.cos(position.lat * Math.PI / 180) : 0;
  const now = simNow(ctx);
  return { ...u, ...position, status: 'returning', currentRequest: 0n,
    legDepartS: now, freeAtS: now + Math.hypot(dx, dy) * 1.35 / 12, updatedAt: ctx.timestamp };
}

/** Free the unit (if any), drop the queue entry, purge location. */
function closeRequest(ctx: Ctx, r: Request, status: string, actor: string, why: string) {
  if (!isActive(r)) return;
  for (const u of ctx.db.unit.iter()) {
    if (u.currentRequest === r.id) {
      const returning = returningUnit(ctx, u);
      ctx.db.unitRoute.unitId.delete(u.id);
      ctx.db.unit.id.update(returning);
      log(ctx, actor, 'unit_released', `${u.callsign} released: request #${r.id} ${status}`, r.id);
    }
  }
  ctx.db.queueEntry.requestId.delete(r.id);
  for (const te of [...ctx.db.travelEstimate.requestId.filter(r.id)]) {
    ctx.db.travelEstimate.key.delete(te.key);
  }
  for (const f of [...ctx.db.flag.requestId.filter(r.id)]) {
    if (!f.resolved) ctx.db.flag.id.update({ ...f, resolved: true, resolution: `request ${status}` });
  }
  // What the resident sent (photos, voice, text) goes with the location.
  for (const rep of [...ctx.db.fieldReport.requestId.filter(r.id)]) ctx.db.fieldReport.id.delete(rep.id);
  for (const m of [...ctx.db.requestMessage.requestId.filter(r.id)]) ctx.db.requestMessage.id.delete(m.id);
  ctx.db.reportAssessment.requestId.delete(r.id);
  ctx.db.requestRisk.requestId.delete(r.id);
  ctx.db.helpRequest.id.update({
    ...r,
    status,
    lat: 0,
    lon: 0,
    locationPurged: true,
    entrance: '',
    updatedAt: ctx.timestamp,
  });
  bump(ctx, 'requests');
  log(ctx, actor, `request_${status}`, `Request #${r.id} ${status}${why ? ` (${why})` : ''}; location deleted`, r.id);
}

function createRequest(
  ctx: Ctx,
  args: { channel: string; externalRef: string; lat: number; lon: number; headcount: number; needs: string; note: string; consentMinutes: number; entrance?: string },
  actor: string
): Request {
  if (!Number.isFinite(args.lat) || !Number.isFinite(args.lon)) throw new SenderError('invalid location');
  if (!insideGrid(ctx, args.lat, args.lon)) throw new SenderError('location is outside the active incident area');
  if (args.headcount < 1 || args.headcount > 50) throw new SenderError('headcount must be 1..50');
  if (args.note.length > 500) throw new SenderError('note too long (max 500 chars)');
  const minutes = Math.min(MAX_CONSENT_MIN, Math.max(MIN_CONSENT_MIN, Math.round(args.consentMinutes)));
  const expiresMicros = ctx.timestamp.microsSinceUnixEpoch + BigInt(minutes) * 60_000_000n;

  const r = ctx.db.helpRequest.insert({
    id: 0n,
    resident: ctx.sender,
    channel: args.channel,
    externalRef: args.externalRef,
    lat: args.lat,
    lon: args.lon,
    locationPurged: false,
    headcount: args.headcount,
    needs: cleanNeeds(args.needs),
    note: args.note,
    status: 'pending',
    createdAt: ctx.timestamp,
    createdSimS: simNow(ctx),
    consentExpiresAt: new Timestamp(expiresMicros),
    level: 'unknown',
    slackS: undefined,
    fireEtaS: undefined,
    extractS: 0,
    dangerVersion: 0n,
    pinnedStationId: 0,
    hopCount: 0,
    updatedAt: ctx.timestamp,
    entrance: (args.entrance ?? '').trim().slice(0, 200),
  });
  ctx.db.consentTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(expiresMicros), requestId: r.id });
  bump(ctx, 'requests');
  log(ctx, actor, 'request_new', `New help request #${r.id} via ${args.channel}: ${needsSummary(r)}; consent ${minutes} min`, r.id);
  return r;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export const init = spacetimedb.init(ctx => {
  ctx.db.simClock.insert({ id: 0, simS: 0, speed: 20, running: false, scenario: 'none', lastTick: ctx.timestamp });
  ctx.db.grid.insert({ id: 0, originLat: 0, originLon: 0, cellSizeM: 0, rows: 0, cols: 0 });
  ctx.db.weather.insert({
    id: 0, windSpeedMps: 0, windFromDeg: 0, gustMps: 0, source: 'none', locked: false, updatedAt: ctx.timestamp,
  });
  ctx.db.forecastMeta.insert({
    id: 0, version: 0n, computedAtS: 0, horizonS: 0, members: 0, weatherVersion: 0n, fireVersion: 0n, updatedAt: ctx.timestamp,
  });
  ctx.db.worldVersion.insert({ id: 0, weather: 0n, fire: 0n, roads: 0n, requests: 0n, forecast: 0n, danger: 0n, plan: 0n });
  ctx.db.simTickTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(SIM_TICK_MICROS) });
});

export const onConnect = spacetimedb.clientConnected(_ctx => {});

// HTTP reducer calls also connect/disconnect, so agent liveness is judged from
// agent.last_seen (heartbeat every 10 s) rather than from disconnect events.
export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {});

// ─── Scheduled jobs ─────────────────────────────────────────────────────────

/** Advances the shared simulation clock. Every agent keys off sim_clock, so
 *  the whole system (fire, ETAs, unit movement) stays in lockstep. */
export const sim_tick = spacetimedb.reducer({ onSchedule: simTickTimer }, { timer: simTickTimer.rowType }, ctx => {
  const c = ctx.db.simClock.id.find(0);
  if (!c) return;
  const dtS = Number(ctx.timestamp.microsSinceUnixEpoch - c.lastTick.microsSinceUnixEpoch) / 1e6;
  const simS = c.running ? c.simS + Math.min(dtS, 5) * c.speed : c.simS;
  ctx.db.simClock.id.update({ ...c, simS, lastTick: ctx.timestamp });
});

/** Fires when a resident's consent window ends. Location is deleted unless a
 *  unit is already on the way, in which case consent is extended in 15-min
 *  steps so we never strand a crew mid-rescue. */
export const expire_consent = spacetimedb.reducer({ onSchedule: consentTimer }, { timer: consentTimer.rowType }, (ctx, { timer }) => {
  const r = ctx.db.helpRequest.id.find(timer.requestId);
  if (!r || !isActive(r)) return;
  if (r.consentExpiresAt.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch) return; // extended since
  if (isLocked(r)) {
    const next = ctx.timestamp.microsSinceUnixEpoch + LOCKED_EXTENSION_MICROS;
    ctx.db.helpRequest.id.update({ ...r, consentExpiresAt: new Timestamp(next), updatedAt: ctx.timestamp });
    ctx.db.consentTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(next), requestId: r.id });
    log(ctx, 'system', 'consent_extended', `Request #${r.id}: consent window ended mid-rescue; held 15 more min`, r.id);
    return;
  }
  closeRequest(ctx, r, 'expired', 'system', 'consent window ended');
});


// ─── Registration ───────────────────────────────────────────────────────────

/** A Fetch.ai agent joins the shared state. Its SpacetimeDB identity is
 *  bound to one role; every privileged reducer checks that role. */
export const register_agent = spacetimedb.reducer(
  { joinKey: t.string(), role: t.string(), name: t.string(), stationId: t.u32(), fetchAddress: t.string() },
  (ctx, { joinKey, role, name, stationId, fetchAddress }) => {
    if (joinKey !== ctx.env.AGENT_JOIN_KEY) throw new SenderError('bad join key');
    if (!AGENT_ROLES.includes(role)) throw new SenderError(`unknown role ${role}`);
    if (role === 'station' && !ctx.db.station.id.find(stationId)) throw new SenderError(`station ${stationId} not found`);
    const row = {
      identity: ctx.sender,
      role,
      name,
      stationId: role === 'station' ? stationId : 0,
      fetchAddress,
      status: 'online',
      detail: '',
      lastSeen: ctx.timestamp,
    };
    const existing = ctx.db.agent.identity.find(ctx.sender);
    if (existing) ctx.db.agent.identity.update(row);
    else ctx.db.agent.insert(row);
    log(ctx, `${role}:${name}`, 'agent_online', `${name} (${role}) joined the mesh`);
  }
);

export const agent_heartbeat = spacetimedb.reducer(
  { status: t.string(), detail: t.string() },
  (ctx, { status, detail }) => {
    const a = callerAgent(ctx);
    if (!a) throw new SenderError('not a registered agent');
    ctx.db.agent.identity.update({ ...a, status, detail: detail.slice(0, 200), lastSeen: ctx.timestamp });
  }
);

export const claim_operator = spacetimedb.reducer(
  { passcode: t.string(), role: t.string(), stationId: t.u32(), name: t.string() },
  (ctx, { passcode, role, stationId, name }) => {
    if (passcode !== ctx.env.OPERATOR_PASSCODE) throw new SenderError('bad passcode');
    if (role !== 'commander' && role !== 'responder') throw new SenderError('role must be commander|responder');
    if (role === 'responder' && !ctx.db.station.id.find(stationId)) throw new SenderError(`station ${stationId} not found`);
    const row = { identity: ctx.sender, role, stationId: role === 'responder' ? stationId : 0, name, joinedAt: ctx.timestamp };
    if (ctx.db.operator.identity.find(ctx.sender)) ctx.db.operator.identity.update(row);
    else ctx.db.operator.insert(row);
    log(ctx, `${role}:${name}`, 'operator_joined', `${name} signed in as ${role}`);
  }
);

// ─── Scenario & clock ───────────────────────────────────────────────────────

/** Wipes incident state and loads a fresh world. One transaction: every
 *  subscriber sees the old world vanish and the new one appear atomically. */
export const load_scenario = spacetimedb.reducer(
  {
    name: t.string(),
    originLat: t.f64(),
    originLon: t.f64(),
    cellSizeM: t.f64(),
    rows: t.u32(),
    cols: t.u32(),
    stations: t.array(StationInput),
    units: t.array(UnitInput),
    speed: t.f64(),
    windSpeedMps: t.f64(),
    windFromDeg: t.f64(),
  },
  (ctx, a) => {
    const actor = requireCommander(ctx);
    if (a.rows === 0 || a.cols === 0 || a.rows * a.cols > 40_000) throw new SenderError('grid must be 1..40000 cells');
    for (const r of [...ctx.db.helpRequest.iter()]) ctx.db.helpRequest.id.delete(r.id);
    for (const r of [...ctx.db.queueEntry.iter()]) ctx.db.queueEntry.requestId.delete(r.requestId);
    for (const r of [...ctx.db.travelEstimate.iter()]) ctx.db.travelEstimate.key.delete(r.key);
    for (const r of [...ctx.db.flag.iter()]) ctx.db.flag.id.delete(r.id);
    for (const r of [...ctx.db.consentTimer.iter()]) ctx.db.consentTimer.scheduledId.delete(r.scheduledId);
    for (const r of [...ctx.db.fireCell.iter()]) ctx.db.fireCell.cellId.delete(r.cellId);
    for (const r of [...ctx.db.forecastCell.iter()]) ctx.db.forecastCell.cellId.delete(r.cellId);
    for (const r of [...ctx.db.fireRiskCell.iter()]) ctx.db.fireRiskCell.key.delete(r.key);
    ctx.db.fireRiskMeta.id.delete(0);
    ctx.db.riskPipeline.id.delete(0);
    for (const r of [...ctx.db.requestRisk.iter()]) ctx.db.requestRisk.requestId.delete(r.requestId);
    for (const r of [...ctx.db.roadClosure.iter()]) ctx.db.roadClosure.id.delete(r.id);
    for (const r of [...ctx.db.unitRoute.iter()]) ctx.db.unitRoute.unitId.delete(r.unitId);
    for (const r of [...ctx.db.replayObservation.iter()]) ctx.db.replayObservation.sequence.delete(r.sequence);
    for (const r of [...ctx.db.incident.iter()]) ctx.db.incident.id.delete(r.id);
    for (const r of [...ctx.db.newsFocus.iter()]) ctx.db.newsFocus.id.delete(r.id);
    for (const r of [...ctx.db.crewPresence.iter()]) ctx.db.crewPresence.unitId.delete(r.unitId);
    for (const r of [...ctx.db.unit.iter()]) ctx.db.unit.id.delete(r.id);
    for (const r of [...ctx.db.station.iter()]) ctx.db.station.id.delete(r.id);
    for (const r of [...ctx.db.operator.iter()]) {
      if (r.role === 'responder') ctx.db.operator.identity.delete(r.identity);
    }

    ctx.db.grid.id.update({ id: 0, originLat: a.originLat, originLon: a.originLon, cellSizeM: a.cellSizeM, rows: a.rows, cols: a.cols });
    for (const s of a.stations) ctx.db.station.insert(s);
    for (const u of a.units) {
      const s = ctx.db.station.id.find(u.stationId);
      if (!s) throw new SenderError(`unit ${u.callsign}: station ${u.stationId} not found`);
      ctx.db.unit.insert({
        ...u, status: 'available', lat: s.lat, lon: s.lon, currentRequest: 0n, freeAtS: 0, legDepartS: 0, updatedAt: ctx.timestamp,
      });
    }
    const c = ctx.db.simClock.id.find(0)!;
    ctx.db.simClock.id.update({ ...c, simS: 0, speed: a.speed, running: false, scenario: a.name, lastTick: ctx.timestamp });
    const w = ctx.db.weather.id.find(0)!;
    ctx.db.weather.id.update({
      ...w, windSpeedMps: a.windSpeedMps, windFromDeg: a.windFromDeg, gustMps: a.windSpeedMps, source: 'scenario', locked: false, updatedAt: ctx.timestamp,
    });
    const fm = ctx.db.forecastMeta.id.find(0)!;
    ctx.db.forecastMeta.id.update({ ...fm, computedAtS: 0, horizonS: 0, members: 0, updatedAt: ctx.timestamp });
    for (const f of ['weather', 'fire', 'roads', 'requests', 'forecast', 'danger', 'plan'] as const) bump(ctx, f);
    log(ctx, actor, 'scenario_loaded', `Scenario "${a.name}": ${a.stations.length} stations, ${a.units.length} units, ${a.rows}x${a.cols} grid`);
  }
);

export const set_sim = spacetimedb.reducer(
  { running: t.bool(), speed: t.f64() },
  (ctx, { running, speed }) => {
    const actor = requireCommander(ctx);
    if (!(speed > 0 && speed <= 600)) throw new SenderError('speed must be in (0, 600]');
    const c = ctx.db.simClock.id.find(0)!;
    ctx.db.simClock.id.update({ ...c, running, speed, lastTick: ctx.timestamp });
    log(ctx, actor, 'sim', `Simulation ${running ? 'running' : 'paused'} at ${speed}x`);
  }
);

/** Acquisition times alone disclose no future perimeter pixels to the forecast model. */
export const set_replay_schedule = spacetimedb.reducer({ offsets: t.array(t.f64()) }, (ctx, { offsets }) => {
  requireCommander(ctx);
  if (!offsets.length || offsets.some((s, i) => !Number.isFinite(s) || s < 0 || (i > 0 && s <= offsets[i - 1]))) throw new SenderError('invalid acquisition schedule');
  for (const r of [...ctx.db.replayObservation.iter()]) ctx.db.replayObservation.sequence.delete(r.sequence);
  offsets.forEach((atS, sequence) => ctx.db.replayObservation.insert({ sequence, atS }));
});

/** Move forward to the next actual acquisition and pause there while agents reforecast. */
export const advance_replay = spacetimedb.reducer(ctx => {
  const actor = requireCommander(ctx);
  const c = ctx.db.simClock.id.find(0)!;
  const next = [...ctx.db.replayObservation.iter()].filter(o => o.atS > c.simS + 0.001).sort((a, b) => a.atS - b.atS)[0];
  if (!next) throw new SenderError('last recorded observation reached');
  ctx.db.simClock.id.update({ ...c, simS: next.atS, running: false, lastTick: ctx.timestamp });
  const pipeline = ctx.db.riskPipeline.id.find(0);
  if (pipeline) ctx.db.riskPipeline.id.update({ ...pipeline, status: 'pending', reason: 'Loading the next acquired perimeter and U-Net prediction', updatedAt: ctx.timestamp });
  log(ctx, actor, 'replay_advanced', `Advanced to acquired observation ${next.sequence + 1}`, 0n);
});

// ─── Weather (live feed + the judge's wind slider) ──────────────────────────

export const set_weather = spacetimedb.reducer(
  { windSpeedMps: t.f64(), windFromDeg: t.f64(), gustMps: t.f64(), source: t.string() },
  (ctx, { windSpeedMps, windFromDeg, gustMps, source }) => {
    if (!(windSpeedMps >= 0 && windSpeedMps < 80)) throw new SenderError('wind speed out of range');
    const w = ctx.db.weather.id.find(0)!;
    const a = callerAgent(ctx);
    let manual = true;
    let actor: string;
    if (a && (a.role === 'weather' || a.role === 'hazard')) {
      manual = false;
      actor = `weather:${a.name}`;
      if (w.locked) return; // commander has manual control; feed is advisory only
    } else {
      actor = requireCommander(ctx);
    }
    const dir = ((windFromDeg % 360) + 360) % 360;
    ctx.db.weather.id.update({
      id: 0, windSpeedMps, windFromDeg: dir, gustMps: Math.max(gustMps, windSpeedMps),
      source: manual ? 'manual' : source, locked: manual ? true : w.locked, updatedAt: ctx.timestamp,
    });
    bump(ctx, 'weather');
    const shift = Math.abs(((dir - w.windFromDeg + 540) % 360) - 180);
    if (manual || shift >= 20 || Math.abs(windSpeedMps - w.windSpeedMps) >= 3) {
      log(ctx, actor, 'wind', `Wind now ${windSpeedMps.toFixed(1)} m/s from ${dir.toFixed(0)}°${manual ? ' (manual)' : ''}`);
    }
  }
);

export const release_weather_lock = spacetimedb.reducer(ctx => {
  const actor = requireCommander(ctx);
  const w = ctx.db.weather.id.find(0)!;
  ctx.db.weather.id.update({ ...w, locked: false, updatedAt: ctx.timestamp });
  log(ctx, actor, 'wind', 'Manual wind released; live weather feed resumed');
});

// ─── Fire / forecast / roads ────────────────────────────────────────────────

export const upsert_fire_cells = spacetimedb.reducer(
  { cells: t.array(FireCellInput), replace: t.bool(), source: t.string() },
  (ctx, { cells, replace, source }) => {
    const a = callerAgent(ctx);
    const actor = a && (a.role === 'fire' || a.role === 'hazard') ? `${a.role}:${a.name}` : requireCommander(ctx);
    if (replace) for (const r of [...ctx.db.fireCell.iter()]) ctx.db.fireCell.cellId.delete(r.cellId);
    let added = 0;
    for (const c of cells) {
      const existing = ctx.db.fireCell.cellId.find(c.cellId);
      if (existing) {
        if (existing.intensity !== c.intensity) ctx.db.fireCell.cellId.update({ ...existing, intensity: c.intensity });
      } else {
        ctx.db.fireCell.insert({ ...c, source });
        // A cell that is now burning has no "arrival" left to forecast.
        ctx.db.forecastCell.cellId.delete(c.cellId);
        added++;
      }
    }
    bump(ctx, 'fire');
    if (replace || added >= 25) log(ctx, actor, 'fire', `Fire perimeter update (${source}): +${added} cells`);
  }
);

/** Atomically replaces the arrival-time forecast. Cells omitted from
 *  `cells` are deleted (beyond horizon, or already burning). */
export const publish_forecast = spacetimedb.reducer(
  {
    weatherVersion: t.u64(),
    fireVersion: t.u64(),
    computedAtS: t.f64(),
    horizonS: t.f64(),
    members: t.u32(),
    cells: t.array(ForecastCellInput),
  },
  (ctx, a) => {
    requireAgent(ctx, 'forecast', 'hazard');
    const inputs = ctx.db.worldVersion.id.find(0)!;
    if (a.weatherVersion !== inputs.weather || a.fireVersion !== inputs.fire)
      throw new SenderError('stale physical forecast snapshot; recompute from current world');
    if (!Number.isFinite(a.computedAtS) || a.computedAtS > ctx.db.simClock.id.find(0)!.simS + CLOCK_EPS_S)
      throw new SenderError('physical forecast issue is ahead of simulation clock');
    const keep = new Set<number>();
    for (const c of a.cells) {
      keep.add(c.cellId);
      if (ctx.db.fireCell.cellId.find(c.cellId)) continue;
      const existing = ctx.db.forecastCell.cellId.find(c.cellId);
      if (!existing) ctx.db.forecastCell.insert(c);
      else if (existing.arrivalEarlyS !== c.arrivalEarlyS || existing.arrivalMedianS !== c.arrivalMedianS) ctx.db.forecastCell.cellId.update(c);
    }
    for (const r of [...ctx.db.forecastCell.iter()]) if (!keep.has(r.cellId)) ctx.db.forecastCell.cellId.delete(r.cellId);
    const version = bump(ctx, 'forecast');
    ctx.db.forecastMeta.id.update({
      id: 0, version, computedAtS: a.computedAtS, horizonS: a.horizonS, members: a.members,
      weatherVersion: a.weatherVersion, fireVersion: a.fireVersion, updatedAt: ctx.timestamp,
    });
  }
);

/** Optional historical probability layer. Existing forecast_cell remains the
 * short-horizon physics contract consumed by danger/routing/Lookahead.
 * Reject stale snapshots atomically rather than publishing mixed world state.
 */
const fireRiskArgs = {
    weatherVersion: t.u64(), fireVersion: t.u64(), expectedClockS: t.f64(),
    schemaVersion: t.string(), modelId: t.string(), source: t.string(), timeBasis: t.string(),
    issueS: t.f64(), observationAgeS: t.f64(), horizonsS: t.array(t.f64()),
    crs: t.string(), westM: t.f64(), southM: t.f64(), cellSizeM: t.f64(),
    rows: t.u32(), cols: t.u32(), qualityFlags: t.array(t.string()),
    cells: t.array(FireRiskCellInput),
  };
type RiskPublication = {
  weatherVersion: bigint; fireVersion: bigint; expectedClockS: number;
  schemaVersion: string; modelId: string; source: string; timeBasis: string;
  issueS: number; observationAgeS: number; horizonsS: number[]; crs: string;
  westM: number; southM: number; cellSizeM: number; rows: number; cols: number;
  qualityFlags: string[]; cells: { cellId: number; horizonS: number; probability: number; observed: boolean }[];
  forecastId?: string; observationId?: string; scenario?: string; sourceIssueUtcS?: number;
};
function storeFireRisk(ctx: Ctx, a: RiskPublication, recorded = false) {
    requireAgent(ctx, 'forecast', 'hazard');
    const v = ctx.db.worldVersion.id.find(0)!;
    const clock = ctx.db.simClock.id.find(0)!;
    if (v.weather !== a.weatherVersion || v.fire !== a.fireVersion
        || (recorded ? a.expectedClockS > clock.simS + CLOCK_EPS_S || a.expectedClockS < 0 || a.scenario !== clock.scenario
                     : Math.abs(clock.simS - a.expectedClockS) > CLOCK_EPS_S))
      throw new SenderError('stale risk snapshot; recompute from current world');
    if (a.schemaVersion !== 'wildfire-risk-v1' || !['learned', 'simulation', 'persistence'].includes(a.source))
      throw new SenderError('unsupported risk schema/source');
    if (!['historical_utc', 'simulation'].includes(a.timeBasis)) throw new SenderError('explicit time basis required');
    if (a.timeBasis === 'simulation' && a.issueS > clock.simS + CLOCK_EPS_S) throw new SenderError('risk issue ahead of simulation clock');
    if (!a.modelId || !a.crs || a.rows === 0 || a.cols === 0 || a.rows * a.cols > 40000)
      throw new SenderError('invalid risk model/geographic grid');
    if (![a.issueS, a.observationAgeS, a.westM, a.southM, a.cellSizeM].every(Number.isFinite)
        || a.observationAgeS < 0 || a.cellSizeM <= 0) throw new SenderError('invalid risk units');
    if (a.horizonsS.length === 0 || a.horizonsS.length > 8 || a.horizonsS.some((h, i) =>
      !Number.isFinite(h) || h <= 0 || (i > 0 && h <= a.horizonsS[i - 1]))) throw new SenderError('invalid risk horizons');
    const byCell = new Map<number, Map<number, number>>();
    const keys = new Set<string>();
    for (const c of a.cells) {
      const key = `${c.cellId}:${c.horizonS}`;
      if (keys.has(key) || c.cellId >= a.rows * a.cols || !a.horizonsS.includes(c.horizonS)
          || !Number.isFinite(c.probability) || c.probability < 0 || c.probability > 1)
        throw new SenderError('invalid/duplicate risk probability');
      keys.add(key);
      if (!byCell.has(c.cellId)) byCell.set(c.cellId, new Map());
      byCell.get(c.cellId)!.set(c.horizonS, c.probability);
    }
    for (const probabilities of byCell.values()) {
      if (probabilities.size !== a.horizonsS.length) throw new SenderError('incomplete cell horizons');
      for (let i = 1; i < a.horizonsS.length; i++)
        if (probabilities.get(a.horizonsS[i])! < probabilities.get(a.horizonsS[i - 1])!)
          throw new SenderError('cumulative risk must not decrease');
    }
    for (const row of [...ctx.db.fireRiskCell.iter()]) ctx.db.fireRiskCell.key.delete(row.key);
    for (const c of a.cells) ctx.db.fireRiskCell.insert({ key: `${c.cellId}:${c.horizonS}`, ...c });
    const { cells: _cells, expectedClockS: _clock, ...metadata } = a;
    const row = { id: 0, forecastId: '', observationId: '', scenario: '', sourceIssueUtcS: 0,
                  ...metadata, updatedAt: ctx.timestamp };
    if (ctx.db.fireRiskMeta.id.find(0)) ctx.db.fireRiskMeta.id.update(row);
    else ctx.db.fireRiskMeta.insert(row);
    log(ctx, 'hazard', 'fire_risk_published', `Supplementary ${a.source} risk, ${a.cells.length} cells; ${a.timeBasis}, no minute ETA`);
    if (recorded) {
      const state = { id: 0, scenario: clock.scenario, sourceId: a.observationId ?? '',
        status: 'ready', activeBackend: 'learned', reason: 'Recorded exposure forecast available',
        forecastId: a.forecastId ?? '', updatedAt: ctx.timestamp };
      if (ctx.db.riskPipeline.id.find(0)) ctx.db.riskPipeline.id.update(state);
      else ctx.db.riskPipeline.insert(state);
    }
}
export const publish_fire_risk = spacetimedb.reducer(fireRiskArgs, (ctx, a) => storeFireRisk(ctx, a));

/** Recorded products use scenario/observation identity and permit clock progress during inference. */
const { cells: _legacyCells, ...recordedRiskArgs } = fireRiskArgs;
export const publish_recorded_fire_risk = spacetimedb.reducer({
  ...recordedRiskArgs, cellIds: t.array(t.u32()), probabilities: t.array(t.f64()), observedCellIds: t.array(t.u32()),
  forecastId: t.string(), observationId: t.string(), scenario: t.string(), sourceIssueUtcS: t.f64(),
}, (ctx, a) => {
  if (!a.forecastId || !a.observationId || !Number.isFinite(a.sourceIssueUtcS)
      || a.timeBasis !== 'simulation' || a.source !== 'learned') throw new SenderError('invalid recorded risk identity');
  const { cellIds, probabilities, observedCellIds, ...metadata } = a;
  if (!cellIds.length || cellIds.length > 40000 || new Set(cellIds).size !== cellIds.length
      || probabilities.length !== cellIds.length * a.horizonsS.length)
    throw new SenderError('incomplete dense risk probabilities');
  const valid = new Set(cellIds), observed = new Set(observedCellIds);
  if (observedCellIds.some(id => !valid.has(id))) throw new SenderError('observed risk cell outside valid domain');
  const cells = a.horizonsS.flatMap((horizonS, h) => cellIds.map((cellId, i) => ({
    cellId, horizonS, probability: probabilities[h * cellIds.length + i], observed: observed.has(cellId),
  })));
  storeFireRisk(ctx, { ...metadata, cells }, true);
});

export const publish_risk_pipeline_status = spacetimedb.reducer({
  scenario: t.string(), sourceId: t.string(), status: t.string(), activeBackend: t.string(), reason: t.string(),
}, (ctx, a) => {
  requireAgent(ctx, 'hazard');
  if (a.scenario !== ctx.db.simClock.id.find(0)!.scenario) throw new SenderError('stale risk scenario');
  if (!['fallback', 'error', 'disabled'].includes(a.status)) throw new SenderError('invalid risk status');
  const row = { id: 0, ...a, reason: a.reason.slice(0, 1000), forecastId: '', updatedAt: ctx.timestamp };
  if (ctx.db.riskPipeline.id.find(0)) ctx.db.riskPipeline.id.update(row);
  else ctx.db.riskPipeline.insert(row);
});

export const add_road_closure = spacetimedb.reducer(
  { name: t.string(), lat1: t.f64(), lon1: t.f64(), lat2: t.f64(), lon2: t.f64(), source: t.string() },
  (ctx, a) => {
    const ag = callerAgent(ctx);
    const actor = ag && (ag.role === 'closures' || ag.role === 'fire' || ag.role === 'hazard') ? `${ag.role}:${ag.name}` : requireCommander(ctx);
    ctx.db.roadClosure.insert({ id: 0n, ...a, active: true, updatedAt: ctx.timestamp });
    bump(ctx, 'roads');
    log(ctx, actor, 'road_closed', `Road closed: ${a.name} (${a.source})`);
  }
);

export const set_road_closure_active = spacetimedb.reducer(
  { id: t.u64(), active: t.bool() },
  (ctx, { id, active }) => {
    const ag = callerAgent(ctx);
    const actor = ag && ag.role === 'closures' ? `closures:${ag.name}` : requireCommander(ctx);
    const rc = ctx.db.roadClosure.id.find(id);
    if (!rc) throw new SenderError(`closure ${id} not found`);
    ctx.db.roadClosure.id.update({ ...rc, active, updatedAt: ctx.timestamp });
    bump(ctx, 'roads');
    log(ctx, actor, active ? 'road_closed' : 'road_opened', `Road ${active ? 'closed' : 'reopened'}: ${rc.name}`);
  }
);

// ─── News (X posts via Bright Data, through the news agent) ──────────────────

/** Upsert collected posts by URL. New relevant posts with actionable signals
 *  (evacuations, closures, shelters / relief) are surfaced in the event feed;
 *  the commander decides what to act on. Keeps the newest NEWS_KEEP rows. */
export const publish_news = spacetimedb.reducer(
  { articles: t.array(NewsInput) },
  (ctx, { articles }) => {
    const ag = requireAgent(ctx, 'news');
    const actor = `news:${ag.name}`;
    let added = 0;
    for (const a of articles) {
      if (!a.url.startsWith('http')) continue;
      const row = {
        url: a.url, source: a.source, incident: a.incident.slice(0, 80), title: a.title.slice(0, 300), author: a.author.slice(0, 200),
        publishedRaw: a.publishedRaw.slice(0, 80),
        publishedAt: a.publishedMicros > 0n ? new Timestamp(a.publishedMicros) : undefined,
        category: a.category.slice(0, 80), tags: a.tags.slice(0, 500), summary: a.summary.slice(0, 800),
        content: a.content.slice(0, NEWS_CONTENT_MAX), query: a.query.slice(0, 200),
        relevance: Math.max(0, Math.min(1, a.relevance)), locationMatch: a.locationMatch.slice(0, 200),
        evacuation: a.evacuation, closures: a.closures.slice(0, 1000),
        official: a.official, relief: a.relief.slice(0, 1000),
        containmentPct: a.containmentPct >= 0 ? a.containmentPct : undefined,
        acres: a.acres >= 0 ? a.acres : undefined,
        fetchedAt: ctx.timestamp,
      };
      const existing = ctx.db.newsArticle.url.find(a.url);
      if (existing) {
        ctx.db.newsArticle.id.update({ ...existing, ...row });
        continue;
      }
      const inserted = ctx.db.newsArticle.insert({ id: 0n, ...row });
      added++;
      if (row.relevance >= 0.5 && (row.evacuation || row.closures || row.relief)) {
        const what = [
          row.evacuation ? 'evacuation orders' : '', row.closures ? 'road closures' : '', row.relief ? 'shelters / relief' : '',
        ].filter(Boolean).join(' + ');
        log(ctx, actor, 'news', `News: ${what} reported by ${row.source.slice(0, 40)} — "${row.title.slice(0, 100)}"`);
      }
      if (inserted.id > BigInt(NEWS_KEEP)) ctx.db.newsArticle.id.delete(inserted.id - BigInt(NEWS_KEEP));
    }
    if (added) log(ctx, actor, 'news_batch', `${added} new post(s) ingested from X`);
  }
);

/** The news agent re-scores stored posts when the focus moves (relevance depends on where we look). */
export const rescore_news = spacetimedb.reducer(
  { scores: t.array(NewsScore) },
  (ctx, { scores }) => {
    requireAgent(ctx, 'news');
    for (const s of scores) {
      const existing = ctx.db.newsArticle.url.find(s.url);
      if (!existing) continue;
      ctx.db.newsArticle.id.update({
        ...existing, relevance: Math.max(0, Math.min(1, s.relevance)), locationMatch: s.locationMatch.slice(0, 200),
      });
    }
  }
);

/** Operators (commander, responders) and registered agents may move the news focus. Not residents: every
 *  move can start a billed scrape, and their help requests already lie inside the incident area. */
function requirePinger(ctx: Ctx): string {
  const op = ctx.db.operator.identity.find(ctx.sender);
  if (op) return `${op.role}:${op.name}`;
  const a = callerAgent(ctx);
  if (a) return `${a.role}:${a.name}`;
  throw new SenderError('requires an operator or a registered agent');
}

/** Point the news agent at a location ("ping"). It follows the trusted X accounts near it, for the current
 *  time window (the incident's, or live). */
export const ping_news = spacetimedb.reducer(
  { lat: t.f64(), lon: t.f64(), label: t.string() },
  (ctx, { lat, lon, label }) => {
    const actor = requirePinger(ctx);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new SenderError('lat/lon out of range');
    const row = { id: 0, lat, lon, label: label.trim().slice(0, 120), setBy: actor, updatedAt: ctx.timestamp };
    if (ctx.db.newsFocus.id.find(0)) ctx.db.newsFocus.id.update(row);
    else ctx.db.newsFocus.insert(row);
    log(ctx, actor, 'news_focus', `News focus: ${row.label || 'pinned location'} (${lat.toFixed(3)}, ${lon.toFixed(3)})`);
  }
);

export const clear_news_focus = spacetimedb.reducer(ctx => {
  const actor = requirePinger(ctx);
  for (const r of [...ctx.db.newsFocus.iter()]) ctx.db.newsFocus.id.delete(r.id);
  log(ctx, actor, 'news_focus', 'News focus cleared');
});

/** Select the real-world incident being replayed (and its news date window): the WHEN for every agent.
 *  Any window works (a catalog fire, or a custom range such as 2020-09-27 → 2020-10-20); queries (fire
 *  names, for relevance) may be empty. Commander (or the scenario loader) only. Switching incidents never
 *  deletes stored news: each post is tagged with the incident it was scraped for. */
export const set_incident = spacetimedb.reducer(
  {
    key: t.string(), name: t.string(),
    startMicros: t.i64(), newsFromMicros: t.i64(), newsToMicros: t.i64(),
    location: t.string(), queries: t.string(), places: t.string(),
  },
  (ctx, a) => {
    const actor = requireCommander(ctx);
    if (a.newsToMicros < a.newsFromMicros) throw new SenderError('news window ends before it starts');
    const row = {
      id: 0, key: a.key, name: a.name, startAt: new Timestamp(a.startMicros),
      newsFrom: new Timestamp(a.newsFromMicros), newsTo: new Timestamp(a.newsToMicros),
      location: a.location, queries: a.queries, places: a.places, updatedAt: ctx.timestamp,
    };
    if (ctx.db.incident.id.find(0)) ctx.db.incident.id.update(row);
    else ctx.db.incident.insert(row);
    log(ctx, actor, 'incident', `Incident set: ${a.name}`);
  }
);

export const clear_incident = spacetimedb.reducer(ctx => {
  const actor = requireCommander(ctx);
  for (const r of [...ctx.db.incident.iter()]) ctx.db.incident.id.delete(r.id);
  log(ctx, actor, 'incident', 'Incident cleared; live mode');
});

// ─── Head agent ─────────────────────────────────────────────────────────────

/** The delegation (head) agent records the situation it synthesized from the hazard and news
 *  reports. Only that agent may write it. */
export const record_situation = spacetimedb.reducer(
  { s: SituationInput },
  (ctx, { s }) => {
    requireAgent(ctx, 'commander', 'delegation');
    const row = ctx.db.situation.insert({ id: 0n, at: ctx.timestamp, ...s, summary: s.summary.slice(0, 1500), stationsJson: s.stationsJson.slice(0, 2000), staleReasons: s.staleReasons.slice(0, 300) });
    if (row.id > BigInt(SITUATION_KEEP)) ctx.db.situation.id.delete(row.id - BigInt(SITUATION_KEEP));
  }
);

// ─── Residents ────────────────────────────────────────────────────────────────

/** The one button. Called by the resident's own phone; ctx.sender is them. */
export const submit_help_request = spacetimedb.reducer(
  { lat: t.f64(), lon: t.f64(), headcount: t.u32(), needs: t.string(), note: t.string(), consentMinutes: t.u32() },
  (ctx, a) => {
    for (const r of ctx.db.helpRequest.resident.filter(ctx.sender)) {
      if (isActive(r) && r.externalRef === '') throw new SenderError(`you already have an active request (#${r.id})`);
    }
    createRequest(ctx, { ...a, channel: 'app', externalRef: '' }, 'resident');
  }
);

/** Browser retries recover the sender's existing active request, without duplicating it. */
export const submit_app_request = spacetimedb.reducer(
  { lat: t.f64(), lon: t.f64(), headcount: t.u32(), needs: t.string(), note: t.string(), entrance: t.string(), consentMinutes: t.u32() },
  (ctx, a) => {
    for (const r of ctx.db.helpRequest.resident.filter(ctx.sender)) {
      if (isActive(r) && r.externalRef === '') return;
    }
    createRequest(ctx, { ...a, channel: 'app', externalRef: '' }, 'resident');
  }
);

/** Location, entrance and household edits commit together and invalidate the old risk inputs. */
export const update_my_request = spacetimedb.reducer(
  { requestId: t.u64(), lat: t.f64(), lon: t.f64(), headcount: t.u32(), needs: t.string(), note: t.string(), entrance: t.string() },
  (ctx, a) => {
    const r = requireRequest(ctx, a.requestId);
    if (!r.resident.isEqual(ctx.sender) || r.externalRef !== '') throw new SenderError('not your request');
    if (!isActive(r)) throw new SenderError('request is closed');
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) throw new SenderError('invalid location');
    if (!insideGrid(ctx, a.lat, a.lon)) throw new SenderError('location is outside the active incident area');
    if (a.headcount < 1 || a.headcount > 50) throw new SenderError('headcount must be 1..50');
    if (a.note.length > 500) throw new SenderError('note too long (max 500 chars)');
    ctx.db.helpRequest.id.update({ ...r, lat: a.lat, lon: a.lon, headcount: a.headcount, needs: cleanNeeds(a.needs),
      note: a.note, entrance: a.entrance.trim().slice(0, 200), updatedAt: ctx.timestamp });
    bump(ctx, 'requests');
    log(ctx, 'resident', 'request_updated', `Request #${r.id}: location or household updated; reassessment pending`, r.id);
  }
);

/** Same, submitted by the ASI:One intake agent (or the synthetic-resident
 *  generator) on behalf of `externalRef`. One active request per ref. */
export const submit_help_request_for = spacetimedb.reducer(
  {
    externalRef: t.string(), channel: t.string(), lat: t.f64(), lon: t.f64(),
    headcount: t.u32(), needs: t.string(), note: t.string(), consentMinutes: t.u32(),
  },
  (ctx, a) => {
    const ag = requireAgent(ctx, 'intake', 'scenario');
    if (!a.externalRef) throw new SenderError('externalRef required');
    for (const r of ctx.db.helpRequest.resident.filter(ctx.sender)) {
      if (isActive(r) && r.externalRef === a.externalRef) throw new SenderError(`already have an active request (#${r.id})`);
    }
    createRequest(ctx, a, `${ag.role}:${ag.name}`);
  }
);

/** "I'm safe" / "stop sharing my location". `externalRef` must match for
 *  requests the intake agent submitted on someone's behalf. */
export const close_my_request = spacetimedb.reducer(
  { requestId: t.u64(), externalRef: t.string(), outcome: t.string() },
  (ctx, { requestId, externalRef, outcome }) => {
    if (outcome !== 'safe' && outcome !== 'revoked') throw new SenderError('outcome must be safe|revoked');
    const r = requireRequest(ctx, requestId);
    if (!r.resident.isEqual(ctx.sender) || r.externalRef !== externalRef) throw new SenderError('not your request');
    closeRequest(ctx, r, outcome, 'resident', outcome === 'safe' ? 'resident reports safe' : 'consent revoked');
  }
);

export const extend_consent = spacetimedb.reducer(
  { requestId: t.u64(), externalRef: t.string(), minutes: t.u32() },
  (ctx, { requestId, externalRef, minutes }) => {
    const r = requireRequest(ctx, requestId);
    if (!r.resident.isEqual(ctx.sender) || r.externalRef !== externalRef) throw new SenderError('not your request');
    if (!isActive(r)) throw new SenderError('request is closed');
    const m = Math.min(MAX_CONSENT_MIN, Math.max(MIN_CONSENT_MIN, minutes));
    const next = ctx.timestamp.microsSinceUnixEpoch + BigInt(m) * 60_000_000n;
    ctx.db.helpRequest.id.update({ ...r, consentExpiresAt: new Timestamp(next), updatedAt: ctx.timestamp });
    ctx.db.consentTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(next), requestId: r.id });
  }
);

/** The resident moved, or corrected the pin: same request (and queue place), new location inside the incident
 *  area. Danger and travel are recomputed from it; a crew already on the way sees the new point on its map. */
export const update_my_location = spacetimedb.reducer(
  { requestId: t.u64(), externalRef: t.string(), lat: t.f64(), lon: t.f64() },
  (ctx, { requestId, externalRef, lat, lon }) => {
    const r = requireRequest(ctx, requestId);
    if (!r.resident.isEqual(ctx.sender) || r.externalRef !== externalRef) throw new SenderError('not your request');
    if (!isActive(r)) throw new SenderError('request is closed');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new SenderError('invalid location');
    if (!insideGrid(ctx, lat, lon)) throw new SenderError('location is outside the active incident area');
    ctx.db.helpRequest.id.update({ ...r, lat, lon, updatedAt: ctx.timestamp });
    bump(ctx, 'requests');
    log(ctx, 'resident', 'location_updated', `Request #${r.id}: resident updated their location`, r.id);
  }
);

// ─── Field reports (resident -> intake agent -> commander) ──────────────────

const REPORT_KINDS = ['text', 'voice', 'image', 'video'];

/** A signed-in human who may talk to this request's resident: a responder of the station whose queue holds it,
 *  or the incident commander. Never an agent: this is a person-to-person conversation. */
function requireResponder(ctx: Ctx, requestId: bigint) {
  const op = ctx.db.operator.identity.find(ctx.sender);
  const q = ctx.db.queueEntry.requestId.find(requestId);
  const ok = op && (op.role === 'commander' || (op.role === 'responder' && q !== null && q !== undefined && q.stationId === op.stationId));
  if (!op || !ok) throw new SenderError("requires a signed-in responder of the request's station (or the incident commander)");
  return { op, actor: `${op.role}:${op.name}` };
}
const MAX_REPORTS_PER_REQUEST = 30;

/** A resident adds context to their request: a message, a voice transcript, a photo or a video
 *  (URL + sampled frames). Called by the resident's own app (their request), or by the intake agent
 *  for an ASI:One user (`externalRef` must match). It is stored for the intake agent to analyze and the
 *  console to show; nothing here changes danger or queues. */
export const submit_report = spacetimedb.reducer(
  { requestId: t.u64(), externalRef: t.string(), kind: t.string(), text: t.string(), mediaUrl: t.string(), frameUrls: t.string() },
  (ctx, a) => {
    const r = requireRequest(ctx, a.requestId);
    if (!r.resident.isEqual(ctx.sender) || r.externalRef !== a.externalRef) throw new SenderError('not your request');
    if (!isActive(r)) throw new SenderError('request is closed');
    if (!REPORT_KINDS.includes(a.kind)) throw new SenderError(`kind must be ${REPORT_KINDS.join('|')}`);
    if (a.text.length > 4000) throw new SenderError('text too long (max 4000 chars)');
    for (const u of [a.mediaUrl, ...a.frameUrls.split('\n')].filter(Boolean)) {
      if (!u.startsWith('https://') || u.length > 1000) throw new SenderError('media must be https URLs');
    }
    if (a.frameUrls.split('\n').filter(Boolean).length > 8) throw new SenderError('at most 8 video frames');
    if (!a.text.trim() && !a.mediaUrl && !a.frameUrls) throw new SenderError('empty report');
    if ([...ctx.db.fieldReport.requestId.filter(r.id)].length >= MAX_REPORTS_PER_REQUEST) throw new SenderError('too many reports on this request');
    ctx.db.fieldReport.insert({
      id: 0n, requestId: r.id, kind: a.kind, text: a.text, mediaUrl: a.mediaUrl, frameUrls: a.frameUrls, createdAt: ctx.timestamp,
    });
    log(ctx, 'resident', 'report_new', `Request #${r.id}: new ${a.kind} report`, r.id);
  }
);

/** Record the intake agent's reading of a request's reports (upsert). The intake agent sends its reading
 *  to the commander as an agent message; the commander, which orchestrates the subagents, records it here. */
export const publish_assessment = spacetimedb.reducer(
  { a: AssessmentInput },
  (ctx, { a }) => {
    const ag = requireAgent(ctx, 'commander');
    const r = ctx.db.helpRequest.id.find(a.requestId);
    if (!r || !isActive(r)) return;
    const prev = ctx.db.reportAssessment.requestId.find(r.id);
    const row = {
      ...a,
      needs: cleanNeeds(a.needs),
      people: Math.min(a.people, 50),
      fireDistanceM: Number.isFinite(a.fireDistanceM) ? a.fireDistanceM : -1,
      confidence: Math.max(0, Math.min(1, a.confidence)),
      urgency: Math.max(0, Math.min(1, a.urgency)),
      roadNote: a.roadNote.slice(0, 300),
      summary: a.summary.slice(0, 500),
      residentReply: a.residentReply.slice(0, 500),
      analyzer: a.analyzer.slice(0, 80),
      updatedAt: ctx.timestamp,
    };
    if (prev) ctx.db.reportAssessment.requestId.update(row);
    else ctx.db.reportAssessment.insert(row);
    bump(ctx, 'requests');
    const claims = [a.trapped && 'TRAPPED', a.injured && 'injured', a.fireSeen && 'fire seen', a.roadBlocked && 'road blocked']
      .filter(Boolean).join(', ');
    log(ctx, `${ag.role}:${ag.name}`, 'assessed', `Request #${r.id} assessed (${a.analyzer})${claims ? `: ${claims}` : ''}`, r.id);
  }
);

/** A responder (or the commander) writes to the resident, e.g. to check what they reported. The resident sees it
 *  in their app (ops_message) or in ASI:One (the intake agent relays it). */
export const message_resident = spacetimedb.reducer(
  { requestId: t.u64(), text: t.string() },
  (ctx, { requestId, text }) => {
    const r = requireRequest(ctx, requestId);
    const { op, actor } = requireResponder(ctx, requestId);
    if (!isActive(r)) throw new SenderError('request is closed');
    if (!text.trim() || text.length > 1000) throw new SenderError('message must be 1..1000 chars');
    ctx.db.requestMessage.insert({ id: 0n, requestId, from: op.role, author: op.name, text: text.trim(), createdAt: ctx.timestamp });
    log(ctx, actor, 'message_sent', `Request #${requestId}: ${op.role} messaged the resident`, requestId);
  }
);

/** The resident answers. Their answer also goes in as a text report, so the intake agent re-reads the whole
 *  picture with it (it is still text: a responder's confirmation outranks it). */
export const reply_to_responder = spacetimedb.reducer(
  { requestId: t.u64(), externalRef: t.string(), text: t.string() },
  (ctx, { requestId, externalRef, text }) => {
    const r = requireRequest(ctx, requestId);
    if (!r.resident.isEqual(ctx.sender) || r.externalRef !== externalRef) throw new SenderError('not your request');
    if (!isActive(r)) throw new SenderError('request is closed');
    if (!text.trim() || text.length > 1000) throw new SenderError('message must be 1..1000 chars');
    if ([...ctx.db.requestMessage.requestId.filter(requestId)].length >= 200) throw new SenderError('too many messages on this request');
    ctx.db.requestMessage.insert({ id: 0n, requestId, from: 'resident', author: '', text: text.trim(), createdAt: ctx.timestamp });
    ctx.db.fieldReport.insert({ id: 0n, requestId, kind: 'text', text: text.trim(), mediaUrl: '', frameUrls: '', createdAt: ctx.timestamp });
    log(ctx, 'resident', 'message_reply', `Request #${requestId}: resident replied to responders`, requestId);
  }
);

// ─── Danger agent ───────────────────────────────────────────────────────────

export const publish_danger = spacetimedb.reducer(
  { assessments: t.array(DangerInput), travel: t.array(TravelInput) },
  (ctx, { assessments, travel }) => {
    const ag = requireAgent(ctx, 'commander', 'danger');
    const version = bump(ctx, 'danger');
    for (const d of assessments) {
      if (!LEVELS.includes(d.level)) throw new SenderError(`bad level ${d.level}`);
      const r = ctx.db.helpRequest.id.find(d.requestId);
      if (!r || !isActive(r)) continue;
      if (d.level !== r.level && (d.level === 'critical' || d.level === 'unreachable')) {
        log(ctx, `${ag.role}:${ag.name}`, 'level', `Request #${r.id} is now ${d.level.toUpperCase()} (slack ${(d.slackS / 60).toFixed(0)} min)`, r.id);
      }
      ctx.db.helpRequest.id.update({
        ...r, level: d.level, slackS: d.slackS, fireEtaS: d.fireEtaS, extractS: d.extractS,
        dangerVersion: version, updatedAt: ctx.timestamp,
      });
    }
    for (const tr of travel) {
      const key = tr.requestId * 1024n + BigInt(tr.stationId);
      const row = { key, ...tr, dangerVersion: version };
      if (ctx.db.travelEstimate.key.find(key)) ctx.db.travelEstimate.key.update(row);
      else ctx.db.travelEstimate.insert(row);
    }
  }
);

/** Inputs are captured before CPU work. Retry rejected snapshots; never relabel old results as current. */
function unitsStamp(ctx: Ctx | VCtx): string {
  return [...ctx.db.unit.iter()].sort((a, b) => a.id - b.id)
    .map(u => `${u.id}:${u.updatedAt.microsSinceUnixEpoch}`).join('|');
}
export const publish_risk_assessments = spacetimedb.reducer({
  snapshot: RiskSnapshotInput, risks: t.array(RequestRiskInput), travel: t.array(TravelInput),
}, (ctx, { snapshot: s, risks, travel }) => {
  requireAgent(ctx, 'commander');
  const v = ctx.db.worldVersion.id.find(0)!;
  const c = ctx.db.simClock.id.find(0)!;
  const routing = ctx.db.forecastMeta.id.find(0);
  const checks: Array<[boolean, string]> = [
    [s.scenario !== c.scenario, 'scenario'],
    [!Number.isFinite(s.assessedAtS) || s.assessedAtS > c.simS + CLOCK_EPS_S, 'clock'],
    [s.weatherVersion !== v.weather, 'weather'], [s.fireVersion !== v.fire, 'fire'],
    [s.roadsVersion !== v.roads, 'roads'], [s.requestsVersion !== v.requests, 'requests/evidence'],
    [s.forecastVersion !== v.forecast, 'physical forecast'],
    [!routing || c.simS >= routing.computedAtS + routing.horizonS, 'routing forecast expired'], [s.unitsStamp !== unitsStamp(ctx), 'units'],
    [s.riskUpdatedAt !== (ctx.db.fireRiskMeta.id.find(0)?.updatedAt.microsSinceUnixEpoch ?? 0n), 'risk forecast'],
    [s.pipelineUpdatedAt !== (ctx.db.riskPipeline.id.find(0)?.updatedAt.microsSinceUnixEpoch ?? 0n), 'risk pipeline'],
  ];
  const changed = checks.filter(([mismatch]) => mismatch).map(([, name]) => name);
  if (changed.length) throw new SenderError(`stale risk assessment snapshot; retry current inputs (${changed.join(', ')})`);
  const ids = new Set<bigint>();
  for (const r of risks) {
    if (ids.has(r.requestId) || r.schemaVersion !== 'resident-risk-v1' || !r.assessmentId
        || !LEVELS.includes(r.level) || ![r.slackS, r.fireEtaS, r.extractS, r.credibility, r.reportedUrgency, r.forecastIssueS].every(Number.isFinite)
        || r.extractS < 0 || r.credibility < 0 || r.credibility > 1 || r.headcount < 1 || r.headcount > 50
        || r.horizonsS.length !== r.probabilities.length || r.horizonsS.length > 8
        || r.horizonsS.some((h, i) => !Number.isFinite(h) || h <= 0 || (i > 0 && h <= r.horizonsS[i - 1]))
        || r.probabilities.some(p => !Number.isFinite(p) || p < 0 || p > 1)
        || r.probabilities.some((p, i) => i > 0 && p < r.probabilities[i - 1])
        || [r.travelS, r.waitS, r.scheduledSlackS, r.arrivalLowerS, r.arrivalUpperS,
            r.exposureSlackLowerS, r.exposureSlackUpperS].some(x => x !== undefined && !Number.isFinite(x)))
      throw new SenderError('invalid resident risk assessment');
    const request = requireRequest(ctx, r.requestId);
    if (!isActive(request) || request.locationPurged) throw new SenderError('request closed during assessment');
    ids.add(r.requestId);
  }
  const travelKeys = new Set<string>();
  for (const tr of travel) {
    const key = `${tr.requestId}:${tr.stationId}`;
    if (!ids.has(tr.requestId) || !ctx.db.station.id.find(tr.stationId)
        || !Number.isFinite(tr.travelS) || tr.travelS < 0 || travelKeys.has(key))
      throw new SenderError('invalid risk travel');
    travelKeys.add(key);
  }
  if (travelKeys.size !== ids.size * [...ctx.db.station.iter()].length)
    throw new SenderError('incomplete risk travel matrix');
  const version = bump(ctx, 'danger');
  for (const risk of risks) {
    const request = requireRequest(ctx, risk.requestId);
    const row = { ...risk, ...s, dangerVersion: version, updatedAt: ctx.timestamp };
    if (ctx.db.requestRisk.requestId.find(risk.requestId)) ctx.db.requestRisk.requestId.update(row);
    else ctx.db.requestRisk.insert(row);
    ctx.db.helpRequest.id.update({ ...request, level: risk.level, slackS: risk.slackS,
      fireEtaS: risk.fireEtaS, extractS: risk.extractS, dangerVersion: version, updatedAt: ctx.timestamp });
    if (request.level !== risk.level && ['critical', 'unreachable'].includes(risk.level))
      log(ctx, 'commander', 'risk_level', `Risk ${risk.assessmentId}: ${risk.level}`, request.id);
  }
  for (const tr of travel) {
    const key = tr.requestId * 1024n + BigInt(tr.stationId);
    const row = { key, ...tr, dangerVersion: version };
    if (ctx.db.travelEstimate.key.find(key)) ctx.db.travelEstimate.key.update(row);
    else ctx.db.travelEstimate.insert(row);
  }
});

// ─── Delegation agent ───────────────────────────────────────────────────────

/** Atomically installs a new set of per-station queues. The policy (learned
 *  or heuristic) proposes; this reducer enforces the invariants. */
export const publish_plan = spacetimedb.reducer(
  { policy: t.string(), entries: t.array(PlanEntryInput), unreachable: t.array(UnreachableInput) },
  (ctx, { policy, entries, unreachable }) => {
    const ag = requireAgent(ctx, 'commander', 'delegation');
    const actor = `${ag.role}:${ag.name}`;
    const planVersion = bump(ctx, 'plan');
    const planned = new Set<bigint>();

    for (const e of entries) {
      const r = ctx.db.helpRequest.id.find(e.requestId);
      if (!r || !isActive(r) || isLocked(r)) continue;
      if (r.pinnedStationId !== 0 && r.pinnedStationId !== e.stationId) continue; // commander pin wins
      const st = ctx.db.station.id.find(e.stationId);
      if (!st) throw new SenderError(`station ${e.stationId} not found`);
      planned.add(r.id);

      let unitId = e.unitId;
      if (unitId !== 0) {
        const u = ctx.db.unit.id.find(unitId);
        if (!u || u.stationId !== e.stationId || u.status !== 'available') unitId = 0;
      }

      const prev = ctx.db.queueEntry.requestId.find(r.id);
      let hops = r.hopCount;
      if (prev && prev.stationId !== e.stationId) {
        hops++;
        const from = ctx.db.station.id.find(prev.stationId)?.name ?? `#${prev.stationId}`;
        log(ctx, actor, 'reassign', `Request #${r.id} moved ${from} → ${st.name}: ${e.reason}`, r.id);
      }
      const row = {
        requestId: r.id, stationId: e.stationId, rank: e.rank, unitId, etaS: e.etaS,
        reason: e.reason, residentReason: e.residentReason, policy, planVersion, updatedAt: ctx.timestamp,
      };
      if (prev) ctx.db.queueEntry.requestId.update(row);
      else ctx.db.queueEntry.insert(row);

      if (unitId !== 0) {
        const u = ctx.db.unit.id.find(unitId)!;
        ctx.db.unit.id.update({ ...u, status: 'assigned', currentRequest: r.id, updatedAt: ctx.timestamp });
        ctx.db.helpRequest.id.update({ ...r, status: 'assigned', hopCount: hops, updatedAt: ctx.timestamp });
        log(ctx, actor, 'dispatch', `${u.callsign} (${st.name}) assigned to request #${r.id}: ${e.reason}`, r.id);
      } else if (r.status !== 'queued' || hops !== r.hopCount) {
        ctx.db.helpRequest.id.update({ ...r, status: 'queued', hopCount: hops, updatedAt: ctx.timestamp });
      }
    }

    // Requests that dropped out of the plan leave their queue (unless a unit is committed).
    for (const q of [...ctx.db.queueEntry.iter()]) {
      if (planned.has(q.requestId)) continue;
      const r = ctx.db.helpRequest.id.find(q.requestId);
      if (r && isLocked(r)) continue;
      ctx.db.queueEntry.requestId.delete(q.requestId);
      if (r && r.status === 'queued') ctx.db.helpRequest.id.update({ ...r, status: 'pending', updatedAt: ctx.timestamp });
    }

    for (const u of unreachable) {
      const r = ctx.db.helpRequest.id.find(u.requestId);
      if (!r || !isActive(r)) continue;
      const open = [...ctx.db.flag.requestId.filter(r.id)].some(f => f.kind === 'unreachable' && !f.resolved);
      if (open) continue;
      ctx.db.flag.insert({
        id: 0n, requestId: r.id, kind: 'unreachable', detail: u.detail, recommendation: u.recommendation,
        raisedBy: actor, resolved: false, resolution: '', createdAt: ctx.timestamp,
      });
      log(ctx, actor, 'escalation', `Request #${r.id} unreachable by ground: ${u.recommendation}`, r.id);
    }
  }
);

// ─── Stations / responders: mission lifecycle ───────────────────────────────

export const unit_en_route = spacetimedb.reducer(
  { unitId: t.u32(), arriveAtS: t.f64(), freeAtS: t.f64() },
  (ctx, { unitId, arriveAtS, freeAtS }) => {
    const u = requireUnit(ctx, unitId);
    const actor = requireStationActor(ctx, u.stationId);
    if (u.status !== 'assigned' || u.currentRequest === 0n) throw new SenderError(`${u.callsign} has no pending assignment`);
    const r = requireRequest(ctx, u.currentRequest);
    const route = ctx.db.unitRoute.unitId.find(unitId);
    if (!route || route.requestId !== r.id || route.status !== 'ready' || Math.abs(route.targetLat - r.lat) > 1e-8 || Math.abs(route.targetLon - r.lon) > 1e-8) throw new SenderError('no safe road route is ready');
    const versions = ctx.db.worldVersion.id.find(0)!;
    if (route.fireVersion !== versions.fire || route.roadsVersion !== versions.roads) throw new SenderError('road conditions changed; waiting for a new route');
    arriveAtS = simNow(ctx) + route.durationS;
    ctx.db.unitRoute.unitId.update({ ...route, departS: simNow(ctx), arriveS: arriveAtS, updatedAt: ctx.timestamp });
    ctx.db.unit.id.update({ ...u, status: 'en_route', lat: route.points[0].lat, lon: route.points[0].lon,
      freeAtS: Math.max(freeAtS, arriveAtS + r.extractS + route.durationS), legDepartS: simNow(ctx), updatedAt: ctx.timestamp });
    ctx.db.helpRequest.id.update({ ...r, status: 'en_route', updatedAt: ctx.timestamp });
    const q = ctx.db.queueEntry.requestId.find(r.id);
    if (q) ctx.db.queueEntry.requestId.update({ ...q, unitId, etaS: arriveAtS, updatedAt: ctx.timestamp });
    log(ctx, actor, 'en_route', `${u.callsign} en route to request #${r.id}, ETA T+${(arriveAtS / 60).toFixed(0)} min`, r.id);
  }
);

export const decline_mission = spacetimedb.reducer(
  { unitId: t.u32(), reason: t.string() },
  (ctx, { unitId, reason }) => {
    const u = requireUnit(ctx, unitId);
    const actor = requireStationActor(ctx, u.stationId);
    if (u.currentRequest === 0n) throw new SenderError('no mission to decline');
    const r = ctx.db.helpRequest.id.find(u.currentRequest);
    const position = roadPosition(ctx, u);
    ctx.db.unitRoute.unitId.delete(unitId);
    ctx.db.unit.id.update({ ...returningUnit(ctx, u), ...position });
    if (r && isActive(r)) {
      ctx.db.helpRequest.id.update({ ...r, status: 'queued', updatedAt: ctx.timestamp });
      const q = ctx.db.queueEntry.requestId.find(r.id);
      if (q) ctx.db.queueEntry.requestId.update({ ...q, unitId: 0, updatedAt: ctx.timestamp });
    }
    log(ctx, actor, 'declined', `${u.callsign} declined request #${u.currentRequest}: ${reason}`, u.currentRequest);
  }
);

/** Live unit position for the map (station agent streams this). */
export const unit_position = spacetimedb.reducer(
  { unitId: t.u32(), lat: t.f64(), lon: t.f64() },
  (ctx, { unitId, lat, lon }) => {
    const u = requireUnit(ctx, unitId);
    requireStationActor(ctx, u.stationId);
    ctx.db.unit.id.update({ ...u, lat, lon, updatedAt: ctx.timestamp });
  }
);

export const unit_on_scene = spacetimedb.reducer({ unitId: t.u32() }, (ctx, { unitId }) => {
  const u = requireUnit(ctx, unitId);
  const actor = requireStationActor(ctx, u.stationId);
  const r = requireRequest(ctx, u.currentRequest);
  const q = ctx.db.queueEntry.requestId.find(r.id);
  if (q) ctx.db.queueEntry.requestId.update({ ...q, etaS: simNow(ctx), updatedAt: ctx.timestamp });
  const points = ctx.db.unitRoute.unitId.find(unitId)?.points;
  const endpoint = points?.[points.length - 1];
  ctx.db.unit.id.update({ ...u, status: 'on_scene', lat: endpoint?.lat ?? u.lat, lon: endpoint?.lon ?? u.lon, updatedAt: ctx.timestamp });
  ctx.db.helpRequest.id.update({ ...r, status: 'on_scene', updatedAt: ctx.timestamp });
  const slack = r.fireEtaS !== undefined ? (r.fireEtaS - simNow(ctx)) / 60 : undefined;
  log(ctx, actor, 'on_scene', `${u.callsign} on scene at request #${r.id}${slack !== undefined ? ` (${slack.toFixed(0)} min before fire)` : ''}`, r.id);
});

export const complete_mission = spacetimedb.reducer(
  { unitId: t.u32(), outcome: t.string() },
  (ctx, { unitId, outcome }) => {
    if (!['rescued', 'not_found', 'aborted'].includes(outcome)) throw new SenderError('outcome must be rescued|not_found|aborted');
    const u = requireUnit(ctx, unitId);
    const actor = requireStationActor(ctx, u.stationId);
    const r = requireRequest(ctx, u.currentRequest);
    const position = roadPosition(ctx, u);
    ctx.db.unitRoute.unitId.delete(unitId);
    ctx.db.unit.id.update(returningUnit(ctx, { ...u, ...position }));
    if (outcome === 'aborted') {
      ctx.db.helpRequest.id.update({ ...r, status: 'queued', updatedAt: ctx.timestamp });
      const q = ctx.db.queueEntry.requestId.find(r.id);
      if (q) ctx.db.queueEntry.requestId.update({ ...q, unitId: 0, updatedAt: ctx.timestamp });
      log(ctx, actor, 'aborted', `${u.callsign} aborted request #${r.id}; back in queue`, r.id);
    } else {
      closeRequest(ctx, r, outcome, actor, `${needsSummary(r)} by ${u.callsign}`);
    }
  }
);

/** Finish a rescue and claim an unserved next caller atomically; a returning truck can also be redirected. */
export const continue_unit_mission = spacetimedb.reducer({
  unitId: t.u32(), requestId: t.u64(), assessmentId: t.string(), travelS: t.f64(),
}, (ctx, a) => {
  const u = requireUnit(ctx, a.unitId);
  const actor = requireStationActor(ctx, u.stationId);
  const now = simNow(ctx);
  if (!['on_scene', 'returning', 'available'].includes(u.status)) throw new SenderError('unit is already committed to another approach');
  const next = requireRequest(ctx, a.requestId);
  if (!isActive(next) || isLocked(next) || next.locationPurged
      || [...ctx.db.unit.iter()].some(other => other.currentRequest === next.id)) throw new SenderError('caller is already attended or closed');
  if (next.headcount > u.capacity || (next.pinnedStationId && next.pinnedStationId !== u.stationId)) throw new SenderError('unit capacity or commander station pin prevents continuation');
  const risk = ctx.db.requestRisk.requestId.find(next.id);
  if (!risk || risk.assessmentId !== a.assessmentId || !riskCard(ctx, risk).current || !risk.reachable)
    throw new SenderError('fresh reachable risk assessment required');
  if (!Number.isFinite(a.travelS) || a.travelS <= 0 || a.travelS >= 86400
      || now + a.travelS + next.extractS + 300 > next.fireEtaS!) throw new SenderError('insufficient modeled rescue window');
  const position = roadPosition(ctx, u);
  if (u.status === 'on_scene') {
    const current = requireRequest(ctx, u.currentRequest);
    const currentQueue = ctx.db.queueEntry.requestId.find(current.id);
    if (!currentQueue || now < currentQueue.etaS + current.extractS) throw new SenderError('extraction is still in progress');
    closeRequest(ctx, current, 'rescued', actor, `${u.callsign} completed extraction before its next mission`);
  } else if (u.currentRequest !== 0n) throw new SenderError('unit still has another caller');
  ctx.db.unitRoute.unitId.delete(u.id);
  ctx.db.unit.id.update({ ...u, ...position, status: 'assigned', currentRequest: next.id,
    freeAtS: now + a.travelS * 2 + next.extractS, legDepartS: 0, updatedAt: ctx.timestamp });
  ctx.db.helpRequest.id.update({ ...next, status: 'assigned', updatedAt: ctx.timestamp });
  const previous = ctx.db.queueEntry.requestId.find(next.id);
  const planVersion = bump(ctx, 'plan');
  const entry = { requestId: next.id, stationId: u.stationId, unitId: u.id, rank: previous?.rank || 1,
    etaS: now + a.travelS, reason: `LOOKAHEAD continuation: ${u.callsign} is nearby; slack ${risk.slackS.toFixed(0)} s`,
    residentReason: `${u.callsign} is preparing to respond from its current location.`,
    policy: 'lookahead', planVersion, updatedAt: ctx.timestamp };
  if (previous) ctx.db.queueEntry.requestId.update(entry); else ctx.db.queueEntry.insert(entry);
  log(ctx, actor, 'mission_continued', `${u.callsign} continues to request #${next.id}`, next.id);
});

export const unit_available = spacetimedb.reducer(
  { unitId: t.u32(), lat: t.f64(), lon: t.f64() },
  (ctx, { unitId, lat, lon }) => {
    const u = requireUnit(ctx, unitId);
    requireStationActor(ctx, u.stationId);
    if (u.currentRequest !== 0n) throw new SenderError(`${u.callsign} is still on request #${u.currentRequest}`);
    ctx.db.unitRoute.unitId.delete(unitId);
    ctx.db.unit.id.update({ ...u, status: 'available', lat, lon, freeAtS: simNow(ctx), legDepartS: 0, updatedAt: ctx.timestamp });
  }
);

/** A responder phone is open for this unit: sent every ~20 s while it is open, and active=false when it closes.
 *  Same station scope as the lifecycle calls; it never writes the unit row. */
export const crew_heartbeat = spacetimedb.reducer(
  { unitId: t.u32(), active: t.bool() },
  (ctx, { unitId, active }) => {
    const u = requireUnit(ctx, unitId);
    requireStationActor(ctx, u.stationId);
    if (!active) {
      ctx.db.crewPresence.unitId.delete(unitId);
      return;
    }
    const row = { unitId, seenAt: ctx.timestamp };
    if (ctx.db.crewPresence.unitId.find(unitId)) ctx.db.crewPresence.unitId.update(row);
    else ctx.db.crewPresence.insert(row);
  }
);

// ─── Commander (dashboard or ASI:One commander agent) ───────────────────────

/** The route worker runs outside the reducer. This transaction rejects stale fire/road inputs. */
export const publish_unit_route = spacetimedb.reducer(
  { unitId: t.u32(), requestId: t.u64(), targetLat: t.f64(), targetLon: t.f64(), points: t.array(RoadPoint), durationS: t.f64(),
    status: t.string(), reason: t.string(), signature: t.string(), fireVersion: t.u64(), roadsVersion: t.u64() },
  (ctx, a) => {
    const u = requireUnit(ctx, a.unitId);
    requireStationActor(ctx, u.stationId);
    const versions = ctx.db.worldVersion.id.find(0)!;
    if (a.fireVersion !== versions.fire || a.roadsVersion !== versions.roads) throw new SenderError('stale road route inputs');
    if (u.currentRequest !== a.requestId) throw new SenderError('unit assignment changed');
    const target = a.requestId ? requireRequest(ctx, a.requestId) : ctx.db.station.id.find(u.stationId)!;
    if (Math.abs(target.lat - a.targetLat) > 1e-8 || Math.abs(target.lon - a.targetLon) > 1e-8) throw new SenderError('destination changed');
    if (!['ready', 'blocked'].includes(a.status) || !Number.isFinite(a.durationS) || a.durationS < 0 || a.points.length > 5000
      || (a.status === 'ready' && a.points.length < 2) || a.points.some(p => !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180)) throw new SenderError('invalid road route');
    const prev = ctx.db.unitRoute.unitId.find(u.id);
    if (prev?.signature === a.signature && prev.fireVersion === a.fireVersion && prev.roadsVersion === a.roadsVersion) return;
    const now = simNow(ctx);
    const row = { unitId: u.id, requestId: a.requestId, targetLat: a.targetLat, targetLon: a.targetLon, points: a.points,
      durationS: a.durationS, departS: now, arriveS: now + a.durationS, status: a.status, reason: a.reason.slice(0, 500),
      signature: a.signature, updatedAt: ctx.timestamp, fireVersion: a.fireVersion, roadsVersion: a.roadsVersion };
    const heldPosition = roadPosition(ctx, u);
    if (prev) ctx.db.unitRoute.unitId.update(row); else ctx.db.unitRoute.insert(row);
    if (a.status === 'blocked' && prev?.points.length) ctx.db.unit.id.update({ ...u, ...heldPosition, updatedAt: ctx.timestamp });
    if (a.status === 'ready') {
      const first = a.points[0];
      ctx.db.unit.id.update({ ...u, lat: first.lat, lon: first.lon,
        freeAtS: now + a.durationS + ('extractS' in target ? target.extractS + a.durationS : 0), updatedAt: ctx.timestamp });
      const q = ctx.db.queueEntry.requestId.find(a.requestId);
      if (q) ctx.db.queueEntry.requestId.update({ ...q, etaS: row.arriveS, updatedAt: ctx.timestamp });
    }
    log(ctx, 'route-worker', a.status === 'ready' ? 'route_ready' : 'route_blocked', `${u.callsign}: ${a.reason}`, a.requestId);
  }
);

/** Human dispatch commits a unit and its station queue row in the same transaction. */
export const assign_request_to_unit = spacetimedb.reducer(
  { requestId: t.u64(), unitId: t.u32() },
  (ctx, { requestId, unitId }) => {
    const actor = requireCommander(ctx);
    const r = requireRequest(ctx, requestId);
    const u = requireUnit(ctx, unitId);
    if (!isActive(r)) throw new SenderError('request is closed');
    if (u.currentRequest === r.id) return;
    if (isLocked(r)) throw new SenderError('request already has a committed unit');
    if (u.status !== 'available' || u.currentRequest !== 0n) throw new SenderError('unit is not available');
    if (u.capacity < r.headcount) throw new SenderError('unit capacity is smaller than the party');
    const travel = [...ctx.db.travelEstimate.requestId.filter(r.id)].find(t => t.stationId === u.stationId && t.reachable);
    const dy = (r.lat - u.lat) * 111_320;
    const dx = (r.lon - u.lon) * 111_320 * Math.cos(r.lat * Math.PI / 180);
    const drive = travel?.travelS ?? Math.hypot(dx, dy) * 1.35 / 12;
    const prev = ctx.db.queueEntry.requestId.find(r.id);
    const version = bump(ctx, 'plan');
    const row = { requestId: r.id, stationId: u.stationId, rank: prev?.rank ?? 1, unitId: u.id,
      etaS: simNow(ctx) + drive, reason: `Assigned by ${actor} to ${u.callsign}`,
      residentReason: `Incident command assigned ${u.callsign} to your request`, policy: 'manual',
      planVersion: version, updatedAt: ctx.timestamp };
    if (prev) ctx.db.queueEntry.requestId.update(row); else ctx.db.queueEntry.insert(row);
    ctx.db.unit.id.update({ ...u, status: 'assigned', currentRequest: r.id,
      freeAtS: simNow(ctx) + drive * 2 + r.extractS, updatedAt: ctx.timestamp });
    ctx.db.helpRequest.id.update({ ...r, status: 'assigned', pinnedStationId: u.stationId, updatedAt: ctx.timestamp });
    bump(ctx, 'requests');
    log(ctx, actor, 'dispatch', `${u.callsign} assigned to request #${r.id}`, r.id);
  }
);

/** Pin a request to a station (stationId = 0 unpins). The policy must obey. */
export const override_assignment = spacetimedb.reducer(
  { requestId: t.u64(), stationId: t.u32(), note: t.string() },
  (ctx, { requestId, stationId, note }) => {
    const actor = requireCommander(ctx);
    const r = requireRequest(ctx, requestId);
    if (!isActive(r)) throw new SenderError('request is closed');
    if (stationId !== 0 && !ctx.db.station.id.find(stationId)) throw new SenderError(`station ${stationId} not found`);
    ctx.db.helpRequest.id.update({ ...r, pinnedStationId: stationId, updatedAt: ctx.timestamp });
    const q = ctx.db.queueEntry.requestId.find(r.id);
    if (stationId !== 0 && q && q.stationId !== stationId && !isLocked(r)) {
      ctx.db.queueEntry.requestId.update({
        ...q, stationId, unitId: 0, reason: `Commander override: ${note}`, residentReason: 'Assigned by incident command', updatedAt: ctx.timestamp,
      });
    }
    bump(ctx, 'requests');
    const where = stationId === 0 ? 'unpinned' : `pinned to ${ctx.db.station.id.find(stationId)!.name}`;
    log(ctx, actor, 'override', `Request #${r.id} ${where}${note ? `: ${note}` : ''}`, r.id);
  }
);

export const flag_request = spacetimedb.reducer(
  { requestId: t.u64(), kind: t.string(), detail: t.string() },
  (ctx, { requestId, kind, detail }) => {
    const actor = requireCommander(ctx);
    if (!['suspect', 'escalation', 'unreachable'].includes(kind)) throw new SenderError('bad flag kind');
    requireRequest(ctx, requestId);
    ctx.db.flag.insert({
      id: 0n, requestId, kind, detail, recommendation: '', raisedBy: actor, resolved: false, resolution: '', createdAt: ctx.timestamp,
    });
    log(ctx, actor, 'flag', `Request #${requestId} flagged ${kind}`, requestId);
  }
);

export const resolve_flag = spacetimedb.reducer(
  { flagId: t.u64(), resolution: t.string() },
  (ctx, { flagId, resolution }) => {
    const actor = requireCommander(ctx);
    const f = ctx.db.flag.id.find(flagId);
    if (!f) throw new SenderError(`flag ${flagId} not found`);
    ctx.db.flag.id.update({ ...f, resolved: true, resolution });
    log(ctx, actor, 'flag_resolved', `Flag on request #${f.requestId} resolved: ${resolution}`, f.requestId);
  }
);

/** Simulated residents pinging for help (demos and drills), as one transaction. Each is an ordinary request on the
 *  'synthetic' channel with its own externalRef, owned by the caller, plus an optional first text report for the
 *  intake agent to read. Same validation as a real ping. */
export const submit_mock_requests = spacetimedb.reducer(
  { pings: t.array(MockRequestInput) },
  (ctx, { pings }) => {
    const actor = requireCommander(ctx);
    if (pings.length < 1 || pings.length > MAX_MOCK_PINGS) throw new SenderError(`send 1..${MAX_MOCK_PINGS} mock pings at a time`);
    const batch = ctx.timestamp.microsSinceUnixEpoch;
    pings.forEach(({ report, ...p }, i) => {
      if (report.length > 4000) throw new SenderError('text too long (max 4000 chars)');
      const r = createRequest(ctx, { ...p, channel: 'synthetic', externalRef: `mock:${batch}:${i}`, consentMinutes: MOCK_CONSENT_MIN }, actor);
      if (report.trim()) {
        ctx.db.fieldReport.insert({
          id: 0n, requestId: r.id, kind: 'text', text: report.trim(), mediaUrl: '', frameUrls: '', createdAt: ctx.timestamp,
        });
      }
    });
    log(ctx, actor, 'mock_pings', `${pings.length} simulated help ping(s) added`);
  }
);

// ─── Views (row-level privacy) ──────────────────────────────────────────────

type Scope = { kind: 'all' } | { kind: 'station'; stationId: number } | { kind: 'owner' } | { kind: 'none' };

/** Least privilege: data feeds see no people; a station sees only its own
 *  queue; command (the commander agent, which runs danger + planning) sees all.
 *  The intake agent also sees all requests: it reads every resident's reports
 *  to analyze them, whichever channel (app or ASI:One) they came in on. */
function scopeFor(ctx: VCtx): Scope {
  const a = ctx.db.agent.identity.find(ctx.sender);
  if (a) {
    if (a.role === 'station') return { kind: 'station', stationId: a.stationId };
    if (['danger', 'delegation', 'commander', 'scenario', 'intake'].includes(a.role)) return { kind: 'all' };
    return { kind: 'none' };
  }
  const op = ctx.db.operator.identity.find(ctx.sender);
  if (op?.role === 'commander') return { kind: 'all' };
  if (op?.role === 'responder') return { kind: 'station', stationId: op.stationId };
  return { kind: 'none' };
}

function visibleRequests(ctx: VCtx) {
  const s = scopeFor(ctx);
  switch (s.kind) {
    case 'all':
      return [...ctx.db.helpRequest.iter()];
    case 'owner':
      return [...ctx.db.helpRequest.resident.filter(ctx.sender)];
    case 'station': {
      const out = [];
      for (const q of ctx.db.queueEntry.stationId.filter(s.stationId)) {
        const r = ctx.db.helpRequest.id.find(q.requestId);
        if (r) out.push(r);
      }
      return out;
    }
    case 'none':
      return [];
  }
}

export const ops_request = spacetimedb.view(
  { name: 'ops_request', public: true },
  t.array(helpRequest.rowType),
  ctx => visibleRequests(ctx)
);

export const ops_unit_route = spacetimedb.view({ name: 'ops_unit_route', public: true }, t.array(unitRoute.rowType), ctx => {
  const scope = scopeFor(ctx);
  if (scope.kind === 'all') return [...ctx.db.unitRoute.iter()];
  if (scope.kind === 'station') return [...ctx.db.unitRoute.iter()].filter(r => ctx.db.unit.id.find(r.unitId)?.stationId === scope.stationId);
  return [];
});

/** Compact learned concern overlay for field devices; probabilities retain their original horizons. */
export const fire_concern = spacetimedb.anonymousView(
  { name: 'fire_concern', public: true },
  t.array(fireRiskCell.rowType),
  ctx => [...ctx.db.fireRiskCell.iter()].filter(c => !c.observed && c.probability >= 0.1)
);

export const ops_queue = spacetimedb.view(
  { name: 'ops_queue', public: true },
  t.array(queueEntry.rowType),
  ctx => {
    const s = scopeFor(ctx);
    if (s.kind === 'all') return [...ctx.db.queueEntry.iter()];
    if (s.kind === 'station') return [...ctx.db.queueEntry.stationId.filter(s.stationId)];
    if (s.kind === 'owner') {
      const out = [];
      for (const r of ctx.db.helpRequest.resident.filter(ctx.sender)) {
        const q = ctx.db.queueEntry.requestId.find(r.id);
        if (q) out.push(q);
      }
      return out;
    }
    return [];
  }
);

export const ops_travel = spacetimedb.view(
  { name: 'ops_travel', public: true },
  t.array(travelEstimate.rowType),
  ctx => (scopeFor(ctx).kind === 'all' ? [...ctx.db.travelEstimate.iter()] : [])
);

export const ops_flag = spacetimedb.view(
  { name: 'ops_flag', public: true },
  t.array(flag.rowType),
  ctx => (scopeFor(ctx).kind === 'all' ? [...ctx.db.flag.iter()] : [])
);

/** Reports / assessments for the requests a viewer may see (command and intake: all; a station:
 *  the requests in its queue; a resident: their own). Feeds the firefighter console. */
function visibleRequestIds(ctx: VCtx): Set<bigint> | 'all' {
  const s = scopeFor(ctx);
  if (s.kind === 'all') return 'all';
  if (s.kind === 'station') return new Set([...ctx.db.queueEntry.stationId.filter(s.stationId)].map(q => q.requestId));
  return new Set([...ctx.db.helpRequest.resident.filter(ctx.sender)].map(r => r.id));
}

const RiskAssessmentCard = t.object('RiskAssessmentCard', {
  assessment: requestRisk.rowType, current: t.bool(), staleReason: t.string(),
});
function riskCard(ctx: Ctx | VCtx, r: NonNullable<ReturnType<VCtx['db']['requestRisk']['requestId']['find']>>) {
  const v = ctx.db.worldVersion.id.find(0)!;
  const c = ctx.db.simClock.id.find(0)!;
  const routing = ctx.db.forecastMeta.id.find(0);
  const routingExpired = !routing || c.simS >= routing.computedAtS + routing.horizonS;
  const request = ctx.db.helpRequest.id.find(r.requestId);
  const grid = ctx.db.grid.id.find(0)!;
  const row = request ? Math.floor((request.lat - grid.originLat) * 111_320 / grid.cellSizeM) : -1;
  const col = request ? Math.floor((request.lon - grid.originLon) * 111_320 * Math.cos(grid.originLat * Math.PI / 180) / grid.cellSizeM) : -1;
  const observed = row >= 0 && row < grid.rows && col >= 0 && col < grid.cols && !!ctx.db.fireCell.cellId.find(row * grid.cols + col);
  const timingUnconfirmed = !observed && r.fireEtaS <= c.simS;
  const current = !routingExpired && !timingUnconfirmed && r.scenario === c.scenario && r.weatherVersion === v.weather && r.fireVersion === v.fire
    && r.roadsVersion === v.roads && r.requestsVersion === v.requests && r.forecastVersion === v.forecast
    && r.unitsStamp === unitsStamp(ctx)
    && r.riskUpdatedAt === (ctx.db.fireRiskMeta.id.find(0)?.updatedAt.microsSinceUnixEpoch ?? 0n)
    && r.pipelineUpdatedAt === (ctx.db.riskPipeline.id.find(0)?.updatedAt.microsSinceUnixEpoch ?? 0n)
    && (r.horizonsS.length === 0 || ctx.db.fireRiskMeta.id.find(0)!.issueS + r.horizonsS[r.horizonsS.length - 1] > c.simS);
  return { assessment: r, current, staleReason: current ? '' : routingExpired
    ? 'Routing forecast expired; a new observation or routing forecast is required.'
    : timingUnconfirmed ? 'Previous fire-arrival estimate elapsed at an unobserved location; refreshed timing is required.'
    : 'Inputs changed or forecast expired; reassessment pending' };
}
/** Same role boundary as raw reports. Residents receive only their own request. */
export const ops_risk = spacetimedb.view({ name: 'ops_risk', public: true }, t.array(RiskAssessmentCard), ctx => {
  const ids = visibleRequestIds(ctx);
  const rows = ids === 'all' ? [...ctx.db.requestRisk.iter()]
    : [...ids].flatMap(id => { const r = ctx.db.requestRisk.requestId.find(id); return r ? [r] : []; });
  return rows.map(r => riskCard(ctx, r));
});
export const my_risk = spacetimedb.view({ name: 'my_risk', public: true }, t.array(RiskAssessmentCard), ctx =>
  [...ctx.db.helpRequest.resident.filter(ctx.sender)].filter(r => r.externalRef === '').flatMap(r => {
    const risk = ctx.db.requestRisk.requestId.find(r.id);
    return risk ? [riskCard(ctx, risk)] : [];
  })
);

export const ops_report = spacetimedb.view(
  { name: 'ops_report', public: true },
  t.array(fieldReport.rowType),
  ctx => {
    const ids = visibleRequestIds(ctx);
    if (ids === 'all') return [...ctx.db.fieldReport.iter()];
    return [...ids].flatMap(id => [...ctx.db.fieldReport.requestId.filter(id)]);
  }
);

export const ops_assessment = spacetimedb.view(
  { name: 'ops_assessment', public: true },
  t.array(reportAssessment.rowType),
  ctx => {
    const ids = visibleRequestIds(ctx);
    if (ids === 'all') return [...ctx.db.reportAssessment.iter()];
    return [...ids].map(id => ctx.db.reportAssessment.requestId.find(id)).filter(a => a !== null && a !== undefined);
  }
);

/** The responder <-> resident conversation: command and intake see all; a station its queue's; a resident their own. */
export const ops_message = spacetimedb.view(
  { name: 'ops_message', public: true },
  t.array(requestMessage.rowType),
  ctx => {
    const ids = visibleRequestIds(ctx);
    if (ids === 'all') return [...ctx.db.requestMessage.iter()];
    return [...ids].flatMap(id => [...ctx.db.requestMessage.requestId.filter(id)]);
  }
);

/** Who the caller is signed in as (commander or responder, and which station), if anyone. The operator table is
 *  private; this lets a console restore its sign-in, and notice when a scenario reload has signed responders out. */
export const my_operator = spacetimedb.view(
  { name: 'my_operator', public: true },
  t.option(operator.rowType),
  ctx => ctx.db.operator.identity.find(ctx.sender) ?? undefined
);

/** What a resident's phone shows: only their own request(s), with a coarse
 *  reason, never the scoring formula or anyone else's data. */
const ResidentCard = t.row('ResidentCardRow', {
  requestId: t.u64().primaryKey(),
  status: t.string(),
  level: t.string(),
  queuePosition: t.u32(),
  stationName: t.string(),
  unitCallsign: t.string(),
  unitId: t.u32(),
  etaS: t.option(t.f64()),
  reason: t.string(),
  headcount: t.u32(),
  needs: t.string(),
  consentExpiresAt: t.timestamp(),
  createdAt: t.timestamp(),
  intakeReply: t.string(), // the intake agent's answer to what the resident sent ('' = nothing sent / not read yet)
  lat: t.f64(),
  lon: t.f64(),
  note: t.string(),
  entrance: t.string(),
  updatedAt: t.timestamp(),
});

export const my_requests = spacetimedb.view(
  { name: 'my_requests', public: true },
  t.array(ResidentCard),
  ctx => {
    const out = [];
    for (const r of ctx.db.helpRequest.resident.filter(ctx.sender)) {
      if (r.externalRef !== '') continue; // agent-submitted rows belong to someone else
      const q = ctx.db.queueEntry.requestId.find(r.id);
      const st = q ? ctx.db.station.id.find(q.stationId) : undefined;
      const u = q && q.unitId !== 0 ? ctx.db.unit.id.find(q.unitId) : undefined;
      let position = 0;
      if (q) {
        position = 1;
        for (const other of ctx.db.queueEntry.stationId.filter(q.stationId)) {
          if (other.unitId === 0 && q.unitId === 0 && other.rank < q.rank) position++;
        }
      }
      out.push({
        requestId: r.id,
        status: r.status,
        level: r.level,
        queuePosition: q && q.unitId === 0 ? position : 0,
        stationName: st?.name ?? '',
        unitCallsign: u?.callsign ?? '',
        unitId: u?.id ?? 0,
        etaS: q ? q.etaS : undefined,
        reason: q?.residentReason ?? (isActive(r) ? 'Received. Assessing your location against the fire forecast.' : ''),
        headcount: r.headcount,
        needs: r.needs,
        consentExpiresAt: r.consentExpiresAt,
        createdAt: r.createdAt,
        intakeReply: ctx.db.reportAssessment.requestId.find(r.id)?.residentReply ?? '',
        lat: r.lat, lon: r.lon, note: r.note, entrance: r.entrance, updatedAt: r.updatedAt,
      });
    }
    return out;
  }
);
