// Row shapes for the operations screens (responder phone + incident command).
// They mirror the SpacetimeDB module (spacetimedb/src/schema.ts) field-for-field
// in the camelCase the TypeScript client bindings generate, with two
// deliberate simplifications:
//   - timestamps are epoch milliseconds (bindings give `Timestamp`)
//   - option<f64> is `number | null`
// A real data source converts those two things and nothing else, except
// where a field is marked SIM-ONLY (no backend equivalent yet) or LIVE-ONLY
// (only the SpacetimeDB source fills it; the simulation leaves it undefined).

/** sim_clock (singleton). Every fire/ETA number is in sim seconds. */
export interface SimClock {
  simS: number;
  /** Sim seconds per real second. */
  speed: number;
  running: boolean;
  /** Wall-clock ms when `simS` was last written. Live: when this browser received it, so server/browser clock
   *  skew (multiplied by speed) doesn't leak into the extrapolation. */
  lastTickMs: number;
  /**
   * LIVE-ONLY: the display time (epoch ms) of sim T+0, so a sim second reads as a clock time that agrees with
   * "N min" at any speed: `originMs + s * 1000`. A replay uses the incident's real start time; otherwise it is
   * the scenario's own clock. See LiveExtras.timeBasis.
   */
  originMs?: number;
}

/** grid (singleton). Cell (row, col) has cellId = row * cols + col; row 0 is south. */
export interface Grid {
  originLat: number;
  originLon: number;
  cellSizeM: number;
  rows: number;
  cols: number;
}

export interface Station {
  id: number;
  name: string;
  lat: number;
  lon: number;
}

export type UnitStatus = 'available' | 'assigned' | 'en_route' | 'on_scene' | 'returning' | 'out_of_service';

export interface Unit {
  id: number;
  stationId: number;
  callsign: string;
  kind: string;
  capacity: number;
  status: UnitStatus;
  lat: number;
  lon: number;
  /** Request the unit is committed to; 0n = none. */
  currentRequest: bigint;
  freeAtS: number;
  /** LIVE-ONLY: when the unit row was last written (epoch ms, server time). */
  updatedAtMs?: number;
  /**
   * LIVE-ONLY: the leg the unit is driving (en_route: to the scene; returning: back to its station). Units are
   * written only at lifecycle steps, never while moving, so `lat`/`lon` above are already interpolated along
   * this leg. Route and label code should key on the leg's fixed `from`, not on the moving position.
   */
  trip?: UnitTrip | null;
}

/** LIVE-ONLY: one leg of a unit's mission, in sim seconds. */
export interface UnitTrip {
  route?: import('./routing').Route;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  departS: number;
  arriveS: number;
}

/** weather (singleton). `locked` = commander has manual control. */
export interface Weather {
  windSpeedMps: number;
  /** Meteorological: direction the wind blows FROM. */
  windFromDeg: number;
  gustMps: number;
  source: string;
  locked: boolean;
  updatedAtMs: number;
}

export interface FireCell {
  cellId: number;
  ignitedS: number;
  intensity: number;
}

/** Forecast fire arrival per unburnt cell. p10 = earliest-10% (plan against this). */
export interface ForecastCell {
  cellId: number;
  arrivalEarlyS: number;
  arrivalMedianS: number;
}

export interface RoadClosure {
  id: bigint;
  name: string;
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
  active: boolean;
  updatedAtMs: number;
}

export type DangerLevel = 'unknown' | 'unreachable' | 'critical' | 'high' | 'moderate' | 'low';

/** help_request, as exposed through the ops_request view. */
export interface HelpRequest {
  id: bigint;
  lat: number;
  lon: number;
  headcount: number;
  /** Comma list: mobility,medical,oxygen,infant,elderly,pets */
  needs: string;
  note: string;
  status: string;
  createdAtMs: number;
  consentExpiresAtMs: number;
  level: DangerLevel;
  slackS: number | null;
  /** Absolute sim second the fire is forecast to arrive (p10). */
  fireEtaS: number | null;
  extractS: number;
  /** Commander override; 0 = not pinned. */
  pinnedStationId: number;
  /** SIM-ONLY: commander assignment to one unit (the backend can only pin a station); 0 = none. */
  pinnedUnitId: number;
  /** LIVE-ONLY: app | asi1 | sms_sim | synthetic (seeded or mock pings). */
  channel?: string;
  entrance?: string;
  /** LIVE-ONLY: sim second the request arrived. */
  createdSimS?: number;
  /** LIVE-ONLY: how many times the plan moved it between stations. */
  hopCount?: number;
}

/** queue_entry, through the ops_queue view. */
export interface QueueEntry {
  requestId: bigint;
  stationId: number;
  /** Position in this station's queue (1 = next). */
  rank: number;
  /** Planned unit; 0 = waiting for a unit. */
  unitId: number;
  /** Absolute sim second a unit is expected on scene. */
  etaS: number;
  /** Operator-facing "why this rank". */
  reason: string;
  /** SIM-ONLY: wait for the unit to free up, and travel, both in seconds (the backend folds these into etaS). */
  waitS: number;
  travelS: number;
  /** SIM-ONLY: position in the incident-wide ground queue (1 = first); 0 = escalated, not in ground dispatch. */
  position: number;
}

export type FlagKind = 'unreachable' | 'suspect' | 'escalation';

export interface Flag {
  id: bigint;
  requestId: bigint;
  kind: FlagKind;
  detail: string;
  recommendation: string;
  raisedBy: string;
  resolved: boolean;
  resolution: string;
  createdAtMs: number;
}

/** event_log: the public activity feed. Never contains location or names. */
export interface EventLogEntry {
  id: bigint;
  atMs: number;
  simS: number;
  actor: string;
  kind: string;
  message: string;
  requestId: bigint;
}

export type MissionOutcome = 'rescued' | 'not_found' | 'aborted';

// ─── Planning policy (SIM-ONLY) ────────────────────────────────────────────
// The delegation agent's tunables. The backend has no table for these yet;
// a real implementation would send them to the delegation agent (uAgents
// message) and read the resulting plan back through queue_entry.

export interface PlanPolicy {
  /** Safety margin subtracted from slack. Fixed baseline. */
  marginS: number;
  /** Within one safety band, favour requests farther from their station. */
  distancePreference: { enabled: boolean; weight: number };
  /** Forecast inputs beyond the weather row. */
  includeGusts: boolean;
  includeHumidity: boolean;
  humidityPct: number;
  /** On automatic rerank, keep manual ground-position pins or release them. */
  keepPinsOnRerank: boolean;
}

/** SIM-ONLY: commander pin of a request to a position among waiting (not yet dispatched) ground requests. */
export interface PositionPin {
  requestId: bigint;
  position: number;
  reason: string;
  by: string;
  atMs: number;
}

// ─── Live-only extras (SpacetimeDB) ────────────────────────────────────────
// What the backend has beyond the simulation's tables: the agents' readings,
// the learned fire risk, the replay window. Only the live source fills
// `snapshot.live`; with the simulation it is undefined, so every screen that
// shows these must treat them as optional.

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'error';

/** incident (singleton): the real-world fire a replay follows and its time window. Absent = live mode. */
export interface IncidentInfo {
  key: string;
  /** Raw incident.name. A recorded replay uses its scenario id (e.g. 'recorded-sequence-2bdb…'). */
  name: string;
  /** Readable title for headers, e.g. 'Recorded fire · sequence 2bdb2c'. */
  title: string;
  location: string;
  /** Real time that sim T+0 maps to. */
  startAtMs: number;
  newsFromMs: number;
  newsToMs: number;
}

/** agent: who is in the agent mesh and what each one last said. */
export interface AgentInfo {
  role: string;
  name: string;
  /** starting | online | degraded | … */
  status: string;
  detail: string;
  lastSeenMs: number;
  /** Seen within the last 45 s (agents heartbeat every 10 s). */
  fresh: boolean;
}

/** risk_pipeline (singleton): is the learned fire-risk model active? */
export interface RiskPipelineInfo {
  /** ready | fallback | error | disabled */
  status: string;
  activeBackend: string;
  reason: string;
  forecastId: string;
  updatedAtMs: number;
}

/** ops_assessment: the intake agent's reading of what a resident sent. Claims, not facts. */
export interface ReportAssessment {
  requestId: bigint;
  reportCount: number;
  /** 0 = not stated. */
  people: number;
  needs: string;
  injured: boolean;
  trapped: boolean;
  fireSeen: boolean;
  /** < 0 = unknown. */
  fireDistanceM: number;
  smoke: boolean;
  roadBlocked: boolean;
  roadNote: string;
  /** The photos / frames themselves show the fire or the blocked road. */
  mediaSupports: boolean;
  confidence: number;
  urgency: number;
  summary: string;
  residentReply: string;
  /** Model id, or 'keywords' / 'form'. */
  analyzer: string;
  updatedAtMs: number;
}

/** ops_report: what a resident sent, raw and unfiltered. */
export interface FieldReport {
  id: bigint;
  requestId: bigint;
  /** text | voice | image | video */
  kind: string;
  text: string;
  mediaUrl: string;
  /** Video only: still frames (https URLs). */
  frameUrls: string[];
  createdAtMs: number;
}

/** ops_message: the responder / resident conversation on one request. */
export interface RequestMessage {
  id: bigint;
  requestId: bigint;
  /** responder | commander | resident */
  from: string;
  /** Display name ('' for the resident). */
  author: string;
  text: string;
  createdAtMs: number;
}

/**
 * ops_risk / my_risk: the commander's composed risk record for one request (physical danger + learned exposure +
 * weighed evidence). Show `current` next to it: false means inputs changed and a reassessment is pending. Unknown,
 * censored or stale values must never be presented as low risk.
 */
export interface RiskCard {
  requestId: bigint;
  current: boolean;
  staleReason: string;
  assessmentId: string;
  level: DangerLevel;
  slackS: number;
  fireEtaS: number;
  extractS: number;
  /** Earliest estimated station option, including the unit's wait; not a dispatch promise. */
  stationId: number;
  travelS: number | null;
  waitS: number | null;
  scheduledSlackS: number | null;
  reachable: boolean;
  headcount: number;
  needs: string;
  credibility: number;
  reportedUrgency: number;
  trapped: boolean;
  injured: boolean;
  reportNote: string;
  forecastId: string;
  modelId: string;
  forecastState: string;
  forecastIssueS: number;
  /** Cumulative probability the fire reaches the request within each horizon. Empty = unknown, never zero risk. */
  horizonsS: number[];
  probabilities: number[];
  arrivalLowerS: number | null;
  arrivalUpperS: number | null;
  exposureSlackLowerS: number | null;
  exposureSlackUpperS: number | null;
  /** Display-only notices (also carry news / resident-report hints). Never parse them for logic. */
  qualityFlags: string[];
  reason: string;
  updatedAtMs: number;
}

/** fire_risk_meta + fire_risk_cell: the learned fire-exposure map (geographic; no resident data). */
export interface FireRiskLayer {
  modelId: string;
  forecastId: string;
  observationId: string;
  /** learned | simulation | persistence */
  source: string;
  timeBasis: string;
  /** Sim second the forecast was issued for. */
  issueS: number;
  /** The recording's original UTC (seconds), 0 if not a recording. */
  sourceIssueUtcS: number;
  observationAgeS: number;
  horizonsS: number[];
  /** Projected grid, NOT the routing grid: crs such as 'EPSG:32612' (UTM 12N), south-west corner in metres,
   *  row 0 south, col 0 west, cellId = row * cols + col. */
  crs: string;
  westM: number;
  southM: number;
  cellSizeM: number;
  rows: number;
  cols: number;
  qualityFlags: string[];
  /** One entry per cell that has values; `p` is aligned with `horizonsS` (cumulative, non-decreasing). */
  cells: { cellId: number; p: number[]; observed: boolean }[];
  updatedAtMs: number;
}

/** situation (newest row): the commander agent's pooled picture. Counts only, no resident data. */
export interface SituationInfo {
  atMs: number;
  simS: number;
  summary: string;
  fireAreaSqKm: number;
  fireGrowthSqKm: number;
  fireHeadingDeg: number;
  fireHeadKmh: number;
  /** -1 = unknown */
  humidityPct: number;
  redFlag: boolean;
  newsOk: boolean;
  newsRelevant: number;
  newsEvacuation: boolean;
  newsClosures: number;
  dataFresh: boolean;
  staleReasons: string;
  reportsActive: number;
  reportsFireCredible: number;
  reportsRoadBlocks: number;
  reportsTrapped: number;
}

/** news_article: wildfire posts from trusted X accounts (public posts; hints for the commander). */
export interface NewsItem {
  id: bigint;
  url: string;
  source: string;
  title: string;
  publishedAtMs: number | null;
  category: string;
  relevance: number;
  evacuation: boolean;
  closures: string;
  relief: string;
  containmentPct: number | null;
  acres: number | null;
  official: boolean;
  incident: string;
}

/** my_operator: who this browser is signed in as. */
export interface OperatorInfo {
  role: 'commander' | 'responder';
  /** 0 for the commander. */
  stationId: number;
  name: string;
}

export interface LiveExtras {
  /** 'replay' when an incident row sets a past time window (recorded fire, FIRMS replay); otherwise 'live'. */
  mode: 'live' | 'replay';
  /** What SimClock.originMs means: the incident's real time, the scenario's own clock, or wall time (1x live). */
  timeBasis: 'incident' | 'scenario' | 'wall';
  /** sim_clock.scenario ('none' before a scenario is loaded). */
  scenario: string;
  incident: IncidentInfo | null;
  connection: { state: ConnState; lastLiveAtMs: number | null };
  operator: OperatorInfo | null;
  /** Agent mesh rows, sorted by role then name. The simulated-crews driver is role 'scenario', name 'sim-crews'. */
  agents: AgentInfo[];
  /** Units with a responder phone open (crew_presence seen within 45 s). */
  crewedUnitIds: number[];
  riskPipeline: RiskPipelineInfo | null;
  /** Keyed by request id. Responder: its station's requests only. */
  assessments: ReadonlyMap<bigint, ReportAssessment>;
  /** Oldest first. */
  reports: ReadonlyMap<bigint, FieldReport[]>;
  /** Oldest first. */
  messages: ReadonlyMap<bigint, RequestMessage[]>;
  risks: ReadonlyMap<bigint, RiskCard>;
  /** Command only: active requests that have no queue row yet (intake grace period, or waiting for a current risk
   *  assessment before the next plan); empty for responders. */
  pending: HelpRequest[];
  /** Command only. */
  fireRisk: FireRiskLayer | null;
  /** Command only. */
  situation: SituationInfo | null;
  /** Command only: relevant posts (relevance >= 0.5) for the current incident window, newest first. */
  news: NewsItem[];
}

// ─── Snapshots ─────────────────────────────────────────────────────────────

interface BaseSnapshot {
  /** Wall-clock ms of the last change from the data source. Live: the last change to anything but the clock
   *  and agent heartbeats. */
  updatedAtMs: number;
  clock: SimClock;
  grid: Grid;
  stations: Station[];
  units: Unit[];
  requests: HelpRequest[];
  queue: QueueEntry[];
  fireCells: FireCell[];
  forecastCells: ForecastCell[];
  closures: RoadClosure[];
  weather: Weather;
  incident: { id: string; name: string; area: string };
  /** LIVE-ONLY: see LiveExtras. */
  live?: LiveExtras;
}

/** What one responder phone sees (station-scoped views). */
export interface ResponderSnapshot extends BaseSnapshot {
  /** Which station and unit this phone belongs to (operator row + device setting). */
  me: { stationId: number; unitId: number };
  station: Station;
}

/** What incident command sees (all rows). */
export interface CommandSnapshot extends BaseSnapshot {
  flags: Flag[];
  events: EventLogEntry[];
  policy: PlanPolicy;
  pins: PositionPin[];
  /** When the plan was last recomputed and why. */
  lastPlan: { atMs: number; reason: string };
  /** Freshness of each input feed. */
  sources: { fireMs: number; weatherMs: number; closuresMs: number };
  /** Sim second the scenario started (T+00:00). */
  startS: number;
}
