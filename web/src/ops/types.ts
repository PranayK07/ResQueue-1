// Row shapes for the operations screens (responder phone + incident command).
// They mirror the SpacetimeDB module (spacetimedb/src/schema.ts) field-for-field
// in the camelCase the TypeScript client bindings generate, with two
// deliberate simplifications:
//   - timestamps are epoch milliseconds (bindings give `Timestamp`)
//   - option<f64> is `number | null`
// A real data source converts those two things and nothing else, except
// where a field is marked SIM-ONLY (no backend equivalent yet).

/** sim_clock (singleton). Every fire/ETA number is in sim seconds. */
export interface SimClock {
  simS: number;
  /** Sim seconds per real second. */
  speed: number;
  running: boolean;
  /** Wall-clock ms when `simS` was last written. */
  lastTickMs: number;
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

export type DangerLevel = 'unknown' | 'unreachable' | 'critical' | 'high' | 'moderate';

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

// ─── Snapshots ─────────────────────────────────────────────────────────────

interface BaseSnapshot {
  /** Wall-clock ms of the last change from the data source. */
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
