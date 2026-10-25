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
    legDepartS: t.f64().default(0),
  }
);

/** Units that have a responder phone open right now (the phone heartbeats while it is open). The
 *  simulated-crews driver leaves the "rescued" decision to a crewed unit's phone. Separate from `unit` on
 *  purpose: heartbeats must not touch unit rows, which every risk snapshot is stamped with. */
export const crewPresence = table(
  { name: 'crew_presence', public: true },
  {
    unitId: t.u32().primaryKey(),
    seenAt: t.timestamp(),
  }
);

export const RoadPoint = t.object('RoadPoint', { lon: t.f64(), lat: t.f64(), name: t.string() });
/** A private, shared route: it contains a resident's destination. */
export const unitRoute = table({ name: 'unit_route' }, {
  unitId: t.u32().primaryKey(), requestId: t.u64(), targetLat: t.f64(), targetLon: t.f64(),
  points: t.array(RoadPoint), durationS: t.f64(), departS: t.f64(), arriveS: t.f64(),
  status: t.string(), reason: t.string(), signature: t.string(), updatedAt: t.timestamp(),
  fireVersion: t.u64().default(0n), roadsVersion: t.u64().default(0n),
});

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

/** Supplementary coarse historical risk; never minute-level route ETAs.
 * Public geographic cells contain no resident identifiers or locations.
 * Coordinates use the stated projected CRS, row zero south, column zero west.
 */
export const fireRiskMeta = table({ name: 'fire_risk_meta', public: true }, {
  id: t.u8().primaryKey(),
  schemaVersion: t.string(),
  modelId: t.string(),
  source: t.string(),
  timeBasis: t.string(),
  issueS: t.f64(),
  observationAgeS: t.f64(),
  horizonsS: t.array(t.f64()),
  crs: t.string(),
  westM: t.f64(),
  southM: t.f64(),
  cellSizeM: t.f64(),
  rows: t.u32(),
  cols: t.u32(),
  qualityFlags: t.array(t.string()),
  weatherVersion: t.u64(),
  fireVersion: t.u64(),
  updatedAt: t.timestamp(),
  // Appended fields preserve migration from the original geographic risk tables.
  forecastId: t.string().default(''),
  observationId: t.string().default(''),
  scenario: t.string().default(''),
  sourceIssueUtcS: t.f64().default(0),
});

export const fireRiskCell = table({ name: 'fire_risk_cell', public: true }, {
  key: t.string().primaryKey(),
  cellId: t.u32(),
  horizonS: t.f64(),
  probability: t.f64(),
  observed: t.bool(),
});

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
    // Field reports from residents (intake agent), as weighed by the commander. Counts only, no resident data.
    reportsActive: t.u32().default(0), // active requests with an intake assessment
    reportsFireCredible: t.u32().default(0), // fire sightings credible enough to change the fire ETA
    reportsRoadBlocks: t.u32().default(0), // credible blocked-road reports (became road closures)
    reportsTrapped: t.u32().default(0), // requests reporting people trapped
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
    entrance: t.string().default(''),
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

/** The conversation between a request's responders and the resident: a responder asks ("is the road
 *  really blocked?", "can you send a photo?"), the resident answers. Human to human; agents only carry it
 *  (the intake agent relays it to ASI:One residents). A resident's answer is also stored as a text field
 *  report, so the assessment is re-read with it. Deleted with the request. */
export const requestMessage = table(
  { name: 'request_message' },
  {
    id: t.u64().primaryKey().autoInc(),
    requestId: t.u64().index('btree'),
    from: t.string(), // responder | commander | resident
    author: t.string(), // display name for the console ('' for the resident)
    text: t.string(),
    createdAt: t.timestamp(),
  }
);

/** What a resident sent after pinging for help: text, a voice transcript, a photo, or a video (its URL plus
 *  still frames the frontend sampled from it). Media live in object storage; only URLs are stored here.
 *  Raw input for the intake agent and the firefighter console; it never reaches the queue directly. */
export const fieldReport = table(
  { name: 'field_report' },
  {
    id: t.u64().primaryKey().autoInc(),
    requestId: t.u64().index('btree'),
    kind: t.string(), // text | voice | image | video
    text: t.string(), // the message, or the voice transcript
    mediaUrl: t.string(), // image / video / audio URL ('' = none), for the console to render
    frameUrls: t.string(), // video only: newline-separated still frames, what the analysis looks at
    createdAt: t.timestamp(),
  }
);

/** The intake agent's reading of everything a request sent (one row per request, replaced on every new
 *  report). Claims, not facts: the commander weighs them (credibility, corroboration, the hazard data at the
 *  resident's location) before any of it touches danger or queues. Responders see it next to the raw reports. */
export const reportAssessment = table(
  { name: 'report_assessment' },
  {
    requestId: t.u64().primaryKey(),
    reportCount: t.u32(),
    people: t.u32(), // 0 = not stated
    needs: t.string(), // comma list, same vocabulary as help_request.needs
    injured: t.bool(),
    trapped: t.bool(),
    fireSeen: t.bool(),
    fireDistanceM: t.f64(), // < 0 = unknown
    smoke: t.bool(),
    roadBlocked: t.bool(),
    roadNote: t.string(),
    mediaSupports: t.bool(), // the photos / frames themselves show the fire or blocked road
    confidence: t.f32(), // analyzer's confidence the claims are genuine and consistent, 0..1
    urgency: t.f32(), // analyzer's read of how urgent this is, 0..1
    summary: t.string(), // one line for the firefighter console
    residentReply: t.string(), // what the resident is told back
    analyzer: t.string(), // model id, or 'keywords' / 'form'
    updatedAt: t.timestamp(),
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

export const FireRiskCellInput = t.object('FireRiskCellInput', {
  cellId: t.u32(), horizonS: t.f64(), probability: t.f64(), observed: t.bool(),
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
  reportsActive: t.u32(),
  reportsFireCredible: t.u32(),
  reportsRoadBlocks: t.u32(),
  reportsTrapped: t.u32(),
});

export const AssessmentInput = t.object('AssessmentInput', {
  requestId: t.u64(),
  reportCount: t.u32(),
  people: t.u32(),
  needs: t.string(),
  injured: t.bool(),
  trapped: t.bool(),
  fireSeen: t.bool(),
  fireDistanceM: t.f64(),
  smoke: t.bool(),
  roadBlocked: t.bool(),
  roadNote: t.string(),
  mediaSupports: t.bool(),
  confidence: t.f32(),
  urgency: t.f32(),
  summary: t.string(),
  residentReply: t.string(),
  analyzer: t.string(),
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

/** One simulated resident's ping (submit_mock_requests). `report` = an optional first text report. */
export const MockRequestInput = t.object('MockRequestInput', {
  lat: t.f64(),
  lon: t.f64(),
  headcount: t.u32(),
  needs: t.string(),
  note: t.string(),
  report: t.string(),
});

/** Public pipeline health carries no resident data. */
export const riskPipeline = table({ name: 'risk_pipeline', public: true }, {
  id: t.u8().primaryKey(), scenario: t.string(), sourceId: t.string(),
  status: t.string(), activeBackend: t.string(), reason: t.string(),
  forecastId: t.string(), updatedAt: t.timestamp(),
});

export const RiskSnapshotInput = t.object('RiskSnapshotInput', {
  scenario: t.string(), assessedAtS: t.f64(), unitsStamp: t.string(),
  weatherVersion: t.u64(), fireVersion: t.u64(), roadsVersion: t.u64(),
  requestsVersion: t.u64(), forecastVersion: t.u64(), riskUpdatedAt: t.u64(), pipelineUpdatedAt: t.u64(),
});

const riskValues = {
  // The finite legacy slack slot is unused when no route exists. The request view exposes null slack;
  // risk consumers must check reachable/travelS before displaying an assistance estimate.
  assessmentId: t.string(), schemaVersion: t.string(),
  level: t.string(), slackS: t.f64(), fireEtaS: t.f64(), extractS: t.f64(),
  stationId: t.u32(), travelS: t.option(t.f64()), waitS: t.option(t.f64()),
  scheduledSlackS: t.option(t.f64()), reachable: t.bool(),
  headcount: t.u32(), needs: t.string(), credibility: t.f64(),
  reportedUrgency: t.f64(), trapped: t.bool(), injured: t.bool(), reportNote: t.string(),
  forecastId: t.string(), modelId: t.string(), forecastState: t.string(),
  horizonsS: t.array(t.f64()), probabilities: t.array(t.f64()),
  arrivalLowerS: t.option(t.f64()), arrivalUpperS: t.option(t.f64()),
  exposureSlackLowerS: t.option(t.f64()), exposureSlackUpperS: t.option(t.f64()),
  qualityFlags: t.array(t.string()), reason: t.string(),
};
export const RequestRiskInput = t.object('RequestRiskInput', {
  requestId: t.u64(), ...riskValues, forecastIssueS: t.f64(),
});

/** Private per-resident prediction + assistance analysis, atomically published with danger/travel. */
export const requestRisk = table({ name: 'request_risk' }, {
  requestId: t.u64().primaryKey(), ...riskValues,
  scenario: t.string(), assessedAtS: t.f64(), unitsStamp: t.string(),
  weatherVersion: t.u64(), fireVersion: t.u64(), roadsVersion: t.u64(),
  requestsVersion: t.u64(), forecastVersion: t.u64(), riskUpdatedAt: t.u64(), pipelineUpdatedAt: t.u64(),
  dangerVersion: t.u64(), updatedAt: t.timestamp(),
  forecastIssueS: t.f64().default(0),
});

const replayObservation = table({ name: 'replay_observation', public: true }, {
  sequence: t.u32().primaryKey(), atS: t.f64(),
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
    crewPresence,
    unitRoute,
    weather,
    fireCell,
    forecastCell,
    forecastMeta,
    fireRiskMeta,
    fireRiskCell,
    riskPipeline,
    requestRisk,
    worldVersion,
    roadClosure,
    newsArticle,
    newsFocus,
    incident,
    replayObservation,
    situation,
    helpRequest,
    queueEntry,
    travelEstimate,
    flag,
    consentTimer,
    fieldReport,
    requestMessage,
    reportAssessment,
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
