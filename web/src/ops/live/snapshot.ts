// The ops snapshots, built from the live row store. Each piece is memoized on the store arrays it reads (one frozen
// array per source version), so an unchanged table keeps its array identity across the 1 Hz clock rebuilds. Pieces
// that also depend on the time (unit positions, queue waits, agent freshness) are recomputed on every rebuild and
// reuse the previous objects when nothing in them changed.
//
// What the backend lacks is filled in here: SIM-ONLY queue fields (wait, travel, position), escalation rows for
// unreachable requests (the plan drops their queue row), and unit motion along each leg (units are written only
// at lifecycle steps, so the marker is interpolated rather than streamed).

import { connection, type ConnSnapshot } from '../../live/connection';
import { operatorOf } from '../../live/operator';
import { store } from '../../live/store';
import { groupsFor, type RowOf, type SourceName, type Surface } from '../../live/tables';
import { clockFromRow, clockOrigin, incidentTitle, scenarioTitle, simNowAt, tsToMs, type LiveClock, type TimeBasis } from '../../live/time';
import type {
  AgentInfo,
  CommandSnapshot,
  DangerLevel,
  EventLogEntry,
  FieldReport,
  FireCell,
  FireRiskLayer,
  Flag,
  FlagKind,
  ForecastCell,
  Grid,
  HelpRequest,
  IncidentInfo,
  LiveExtras,
  NewsItem,
  QueueEntry,
  ReportAssessment,
  RequestMessage,
  ResponderSnapshot,
  RiskCard,
  RiskPipelineInfo,
  RoadClosure,
  SimClock,
  SituationInfo,
  Station,
  Unit,
  UnitStatus,
  UnitTrip,
  Weather,
} from '../types';

type Rows<N extends SourceName> = readonly RowOf<N>[];

const NO_ROWS: readonly never[] = Object.freeze([]);
const M_PER_DEG_LAT = 111_320;
/** The backend router's straight-line fallback (agents/rescue/core/routing.py). */
const ROAD_FACTOR = 1.35;
const DRIVE_MPS = 12;
/** Agents heartbeat every 10 s, crew phones every 20 s. */
const FRESH_MS = 45_000;
const NEWS_MIN_RELEVANCE = 0.5;
const NEWS_MAX = 20;
const ACTIVE = new Set(['pending', 'queued', 'assigned', 'en_route', 'on_scene']);
const LEVELS = new Set(['unknown', 'unreachable', 'critical', 'high', 'moderate', 'low']);
const FLAG_KINDS = new Set(['unreachable', 'suspect', 'escalation']);
/** Their rows change every few seconds without anything happening (clock, heartbeats). */
const NOT_UPDATES = new Set<SourceName>(['sim_clock', 'agent', 'crew_presence']);

// ─── Small helpers ─────────────────────────────────────────────────────────

const level = (s: string): DangerLevel => (LEVELS.has(s) ? (s as DangerLevel) : 'unknown');
const q5 = (v: number) => Math.round(v * 1e5) / 1e5;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;
const bigCmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
const singleton = <T extends { id: number }>(rows: readonly T[]): T | undefined => rows.find(r => r.id === 0) ?? rows[0];

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const dy = (lat2 - lat1) * M_PER_DEG_LAT;
  const dx = (lon2 - lon1) * M_PER_DEG_LAT * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** Recompute only when an argument changes identity. */
function memo<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  let last: { args: A; value: R } | undefined;
  return (...args: A): R => {
    if (last && last.args.length === args.length && last.args.every((a, i) => Object.is(a, args[i]))) return last.value;
    const value = fn(...args);
    last = { args, value };
    return value;
  };
}

/** Per-row conversion: an SDK row object that didn't change maps to the same converted object. */
function perRow<R extends object, T>(fn: (row: R) => T): (row: R) => T {
  const cache = new WeakMap<R, T>();
  return row => {
    const hit = cache.get(row);
    if (hit !== undefined) return hit;
    const value = fn(row);
    cache.set(row, value);
    return value;
  };
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every(k => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** `prev` when nothing changed, else `next` with every unchanged item swapped for its previous object. */
function keepArray<T>(prev: readonly T[] | undefined, next: T[]): T[] {
  if (!prev) return next;
  let same = prev.length === next.length;
  const out = next.map((item, i) => {
    if (i < prev.length && shallowEqual(prev[i], item)) return prev[i];
    same = false;
    return item;
  });
  return same ? (prev as T[]) : out;
}

const keepObject = <T>(prev: T | undefined, next: T): T => (prev !== undefined && shallowEqual(prev, next) ? prev : next);

function groupOldestFirst<T extends { requestId: bigint; createdAtMs: number; id: bigint }>(items: T[]): ReadonlyMap<bigint, T[]> {
  const out = new Map<bigint, T[]>();
  for (const it of items) {
    const list = out.get(it.requestId);
    if (list) list.push(it);
    else out.set(it.requestId, [it]);
  }
  for (const list of out.values()) list.sort((a, b) => a.createdAtMs - b.createdAtMs || bigCmp(a.id, b.id));
  return out;
}

// ─── Row conversions (Timestamp → ms, option → null) ──────────────────────

const toStation = perRow((r: RowOf<'station'>): Station => ({ id: r.id, name: r.name, lat: r.lat, lon: r.lon }));

const toUnit = perRow(
  (r: RowOf<'unit'>): Unit => ({
    id: r.id,
    stationId: r.stationId,
    callsign: r.callsign,
    kind: r.kind,
    capacity: r.capacity,
    status: r.status as UnitStatus,
    lat: r.lat,
    lon: r.lon,
    currentRequest: r.currentRequest,
    freeAtS: r.freeAtS,
    updatedAtMs: tsToMs(r.updatedAt),
    trip: null,
  })
);

const toRequest = perRow(
  (r: RowOf<'ops_request'>): HelpRequest => ({
    id: r.id,
    lat: r.lat,
    lon: r.lon,
    headcount: r.headcount,
    needs: r.needs,
    note: r.note,
    status: r.status,
    createdAtMs: tsToMs(r.createdAt),
    consentExpiresAtMs: tsToMs(r.consentExpiresAt),
    level: level(r.level),
    slackS: r.slackS ?? null,
    fireEtaS: r.fireEtaS ?? null,
    extractS: r.extractS,
    pinnedStationId: r.pinnedStationId,
    pinnedUnitId: 0, // the backend pins stations only
    channel: r.channel,
    entrance: r.entrance,
    createdSimS: r.createdSimS,
    hopCount: r.hopCount,
  })
);

const toFireCell = perRow((r: RowOf<'fire_cell'>): FireCell => ({ cellId: r.cellId, ignitedS: r.ignitedS, intensity: r.intensity }));
const toForecastCell = perRow(
  (r: RowOf<'forecast_cell'>): ForecastCell => ({ cellId: r.cellId, arrivalEarlyS: r.arrivalEarlyS, arrivalMedianS: r.arrivalMedianS })
);
const toClosure = perRow(
  (r: RowOf<'road_closure'>): RoadClosure => ({
    id: r.id,
    name: r.name,
    lat1: r.lat1,
    lon1: r.lon1,
    lat2: r.lat2,
    lon2: r.lon2,
    active: r.active,
    updatedAtMs: tsToMs(r.updatedAt),
  })
);

const toFlag = perRow(
  (r: RowOf<'ops_flag'>): Flag => ({
    id: r.id,
    requestId: r.requestId,
    kind: (FLAG_KINDS.has(r.kind) ? r.kind : 'escalation') as FlagKind,
    detail: r.detail,
    recommendation: r.recommendation,
    raisedBy: r.raisedBy,
    resolved: r.resolved,
    resolution: r.resolution,
    createdAtMs: tsToMs(r.createdAt),
  })
);

const toEvent = perRow(
  (r: RowOf<'event_log'>): EventLogEntry => ({
    id: r.id,
    atMs: tsToMs(r.at),
    simS: r.simS,
    actor: r.actor,
    kind: r.kind,
    message: r.message,
    requestId: r.requestId,
  })
);

const toAssessment = perRow(
  (r: RowOf<'ops_assessment'>): ReportAssessment => ({
    requestId: r.requestId,
    reportCount: r.reportCount,
    people: r.people,
    needs: r.needs,
    injured: r.injured,
    trapped: r.trapped,
    fireSeen: r.fireSeen,
    fireDistanceM: r.fireDistanceM,
    smoke: r.smoke,
    roadBlocked: r.roadBlocked,
    roadNote: r.roadNote,
    mediaSupports: r.mediaSupports,
    confidence: r.confidence,
    urgency: r.urgency,
    summary: r.summary,
    residentReply: r.residentReply,
    analyzer: r.analyzer,
    updatedAtMs: tsToMs(r.updatedAt),
  })
);

const toReport = perRow(
  (r: RowOf<'ops_report'>): FieldReport => ({
    id: r.id,
    requestId: r.requestId,
    kind: r.kind,
    text: r.text,
    mediaUrl: r.mediaUrl,
    frameUrls: r.frameUrls
      .split('\n')
      .map(u => u.trim())
      .filter(Boolean),
    createdAtMs: tsToMs(r.createdAt),
  })
);

const toMessage = perRow(
  (r: RowOf<'ops_message'>): RequestMessage => ({
    id: r.id,
    requestId: r.requestId,
    from: r.from,
    author: r.author,
    text: r.text,
    createdAtMs: tsToMs(r.createdAt),
  })
);

const toRisk = perRow((row: RowOf<'ops_risk'>): RiskCard => {
  const a = row.assessment;
  return {
    requestId: a.requestId,
    current: row.current,
    staleReason: row.staleReason,
    assessmentId: a.assessmentId,
    level: level(a.level),
    slackS: a.slackS,
    fireEtaS: a.fireEtaS,
    extractS: a.extractS,
    stationId: a.stationId,
    travelS: a.travelS ?? null,
    waitS: a.waitS ?? null,
    scheduledSlackS: a.scheduledSlackS ?? null,
    reachable: a.reachable,
    headcount: a.headcount,
    needs: a.needs,
    credibility: a.credibility,
    reportedUrgency: a.reportedUrgency,
    trapped: a.trapped,
    injured: a.injured,
    reportNote: a.reportNote,
    forecastId: a.forecastId,
    modelId: a.modelId,
    forecastState: a.forecastState,
    forecastIssueS: a.forecastIssueS,
    horizonsS: a.horizonsS,
    probabilities: a.probabilities,
    arrivalLowerS: a.arrivalLowerS ?? null,
    arrivalUpperS: a.arrivalUpperS ?? null,
    exposureSlackLowerS: a.exposureSlackLowerS ?? null,
    exposureSlackUpperS: a.exposureSlackUpperS ?? null,
    qualityFlags: a.qualityFlags,
    reason: a.reason,
    updatedAtMs: tsToMs(a.updatedAt),
  };
});

const toNews = perRow(
  (r: RowOf<'news_article'>): NewsItem => ({
    id: r.id,
    url: r.url,
    source: r.source,
    title: r.title,
    publishedAtMs: r.publishedAt ? tsToMs(r.publishedAt) : null,
    category: r.category,
    relevance: r.relevance,
    evacuation: r.evacuation,
    closures: r.closures,
    relief: r.relief,
    containmentPct: r.containmentPct ?? null,
    acres: r.acres ?? null,
    official: r.official,
    incident: r.incident,
  })
);

const toSituation = perRow(
  (r: RowOf<'situation'>): SituationInfo => ({
    atMs: tsToMs(r.at),
    simS: r.simS,
    summary: r.summary,
    fireAreaSqKm: r.fireAreaSqKm,
    fireGrowthSqKm: r.fireGrowthSqKm,
    fireHeadingDeg: r.fireHeadingDeg,
    fireHeadKmh: r.fireHeadKmh,
    humidityPct: r.humidityPct,
    redFlag: r.redFlag,
    newsOk: r.newsOk,
    newsRelevant: r.newsRelevant,
    newsEvacuation: r.newsEvacuation,
    newsClosures: r.newsClosures,
    dataFresh: r.dataFresh,
    staleReasons: r.staleReasons,
    reportsActive: r.reportsActive,
    reportsFireCredible: r.reportsFireCredible,
    reportsRoadBlocks: r.reportsRoadBlocks,
    reportsTrapped: r.reportsTrapped,
  })
);

const incidentOf = memo((rows: Rows<'incident'>): IncidentInfo | null => {
  const r = singleton(rows);
  if (!r) return null;
  return {
    key: r.key,
    name: r.name,
    title: incidentTitle(r.key, r.name),
    location: r.location,
    startAtMs: tsToMs(r.startAt),
    newsFromMs: tsToMs(r.newsFrom),
    newsToMs: tsToMs(r.newsTo),
  };
});

/** Every rebuild's starting point: the live store (or nothing, while the tab's connection serves another surface). */
function reader(surface: Surface) {
  const on = connection.getSnapshot().surface === surface;
  return {
    on,
    rows: <N extends SourceName>(name: N): Rows<N> => (on ? store.rows(name) : NO_ROWS),
    changedAt: (name: SourceName) => (on ? store.changedAt(name) : undefined),
  };
}

// ─── Queue: SIM-ONLY fields and escalation rows ────────────────────────────

interface QueueInputs {
  queueRows: Rows<'ops_queue'>;
  units: readonly Unit[];
  requests: readonly HelpRequest[];
  stations: readonly Station[];
  travel: Rows<'ops_travel'>;
  risks: ReadonlyMap<bigint, RiskCard>;
  flags: readonly Flag[];
  nowS: number;
  /** Command only: escalation rows and the pending list. */
  command: boolean;
}

function buildQueue({ queueRows, units, requests, stations, travel, risks, flags, nowS, command }: QueueInputs) {
  const requestById = new Map(requests.map(r => [r.id, r]));
  const stationById = new Map(stations.map(s => [s.id, s]));
  const travelOf = new Map(travel.map(t => [`${t.requestId}|${t.stationId}`, t]));
  const committedBy = new Map<bigint, Unit>();
  for (const u of units) if (u.currentRequest !== 0n) committedBy.set(u.currentRequest, u);

  const straightS = (requestId: bigint, stationId: number) => {
    const r = requestById.get(requestId);
    const s = stationById.get(stationId);
    return r && s ? (distanceM(s.lat, s.lon, r.lat, r.lon) * ROAD_FACTOR) / DRIVE_MPS : 0;
  };
  // Router estimate (unreachable carries a 1e9 sentinel), then the risk card's leg if it's this station's, then
  // straight line. The backend folds wait and travel into etaS (= depart + travel), so wait is what's left.
  const legS = (requestId: bigint, stationId: number) => {
    const t = travelOf.get(`${requestId}|${stationId}`);
    if (t && t.reachable && t.travelS < 1e8) return t.travelS;
    const card = risks.get(requestId);
    if (card && card.stationId === stationId && card.travelS !== null) return card.travelS;
    return straightS(requestId, stationId);
  };

  const committed: QueueEntry[] = [];
  const waiting: QueueEntry[] = [];
  for (const q of queueRows) {
    const unit = committedBy.get(q.requestId);
    const base = { requestId: q.requestId, stationId: q.stationId, rank: q.rank, etaS: q.etaS, reason: q.reason, position: 0 };
    if (unit) {
      // entry.unitId always names the committed unit (screens join on it).
      committed.push({ ...base, unitId: unit.id, waitS: 0, travelS: Math.max(0, q.etaS - nowS) });
    } else {
      const travelS = legS(q.requestId, q.stationId);
      waiting.push({ ...base, unitId: q.unitId, waitS: Math.max(0, q.etaS - nowS - travelS), travelS });
    }
  }
  committed.sort((a, b) => a.etaS - b.etaS || bigCmp(a.requestId, b.requestId));
  waiting.sort((a, b) => a.etaS - b.etaS || a.stationId - b.stationId || a.rank - b.rank || bigCmp(a.requestId, b.requestId));
  const ground = [...committed, ...waiting];
  ground.forEach((e, i) => (e.position = i + 1));
  if (!command) return { queue: ground, pending: [] as HelpRequest[] };

  // The plan leaves unreachable requests out of the queue and raises a flag instead; put them back as escalations.
  const queued = new Set(queueRows.map(q => q.requestId));
  const unreachable = new Map<bigint, Flag>();
  for (const f of flags) if (!f.resolved && f.kind === 'unreachable' && !unreachable.has(f.requestId)) unreachable.set(f.requestId, f);
  const escalations: QueueEntry[] = [];
  const pending: HelpRequest[] = [];
  for (const r of requests) {
    if (queued.has(r.id)) continue;
    const flag = unreachable.get(r.id);
    const stationId = flag || r.level === 'unreachable' ? escalationStation(r, stationById, travel) : null;
    if (stationId === null) {
      pending.push(r);
      continue;
    }
    escalations.push({
      requestId: r.id,
      stationId,
      rank: 0,
      unitId: 0,
      etaS: nowS,
      reason: flag?.recommendation || flag?.detail || 'Unreachable by ground',
      waitS: 0,
      travelS: 0,
      position: 0,
    });
  }
  pending.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return { queue: [...escalations, ...ground], pending };
}

/** Pinned station, else the shortest router estimate, else the nearest station; null without stations. */
function escalationStation(r: HelpRequest, stations: ReadonlyMap<number, Station>, travel: Rows<'ops_travel'>): number | null {
  if (r.pinnedStationId && stations.has(r.pinnedStationId)) return r.pinnedStationId;
  let best: RowOf<'ops_travel'> | undefined;
  for (const t of travel) {
    if (t.requestId !== r.id || !stations.has(t.stationId)) continue;
    if (!best || Number(t.reachable) > Number(best.reachable) || (t.reachable === best.reachable && t.travelS < best.travelS)) best = t;
  }
  if (best) return best.stationId;
  let nearest: Station | undefined;
  let nearestM = Infinity;
  for (const s of stations.values()) {
    const d = distanceM(s.lat, s.lon, r.lat, r.lon);
    if (d < nearestM) {
      nearestM = d;
      nearest = s;
    }
  }
  return nearest ? nearest.id : null;
}

// ─── Units: motion along the current leg ───────────────────────────────────

interface Motion {
  nowS: number;
  clockRow: RowOf<'sim_clock'> | undefined;
  queueByRequest: ReadonlyMap<bigint, RowOf<'ops_queue'>>;
  requestById: ReadonlyMap<bigint, HelpRequest>;
  stationById: ReadonlyMap<number, Station>;
}

function unitMover() {
  // Per unit, keyed by the row write that started the leg: a later pause must not move the departure.
  const departs = new Map<number, { key: string; departS: number }>();
  const trips = new Map<number, { key: string; trip: UnitTrip }>();

  /** Sim second the unit row was written, from server times only (no device clock skew). */
  const departOf = (u: Unit, m: Motion) => {
    const key = `${u.updatedAtMs}|${u.status}`;
    const hit = departs.get(u.id);
    if (hit && hit.key === key) return hit.departS;
    let departS = m.nowS;
    if (m.clockRow) {
      const gapS = m.clockRow.running ? ((tsToMs(m.clockRow.lastTick) - (u.updatedAtMs ?? 0)) / 1000) * m.clockRow.speed : 0;
      departS = Math.min(m.nowS, m.clockRow.simS - gapS);
    }
    departs.set(u.id, { key, departS });
    return departS;
  };

  const along = (u: Unit, m: Motion, toLat: number, toLon: number, departS: number, arriveS: number): Unit => {
    const key = `${u.updatedAtMs}|${u.status}|${u.lat}|${u.lon}|${toLat}|${toLon}|${departS}|${arriveS}`;
    let trip = trips.get(u.id)?.key === key ? trips.get(u.id)!.trip : undefined;
    if (!trip) {
      trip = { fromLat: u.lat, fromLon: u.lon, toLat, toLon, departS, arriveS };
      trips.set(u.id, { key, trip });
    }
    const f = clamp01((m.nowS - departS) / Math.max(1, arriveS - departS));
    return { ...u, lat: q5(u.lat + (toLat - u.lat) * f), lon: q5(u.lon + (toLon - u.lon) * f), trip };
  };

  return (u: Unit, m: Motion): Unit => {
    if (u.currentRequest !== 0n && (u.status === 'en_route' || u.status === 'on_scene')) {
      const r = m.requestById.get(u.currentRequest);
      if (!r) return u;
      if (u.status === 'on_scene') return u.lat === r.lat && u.lon === r.lon ? u : { ...u, lat: r.lat, lon: r.lon };
      // en_route: from where the row says (the station; nothing streams positions) to the request, arriving at etaS.
      const q = m.queueByRequest.get(u.currentRequest);
      if (!q) return u;
      return along(u, m, r.lat, r.lon, Math.min(departOf(u, m), q.etaS - 1), q.etaS);
    }
    if (u.status === 'returning') {
      // The driver leaves the row at the scene; free_at_s is when it is back at its station.
      const s = m.stationById.get(u.stationId);
      if (!s || distanceM(u.lat, u.lon, s.lat, s.lon) < 1) return u;
      const departS = departOf(u, m);
      return along(u, m, s.lat, s.lon, departS, Math.max(u.freeAtS, departS + 1));
    }
    return u;
  };
}

// ─── Shared builder ────────────────────────────────────────────────────────

type Shared = Pick<
  CommandSnapshot,
  'updatedAtMs' | 'clock' | 'grid' | 'stations' | 'units' | 'requests' | 'queue' | 'fireCells' | 'forecastCells' | 'closures' | 'weather' | 'incident'
> & { live: LiveExtras };

interface Built {
  shared: Shared;
  read: ReturnType<typeof reader>;
  queueRows: Rows<'ops_queue'>;
  flags: Flag[];
  stationById: ReadonlyMap<number, Station>;
  baseUnits: readonly Unit[];
}

const NO_FLAGS = Object.freeze([]) as unknown as Flag[];
const NO_NEWS = Object.freeze([]) as unknown as NewsItem[];
const NO_REQUESTS = Object.freeze([]) as unknown as HelpRequest[];
const NO_RISKS: ReadonlyMap<bigint, RiskCard> = new Map();
const EMPTY_GRID: Grid = Object.freeze({ originLat: 0, originLon: 0, cellSizeM: 0, rows: 0, cols: 0 });

function sharedBuilder(surface: Surface, command: boolean) {
  const firstBuildMs = Date.now();
  const { core, extra } = groupsFor(surface);
  const sources = [...core, ...extra].filter(n => !NOT_UPDATES.has(n));
  const move = unitMover();
  let prev: { shared: Shared; agents: AgentInfo[]; crewed: number[] } | undefined;

  const stationsOf = memo((rows: Rows<'station'>) => rows.map(toStation).sort(byId));
  const stationMapOf = memo((stations: Station[]) => new Map(stations.map(s => [s.id, s])));
  const unitsOf = memo((rows: Rows<'unit'>) => rows.map(toUnit).sort(byId));
  const requestsOf = memo((rows: Rows<'ops_request'>) => rows.filter(r => ACTIVE.has(r.status) && !r.locationPurged).map(toRequest));
  const assessedRequestsOf = memo((requests: HelpRequest[], risks: ReadonlyMap<bigint, RiskCard>) => requests.map(r => {
    const risk = risks.get(r.id);
    return !risk || !risk.current ? { ...r, level: 'unknown' as const, slackS: null, fireEtaS: null } : r;
  }));
  const requestMapOf = memo((requests: HelpRequest[]) => new Map(requests.map(r => [r.id, r])));
  const queueMapOf = memo((rows: Rows<'ops_queue'>) => new Map(rows.map(q => [q.requestId, q])));
  const fireOf = memo((rows: Rows<'fire_cell'>) => rows.map(toFireCell));
  const forecastOf = memo((rows: Rows<'forecast_cell'>) => rows.map(toForecastCell));
  const closuresOf = memo((rows: Rows<'road_closure'>) => rows.map(toClosure));
  const flagsOf = memo((rows: Rows<'ops_flag'>) => rows.map(toFlag).sort((a, b) => a.createdAtMs - b.createdAtMs || bigCmp(a.id, b.id)));
  const gridOf = memo((rows: Rows<'grid'>): Grid => {
    const g = singleton(rows);
    return g ? { originLat: g.originLat, originLon: g.originLon, cellSizeM: g.cellSizeM, rows: g.rows, cols: g.cols } : EMPTY_GRID;
  });
  const weatherOf = memo(
    (rows: Rows<'weather'>): Weather => {
      const w = singleton(rows);
      if (!w) return { windSpeedMps: 0, windFromDeg: 0, gustMps: 0, source: 'none', locked: false, updatedAtMs: firstBuildMs };
      return { windSpeedMps: w.windSpeedMps, windFromDeg: w.windFromDeg, gustMps: w.gustMps, source: w.source, locked: w.locked, updatedAtMs: tsToMs(w.updatedAt) };
    }
  );
  const clockOf = memo((simS: number, speed: number, running: boolean, lastTickMs: number, originMs: number): SimClock => ({ simS, speed, running, lastTickMs, originMs }));
  const baseIncidentOf = memo((info: IncidentInfo | null, scenario: string): Shared['incident'] =>
    info
      ? { id: info.key || scenario, name: info.title, area: info.location }
      : { id: scenario, name: scenario === 'none' ? 'No incident loaded' : scenarioTitle(scenario), area: '' }
  );
  const connectionOf = memo((state: ConnSnapshot['state'], lastLiveAt: number | null) => ({ state, lastLiveAtMs: lastLiveAt }));
  const operatorFrom = memo(operatorOf);
  const pipelineOf = memo((rows: Rows<'risk_pipeline'>): RiskPipelineInfo | null => {
    const p = singleton(rows);
    return p ? { status: p.status, activeBackend: p.activeBackend, reason: p.reason, forecastId: p.forecastId, updatedAtMs: tsToMs(p.updatedAt) } : null;
  });
  const assessmentsOf = memo((rows: Rows<'ops_assessment'>): ReadonlyMap<bigint, ReportAssessment> => new Map(rows.map(r => [r.requestId, toAssessment(r)])));
  const reportsOf = memo((rows: Rows<'ops_report'>) => groupOldestFirst(rows.map(toReport)));
  const messagesOf = memo((rows: Rows<'ops_message'>) => groupOldestFirst(rows.map(toMessage)));
  const risksOf = memo((rows: Rows<'ops_risk'>): ReadonlyMap<bigint, RiskCard> => {
    if (!rows.length) return NO_RISKS;
    const out = new Map<bigint, RiskCard>();
    for (const r of rows) out.set(r.assessment.requestId, toRisk(r));
    return out;
  });
  const fireRiskOf = memo((metas: Rows<'fire_risk_meta'>, cellRows: Rows<'fire_risk_cell'>): FireRiskLayer | null => {
    const m = singleton(metas);
    if (!m) return null;
    const slot = new Map(m.horizonsS.map((h, i) => [Math.round(h), i]));
    const byCell = new Map<number, FireRiskLayer['cells'][number]>();
    for (const c of cellRows) {
      const i = slot.get(Math.round(c.horizonS));
      if (i === undefined) continue;
      let cell = byCell.get(c.cellId);
      if (!cell) {
        // NaN = no value for that horizon (the module rejects incomplete cells, so this shouldn't show).
        cell = { cellId: c.cellId, p: m.horizonsS.map(() => NaN), observed: false };
        byCell.set(c.cellId, cell);
      }
      cell.p[i] = c.probability;
      if (c.observed) cell.observed = true;
    }
    return {
      modelId: m.modelId,
      forecastId: m.forecastId,
      observationId: m.observationId,
      source: m.source,
      timeBasis: m.timeBasis,
      issueS: m.issueS,
      sourceIssueUtcS: m.sourceIssueUtcS,
      observationAgeS: m.observationAgeS,
      horizonsS: m.horizonsS,
      crs: m.crs,
      westM: m.westM,
      southM: m.southM,
      cellSizeM: m.cellSizeM,
      rows: m.rows,
      cols: m.cols,
      qualityFlags: m.qualityFlags,
      cells: [...byCell.values()].sort((a, b) => a.cellId - b.cellId),
      updatedAtMs: tsToMs(m.updatedAt),
    };
  });
  const situationOf = memo((rows: Rows<'situation'>): SituationInfo | null => {
    let newest: RowOf<'situation'> | undefined;
    for (const r of rows) {
      const d = newest ? bigCmp(r.at.microsSinceUnixEpoch, newest.at.microsSinceUnixEpoch) || bigCmp(r.id, newest.id) : 1;
      if (d > 0) newest = r;
    }
    return newest ? toSituation(newest) : null;
  });
  const newsOf = memo((rows: Rows<'news_article'>, incidentKey: string | null): NewsItem[] => {
    const when = (a: RowOf<'news_article'>) => (a.publishedAt ?? a.fetchedAt).microsSinceUnixEpoch;
    const picked = rows
      .filter(a => a.relevance >= NEWS_MIN_RELEVANCE && (incidentKey === null || a.incident === incidentKey))
      .sort((a, b) => bigCmp(when(b), when(a)) || bigCmp(b.id, a.id))
      .slice(0, NEWS_MAX)
      .map(toNews);
    return picked.length ? picked : NO_NEWS;
  });

  return (): Built => {
    const read = reader(surface);
    const conn = connection.getSnapshot();
    const nowMs = Date.now();

    const clockRow = singleton(read.rows('sim_clock'));
    const incident = incidentOf(read.rows('incident'));
    const scenario = clockRow?.scenario ?? 'none';
    const receivedAt = read.changedAt('sim_clock');
    const lc: LiveClock = clockRow ? clockFromRow(clockRow, receivedAt) : { simS: 0, speed: 1, running: false, lastTickMs: firstBuildMs };
    const origin: { originMs: number; timeBasis: TimeBasis } = clockRow
      ? clockOrigin(clockRow, lc, incident ? incident.startAtMs : null)
      : { originMs: incident?.startAtMs ?? firstBuildMs, timeBasis: incident ? 'incident' : 'wall' };
    const clock = clockOf(lc.simS, lc.speed, lc.running, lc.lastTickMs, origin.originMs);
    const nowS = simNowAt(lc, nowMs);

    const stations = stationsOf(read.rows('station'));
    const stationById = stationMapOf(stations);
    const risks = risksOf(read.rows('ops_risk'));
    const requests = assessedRequestsOf(requestsOf(read.rows('ops_request')), risks);
    const queueRows = read.rows('ops_queue');
    const baseUnits = unitsOf(read.rows('unit'));
    const motion: Motion = { nowS, clockRow, queueByRequest: queueMapOf(queueRows), requestById: requestMapOf(requests), stationById };
    const units = keepArray(prev?.shared.units, baseUnits.map(u => move(u, motion)));
    const flags = command ? flagsOf(read.rows('ops_flag')) : NO_FLAGS;
    const { queue, pending } = buildQueue({
      queueRows,
      units: baseUnits,
      requests,
      stations,
      travel: command ? read.rows('ops_travel') : NO_ROWS,
      risks,
      flags,
      nowS,
      command,
    });

    let updatedAtMs = 0;
    for (const name of sources) updatedAtMs = Math.max(updatedAtMs, read.changedAt(name) ?? 0);
    if (!updatedAtMs) updatedAtMs = firstBuildMs;

    // Freshness against the server's clock (its last tick, plus the time since it arrived), so a device clock that
    // is off doesn't mark the agents stale.
    const serverNowMs = clockRow && receivedAt !== undefined ? tsToMs(clockRow.lastTick) + (nowMs - receivedAt) : nowMs;
    const agents = keepArray(
      prev?.agents,
      read
        .rows('agent')
        .map(a => ({ role: a.role, name: a.name, status: a.status, detail: a.detail, lastSeenMs: tsToMs(a.lastSeen), fresh: serverNowMs - tsToMs(a.lastSeen) < FRESH_MS }))
        .sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name))
    );
    const crewed = keepArray(
      prev?.crewed,
      read
        .rows('crew_presence')
        .filter(p => serverNowMs - tsToMs(p.seenAt) < FRESH_MS)
        .map(p => p.unitId)
        .sort((a, b) => a - b)
    );

    const live: LiveExtras = keepObject(prev?.shared.live, {
      mode: incident ? 'replay' : 'live',
      timeBasis: origin.timeBasis,
      scenario,
      incident,
      connection: connectionOf(conn.state, conn.lastLiveAt),
      operator: operatorFrom(read.rows('my_operator')),
      agents,
      crewedUnitIds: crewed,
      riskPipeline: pipelineOf(read.rows('risk_pipeline')),
      assessments: assessmentsOf(read.rows('ops_assessment')),
      reports: reportsOf(read.rows('ops_report')),
      messages: messagesOf(read.rows('ops_message')),
      risks,
      pending: keepArray(prev?.shared.live.pending, pending.length ? pending : NO_REQUESTS),
      fireRisk: fireRiskOf(read.rows('fire_risk_meta'), command ? read.rows('fire_risk_cell') : read.rows('fire_concern')),
      situation: command ? situationOf(read.rows('situation')) : null,
      news: command ? newsOf(read.rows('news_article'), incident ? incident.key : null) : NO_NEWS,
    });

    const shared: Shared = keepObject(prev?.shared, {
      updatedAtMs,
      clock,
      grid: gridOf(read.rows('grid')),
      stations,
      units,
      requests,
      queue: keepArray(prev?.shared.queue, queue),
      fireCells: fireOf(read.rows('fire_cell')),
      forecastCells: forecastOf(read.rows('forecast_cell')),
      closures: closuresOf(read.rows('road_closure')),
      weather: weatherOf(read.rows('weather')),
      incident: baseIncidentOf(incident, scenario),
      live,
    });
    prev = { shared, agents, crewed };
    return { shared, read, queueRows, flags, stationById, baseUnits };
  };
}

// ─── The two snapshots ─────────────────────────────────────────────────────

const POLICY = Object.freeze({
  marginS: 300,
  distancePreference: Object.freeze({ enabled: false, weight: 0 }),
  includeGusts: false,
  includeHumidity: false,
  humidityPct: 25,
  keepPinsOnRerank: true,
}) as CommandSnapshot['policy'];
const NO_PINS = Object.freeze([]) as unknown as CommandSnapshot['pins'];

/** The commander's whole picture. */
export function createCommandBuilder(): () => CommandSnapshot {
  const shared = sharedBuilder('command', true);
  const eventsOf = memo((rows: Rows<'event_log'>) => rows.map(toEvent).sort((a, b) => b.atMs - a.atMs || bigCmp(b.id, a.id)));
  const planOf = memo((rows: Rows<'ops_queue'>, fallbackMs: number): CommandSnapshot['lastPlan'] => {
    let atMs = 0;
    let latest: RowOf<'ops_queue'> | undefined;
    for (const q of rows) {
      atMs = Math.max(atMs, tsToMs(q.updatedAt));
      if (!latest || q.planVersion > latest.planVersion) latest = q;
    }
    return { atMs: atMs || fallbackMs, reason: latest ? `${latest.policy || 'Dispatch policy'} · plan v${latest.planVersion}` : 'Awaiting plan' };
  });
  let prev: CommandSnapshot | undefined;

  return () => {
    const { shared: s, read, queueRows, flags } = shared();
    const forecastMeta = singleton(read.rows('forecast_meta'));
    const weatherRow = singleton(read.rows('weather'));
    const closureMs = s.closures.reduce((m, c) => Math.max(m, c.updatedAtMs), 0);
    const next: CommandSnapshot = {
      ...s,
      flags,
      events: eventsOf(read.rows('event_log')),
      policy: POLICY,
      pins: NO_PINS,
      lastPlan: keepObject(prev?.lastPlan, planOf(queueRows, s.updatedAtMs)),
      // Every one finite: the clock formatters throw on -Infinity / NaN.
      sources: keepObject(prev?.sources, {
        fireMs: read.changedAt('fire_cell') ?? (forecastMeta ? tsToMs(forecastMeta.updatedAt) : s.updatedAtMs),
        weatherMs: weatherRow ? tsToMs(weatherRow.updatedAt) : s.updatedAtMs,
        closuresMs: closureMs || s.updatedAtMs,
      }),
      startS: 0, // load_scenario resets simS to 0
    };
    prev = keepObject(prev, next);
    return prev;
  };
}

/** One responder phone: the unit's station-scoped views (the server already scopes ops_* to the station). */
export function createResponderBuilder(unitId: number): () => ResponderSnapshot {
  const shared = sharedBuilder(`responder:${unitId}`, false);
  // Before the rows arrive (or for an unknown unit): somewhere sensible to centre the map, never undefined.
  const placeholderOf = memo((stationId: number, lat: number, lon: number): Station => ({ id: stationId, name: stationId ? `Station ${stationId}` : 'Station', lat, lon }));
  let prev: ResponderSnapshot | undefined;

  return () => {
    const { shared: s, stationById, baseUnits } = shared();
    const unit = baseUnits.find(u => u.id === unitId);
    const op = s.live.operator;
    const stationId = unit?.stationId ?? (op?.role === 'responder' ? op.stationId : 0);
    const g = s.grid;
    const centreLat = g.rows ? g.originLat + (g.rows * g.cellSizeM) / M_PER_DEG_LAT / 2 : 0;
    const centreLon = g.cols ? g.originLon + (g.cols * g.cellSizeM) / (M_PER_DEG_LAT * Math.cos((g.originLat * Math.PI) / 180)) / 2 : 0;
    const next: ResponderSnapshot = {
      ...s,
      me: keepObject(prev?.me, { stationId, unitId }),
      station: stationById.get(stationId) ?? placeholderOf(stationId, unit?.lat ?? centreLat, unit?.lon ?? centreLon),
    };
    prev = keepObject(prev, next);
    return prev;
  };
}

// ─── Store adapter ─────────────────────────────────────────────────────────

/**
 * getSnapshot/subscribe over the live store for useSyncExternalStore: the same object until a source or the
 * connection changes, and a stable subscribe. `onActive` reports the first subscriber arriving and the last leaving;
 * `onChange` runs on every change while subscribed.
 */
export function liveStore<S>(build: () => S, hooks: { onActive?(active: boolean): void; onChange?(): void } = {}) {
  const listeners = new Set<() => void>();
  let cache: { epoch: number; conn: ConnSnapshot; snap: S } | undefined;
  let unsubscribe: Array<() => void> = [];
  const notify = () => {
    hooks.onChange?.();
    listeners.forEach(l => l());
  };
  return {
    getSnapshot: (): S => {
      const epoch = store.epoch();
      const conn = connection.getSnapshot();
      if (cache && cache.epoch === epoch && cache.conn === conn) return cache.snap;
      cache = { epoch, conn, snap: build() };
      return cache.snap;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        unsubscribe = [store.subscribeAny(notify), connection.subscribe(notify)];
        hooks.onActive?.(true);
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        unsubscribe.forEach(u => u());
        unsubscribe = [];
        hooks.onActive?.(false);
      };
    },
  };
}
