// Shared live state for the Wildfire Rescue Queue.
//
// Every agent, responder phone, resident phone and the commander dashboard
// subscribes to these tables. Incident data that identifies a person
// (help_request, queue_entry, travel_estimate, flag) is PRIVATE and is only
// exposed through role-gated views in index.ts; public tables carry nothing
// that locates a resident.
import { schema, table, t } from 'spacetimedb/server';

// ─── Config / access control ────────────────────────────────────────────────

/** Fetch.ai agents that have joined with the AGENT_JOIN_KEY. Public so the
 *  dashboard can render the live agent mesh (who is online, what they did). */
export const agent = table(
  { name: 'agent', public: true },
  {
    identity: t.identity().primaryKey(),
    role: t.string(), // hazard (fire+weather+forecast) | news | closures | danger | delegation | station | intake | commander | scenario  (legacy: fire | weather | forecast)
    name: t.string(),
    stationId: t.u32(), // only for role=station, else 0
    fetchAddress: t.string(), // agent1q... address on Agentverse
    status: t.string(),
    detail: t.string(),
    lastSeen: t.timestamp(),
  }
);

/** Humans using the web/phone UI with elevated access. */
export const operator = table(
  { name: 'operator' },
  {
    identity: t.identity().primaryKey(),
    role: t.string(), // commander | responder
    stationId: t.u32(),
    name: t.string(),
    joinedAt: t.timestamp(),
  }
);

// ─── Simulation clock & world ───────────────────────────────────────────────

/** Singleton (id = 0). sim_s is "seconds since scenario start"; every
 *  fire/forecast/ETA number in the system is expressed in sim seconds. */
export const simClock = table(
  { name: 'sim_clock', public: true },
  {
    id: t.u8().primaryKey(),
    simS: t.f64(),
    speed: t.f64(), // sim seconds per real second
    running: t.bool(),
    scenario: t.string(),
    lastTick: t.timestamp(),
  }
);

/** Drives sim_tick on an interval. */
export const simTickTimer = table(
  { name: 'sim_tick_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

/** Singleton (id = 0). Geometry of the fire grid. Cell (row, col) has
 *  cell_id = row * cols + col; row 0 is the SOUTH edge. */
export const grid = table(
  { name: 'grid', public: true },
  {
    id: t.u8().primaryKey(),
    originLat: t.f64(), // south-west corner
    originLon: t.f64(),
    cellSizeM: t.f64(),
    rows: t.u32(),
    cols: t.u32(),
  }
);

export const station = table(
  { name: 'station', public: true },
  {
    id: t.u32().primaryKey(),
    name: t.string(),
    lat: t.f64(),
    lon: t.f64(),
  }
);

export const unit = table(
  { name: 'unit', public: true },
  {
    id: t.u32().primaryKey(),
    stationId: t.u32().index('btree'),
    callsign: t.string(),
    kind: t.string(), // engine | ambulance | bus | ...
    capacity: t.u32(), // people per trip
    status: t.string(), // available | assigned | en_route | on_scene | returning | out_of_service
    lat: t.f64(),
    lon: t.f64(),
    currentRequest: t.u64(), // 0 = none
    freeAtS: t.f64(), // sim second the unit is expected to be free again
    updatedAt: t.timestamp(),
  }
);

// ─── Fire, weather, forecast, roads ─────────────────────────────────────────

/** Singleton (id = 0). `locked` = commander/judge has taken manual control of
 *  the wind (the demo slider); live weather-agent updates are ignored. */
export const weather = table(
  { name: 'weather', public: true },
  {
    id: t.u8().primaryKey(),
    windSpeedMps: t.f64(),
    windFromDeg: t.f64(), // meteorological: direction the wind blows FROM
    gustMps: t.f64(),
    source: t.string(), // nws | manual | scenario
    locked: t.bool(),
    updatedAt: t.timestamp(),
  }
);

/** Cells currently burning (or burnt). */
export const fireCell = table(
  { name: 'fire_cell', public: true },
  {
    cellId: t.u32().primaryKey(),
    ignitedS: t.f64(),
    intensity: t.f32(), // 0..1
    source: t.string(), // firms | perimeter | sim | seed
  }
);

/** Projected fire arrival per unburnt cell, from the forecast agent's
 *  ensemble. p10 = earliest-10% arrival (what we plan against). */
export const forecastCell = table(
  { name: 'forecast_cell', public: true },
  {
    cellId: t.u32().primaryKey(),
    arrivalEarlyS: t.f64(),
    arrivalMedianS: t.f64(),
  }
);

/** Singleton (id = 0) describing the latest forecast + the global
 *  version counters agents use to know whether their inputs are stale. */
export const forecastMeta = table(
  { name: 'forecast_meta', public: true },
  {
    id: t.u8().primaryKey(),
    version: t.u64(),
    computedAtS: t.f64(),
    horizonS: t.f64(),
    members: t.u32(),
    weatherVersion: t.u64(), // world_version.weather this forecast was built from
    fireVersion: t.u64(), // world_version.fire this forecast was built from
    updatedAt: t.timestamp(),
  }
);

/** Singleton (id = 0). Monotonic counters bumped on every write to that
 *  layer. Agents compare these against what their last output was built
 *  from to decide if they are stale — no polling, no guessing. */
export const worldVersion = table(
  { name: 'world_version', public: true },
  {
    id: t.u8().primaryKey(),
    weather: t.u64(),
    fire: t.u64(),
    roads: t.u64(),
    requests: t.u64(),
    forecast: t.u64(),
    danger: t.u64(),
    plan: t.u64(),
  }
);

export const roadClosure = table(
  { name: 'road_closure', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    lat1: t.f64(),
    lon1: t.f64(),
    lat2: t.f64(),
    lon2: t.f64(),
    source: t.string(), // apify | manual | fire
    active: t.bool(),
    updatedAt: t.timestamp(),
  }
);

/** Singleton (id = 0): which real-world incident the demo is replaying and the
 *  news date window for it. start_at is the real time that sim T+0 maps to.
 *  Queries are '|'-separated, places ','-separated. Absent = live mode. */
export const incident = table(
  { name: 'incident', public: true },
  {
    id: t.u8().primaryKey(),
    key: t.string(), // catalog id, e.g. glass-fire-2020
    name: t.string(),
    startAt: t.timestamp(),
    newsFrom: t.timestamp(),
    newsTo: t.timestamp(),
    location: t.string(),
    queries: t.string(),
    places: t.string(),
    updatedAt: t.timestamp(),
  }
);

/** Singleton (id = 0): WHERE the news agent looks, the latest location ping (web app, commander, a script or
 *  another agent, via ping_news). WHEN comes from the incident row: present = its window (a replay, e.g. 2020),
 *  absent = live. With no ping the news agent falls back to the incident's catalog center, then the stations. */
export const newsFocus = table(
  { name: 'news_focus', public: true },
  {
    id: t.u8().primaryKey(),
    lat: t.f64(),
    lon: t.f64(),
    label: t.string(), // place name for the ping, e.g. "Calistoga"; also counts as a place for relevance
    setBy: t.string(), // who pinged, for the audit log
    updatedAt: t.timestamp(),
  }
);

/** The head agent's synthesized view of the incident: one row each time the delegation agent
 *  pools the hazard (fire + weather) and news reports. Typed columns, not text, so the RL policy
 *  can read live state from here and the RL workstream can export the log as training/eval data.
 *  Holds no resident data. Trimmed to the newest SITUATION_KEEP rows. */
export const situation = table(
  { name: 'situation', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    at: t.timestamp(),
    simS: t.f64(),
    incident: t.string(), // incident.key ('' = live mode)
    fireAreaSqKm: t.f64(),
    fireGrowthSqKm: t.f64(), // over the last <= 30 sim-min (0 = not enough history yet)
    fireHeadingDeg: t.f64(), // compass direction the head of the fire is moving toward
    fireHeadKmh: t.f64(),
    windSpeedMps: t.f64(),
    windFromDeg: t.f64(),
    gustMps: t.f64(),
    humidityPct: t.f64(), // -1 = unknown
    redFlag: t.bool(),
    newsOk: t.bool(), // false = the news agent didn't answer; news fields below are neutral
    newsRelevant: t.u32(), // articles scoring >= 0.5 for this incident
    newsEvacuation: t.bool(),
    newsClosures: t.u32(), // relevant articles mentioning road closures
    newsMaxContainmentPct: t.f64(), // -1 = unknown
    newsMaxAcres: t.f64(), // -1 = unknown
    stationsJson: t.string(), // [{"id", "eta_min", "dist_km"}] per station; eta -1 = beyond forecast horizon
    summary: t.string(),
    // Freshness (appended with defaults so the table migrates in place): how old is what the head agent saw?
    windSource: t.string().default(''), // nws | manual | scenario | none
    windObservedAt: t.string().default(''), // ISO-8601 UTC time of the NWS observation (or of the manual/scenario write)
    windAgeMin: t.f64().default(-1), // minutes since that time; -1 = unknown
    forecastAgeSimMin: t.f64().default(-1), // sim-minutes since the forecast was computed; -1 = no forecast yet
    forecastMatchesWind: t.bool().default(true), // false = the forecast predates the latest wind change
    newsLastFetch: t.string().default(''), // ISO-8601 UTC time of the newest stored article scrape
    newsAgeMin: t.f64().default(-1),
    dataFresh: t.bool().default(true), // false = see staleReasons
    staleReasons: t.string().default(''),
  }
);

/** Wildfire posts from trusted X accounts (fire agencies, sheriffs / OES, NWS,
 *  Caltrans, relief orgs), collected by the news agent through Bright Data's
 *  X Posts scraper. Public: they are public posts, and hold no resident data.
 *  Signals are extracted hints for the commander (never auto-applied to roads
 *  or queues). */
export const newsArticle = table(
  { name: 'news_article', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    url: t.string().unique(),
    source: t.string(), // X account, e.g. @CAL_FIRE
    title: t.string(), // first line of the post
    author: t.string(), // account display name
    publishedRaw: t.string(), // as delivered (ISO-8601 for X)
    publishedAt: t.option(t.timestamp()),
    category: t.string(), // account kind: fire | emergency | relief | weather | transport | utility | tracker | other
    tags: t.string(), // hashtags, comma list
    summary: t.string(), // first ~600 chars of the post
    content: t.string(), // post text (plus any quoted post), truncated
    query: t.string(), // how it was found: "profile @handle" or "post url"
    relevance: t.f32(), // 0..1, agent-scored
    locationMatch: t.string(), // incident place names mentioned
    evacuation: t.bool(),
    closures: t.string(), // extracted road-closure sentences, " | "-separated
    containmentPct: t.option(t.f32()),
    acres: t.option(t.f64()),
    fetchedAt: t.timestamp(),
    // Appended last with a default so the table migrates in place: existing rows become '' (live mode).
    incident: t.string().default(''), // incident.key this article was scraped for
    official: t.bool().default(false), // posted by a government agency account
    relief: t.string().default(''), // extracted shelter / relief sentences, " | "-separated
  }
);

// ─── Incident data (PRIVATE) ────────────────────────────────────────────────

export const helpRequest = table(
  { name: 'help_request' },
  {
    id: t.u64().primaryKey().autoInc(),
    resident: t.identity().index('btree'), // submitting identity (resident phone, or the intake agent)
    channel: t.string(), // app | asi1 | sms_sim | synthetic
    externalRef: t.string(), // e.g. "asi1:agent1q..." for ASI:One users
    lat: t.f64(),
    lon: t.f64(),
    locationPurged: t.bool(),
    headcount: t.u32(),
    needs: t.string(), // comma list: mobility,medical,oxygen,infant,pets
    note: t.string(),
    status: t.string(), // pending | queued | assigned | en_route | on_scene | rescued | safe | revoked | expired
    createdAt: t.timestamp(),
    createdSimS: t.f64(),
    consentExpiresAt: t.timestamp(),
    // Danger agent output
    level: t.string(), // unknown | unreachable | critical | high | moderate
    slackS: t.option(t.f64()),
    fireEtaS: t.option(t.f64()), // absolute sim second
    extractS: t.f64(),
    dangerVersion: t.u64(),
    // Delegation / override
    pinnedStationId: t.u32(), // commander override; 0 = not pinned
    hopCount: t.u32(),
    updatedAt: t.timestamp(),
  }
);

/** One row per queued request: which station's queue it is in, and why. */
export const queueEntry = table(
  { name: 'queue_entry' },
  {
    requestId: t.u64().primaryKey(),
    stationId: t.u32().index('btree'),
    rank: t.u32(),
    unitId: t.u32(), // 0 = waiting for a unit
    etaS: t.f64(), // absolute sim second a unit is expected on scene
    reason: t.string(), // operator-facing reason
    residentReason: t.string(), // coarse, resident-facing reason (no formula)
    policy: t.string(),
    planVersion: t.u64(),
    updatedAt: t.timestamp(),
  }
);

/** Danger agent's travel times, request × station. key = requestId * 1024 + stationId */
export const travelEstimate = table(
  { name: 'travel_estimate' },
  {
    key: t.u64().primaryKey(),
    requestId: t.u64().index('btree'),
    stationId: t.u32(),
    travelS: t.f64(),
    reachable: t.bool(),
    dangerVersion: t.u64(),
  }
);

export const flag = table(
  { name: 'flag' },
  {
    id: t.u64().primaryKey().autoInc(),
    requestId: t.u64().index('btree'),
    kind: t.string(), // unreachable | suspect | escalation
    detail: t.string(),
    recommendation: t.string(),
    raisedBy: t.string(),
    resolved: t.bool(),
    resolution: t.string(),
    createdAt: t.timestamp(),
  }
);

/** One-shot timers that enforce consent expiry inside the database. */
export const consentTimer = table(
  { name: 'consent_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    requestId: t.u64(),
  }
);

/** Public activity feed. Never contains location or names; safe to show
 *  on a big screen. Trimmed to the most recent EVENT_LOG_KEEP rows. */
export const eventLog = table(
  { name: 'event_log', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    at: t.timestamp(),
    simS: t.f64(),
    actor: t.string(),
    kind: t.string(),
    message: t.string(),
    requestId: t.u64(),
  }
);

// ─── Reducer argument types ─────────────────────────────────────────────────

export const StationInput = t.object('StationInput', {
  id: t.u32(),
  name: t.string(),
  lat: t.f64(),
  lon: t.f64(),
});

export const UnitInput = t.object('UnitInput', {
  id: t.u32(),
  stationId: t.u32(),
  callsign: t.string(),
  kind: t.string(),
  capacity: t.u32(),
});

export const FireCellInput = t.object('FireCellInput', {
  cellId: t.u32(),
  ignitedS: t.f64(),
  intensity: t.f32(),
});

export const ForecastCellInput = t.object('ForecastCellInput', {
  cellId: t.u32(),
  arrivalEarlyS: t.f64(),
  arrivalMedianS: t.f64(),
});

export const DangerInput = t.object('DangerInput', {
  requestId: t.u64(),
  level: t.string(),
  slackS: t.f64(),
  fireEtaS: t.f64(),
  extractS: t.f64(),
});

export const TravelInput = t.object('TravelInput', {
  requestId: t.u64(),
  stationId: t.u32(),
  travelS: t.f64(),
  reachable: t.bool(),
});

export const PlanEntryInput = t.object('PlanEntryInput', {
  requestId: t.u64(),
  stationId: t.u32(),
  rank: t.u32(),
  unitId: t.u32(),
  etaS: t.f64(),
  reason: t.string(),
  residentReason: t.string(),
});

export const SituationInput = t.object('SituationInput', {
  simS: t.f64(),
  incident: t.string(),
  fireAreaSqKm: t.f64(),
  fireGrowthSqKm: t.f64(),
  fireHeadingDeg: t.f64(),
  fireHeadKmh: t.f64(),
  windSpeedMps: t.f64(),
  windFromDeg: t.f64(),
  gustMps: t.f64(),
  humidityPct: t.f64(),
  redFlag: t.bool(),
  newsOk: t.bool(),
  newsRelevant: t.u32(),
  newsEvacuation: t.bool(),
  newsClosures: t.u32(),
  newsMaxContainmentPct: t.f64(),
  newsMaxAcres: t.f64(),
  stationsJson: t.string(),
  summary: t.string(),
  windSource: t.string(),
  windObservedAt: t.string(),
  windAgeMin: t.f64(),
  forecastAgeSimMin: t.f64(),
  forecastMatchesWind: t.bool(),
  newsLastFetch: t.string(),
  newsAgeMin: t.f64(),
  dataFresh: t.bool(),
  staleReasons: t.string(),
});

export const NewsInput = t.object('NewsInput', {
  url: t.string(),
  incident: t.string(),
  source: t.string(),
  title: t.string(),
  author: t.string(),
  publishedRaw: t.string(),
  publishedMicros: t.i64(), // 0 = unknown
  category: t.string(),
  tags: t.string(),
  summary: t.string(),
  content: t.string(),
  query: t.string(),
  relevance: t.f32(),
  locationMatch: t.string(),
  evacuation: t.bool(),
  closures: t.string(),
  containmentPct: t.f32(), // < 0 = unknown
  acres: t.f64(), // < 0 = unknown
  official: t.bool(),
  relief: t.string(),
});

export const NewsScore = t.object('NewsScore', {
  url: t.string(),
  relevance: t.f32(),
  locationMatch: t.string(),
});

export const UnreachableInput = t.object('UnreachableInput', {
  requestId: t.u64(),
  detail: t.string(),
  recommendation: t.string(),
});

const spacetimedb = schema(
  {
    agent,
    operator,
    simClock,
    simTickTimer,
    grid,
    station,
    unit,
    weather,
    fireCell,
    forecastCell,
    forecastMeta,
    worldVersion,
    roadClosure,
    newsArticle,
    newsFocus,
    incident,
    situation,
    helpRequest,
    queueEntry,
    travelEstimate,
    flag,
    consentTimer,
    eventLog,
  },
  {
    env: {
      // Shared secret Fetch agents present to register_agent.
      AGENT_JOIN_KEY: t.string(),
      // Passcode for commander/responder UI logins (demo-grade auth).
      OPERATOR_PASSCODE: t.string(),
    },
  }
);

export default spacetimedb;
