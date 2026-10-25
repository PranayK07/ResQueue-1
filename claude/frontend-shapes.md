# Frontend shared shapes (v1.1, fresh-review gaps folded in)

Source: spacetimedb/src/schema.ts + index.ts (commit Oct 24, 12:04 PT). Field names as in the module.
Folders are placeholders; rename to fit the stack in the frontend spec.

## Time and units (read first)
- Absolute sim seconds since scenario start: simS, ignitedS, arrivalEarlyS, arrivalMedianS, computedAtS, createdSimS, fireEtaS, etaS, arriveAtS, freeAtS, event_log.simS. Now = `sim_clock.simS`. Minutes from now = (x - simS) / 60.
- Durations in seconds: slackS, extractS, travelS, horizonS, medianSlackS.
- slackS = fire arrival (p10) - (now + wait + travel + extract) - safety margin. Below 0 means the crew can't beat the fire.
- `*At` fields plus lastTick, lastSeen, joinedAt are real wall-clock SpacetimeDB Timestamps (microsSinceUnixEpoch). consentMinutes are real minutes. Consent countdown = consentExpiresAt - wall-clock now.
- Lat/lon in degrees. Wind in m/s; windFromDeg 0-360, the direction the wind blows FROM.

## Who builds what (one folder each)

| # | Component | Owner | Folder | Reads | Calls |
|---|---|---|---|---|---|
| 0 | Shared shell (first; typed stubs within 5 min) | Evan | web/lib/ | connection, identity token, bindings | claim_operator |
| 1 | Resident app /help | lane | web/help/ | my_requests, grid, sim_clock | submit_help_request, close_my_request, extend_consent, POST /api/intake |
| 2 | Commander map /command | lane | web/command/ | all public tables, ops_request, ops_queue, ops_travel, ops_flag | set_weather, release_weather_lock, set_sim, add_road_closure, set_road_closure_active, override_assignment, flag_request, resolve_flag |
| 3 | Crew view /crew | lane | web/crew/ | unit, station, ops_request, ops_queue, sim_clock | unit_en_route, unit_on_scene, complete_mission, unit_available, decline_mission |
| 4 | Claude intake /api/intake | lane | web/api/intake/ | none | Claude API |
| 5 | Scoreboard panel | lane | web/score/ | web/public/scoreboard.json (Pranay writes it) | none |

## Shell contract (component 0 provides, everyone imports)
- One SpacetimeDB connection. Generated bindings live in web/module_bindings/. Never hand-edit them. Whoever changes spacetimedb/src reruns the generate command (CLAUDE.md) and commits the bindings in the same push.
- Identity token saved in localStorage, so a reload keeps the same identity (my_requests and operator rights are keyed by it).
- `useTable(name)` and `useView(name)` return live row arrays.
- `call(name, args)`: name is the reducer name exactly as written here (snake_case). args is one object with the field names listed here, e.g. `call('submit_help_request', { lat, lon, headcount, needs, note, consentMinutes })`. Returns a Promise that rejects with the server's error message. The shell maps this to the SDK.
- `login(passcode, role: 'commander' | 'responder', stationId, name)` wraps claim_operator. Commander uses stationId 0. The operator table is private, so the shell also saves `{ role, stationId, name, unitId }` in localStorage to pick the right screen after a reload. The DB row persists for the identity, so views keep working.
- Geo helpers: `cellCenter(cellId, grid)`, `cellPolygon(cellId, grid)`, `insideGrid(lat, lon, grid)`. cellId = row * cols + col. Row 0 is the south edge, origin is the SW corner, cells are cellSizeM metres. 1 deg lat = 111,320 m; 1 deg lon = 111,320 * cos(originLat) m. Incident area = the grid rectangle.
- `minsFromNow(s, simS)` for ETAs and fire arrival.

## Public tables (anyone can subscribe)
- sim_clock {id, simS, speed, running, scenario, lastTick}
- grid {id, originLat, originLon, cellSizeM, rows, cols}
- station {id, name, lat, lon}
- unit {id, stationId, callsign, kind, capacity, status: available|assigned|en_route|on_scene|returning|out_of_service, lat, lon, currentRequest (0 = none), freeAtS, updatedAt}
- weather {id, windSpeedMps, windFromDeg, gustMps, source: nws|manual|scenario, locked, updatedAt}
- fire_cell {cellId, ignitedS, intensity 0..1, source}
- forecast_cell {cellId, arrivalEarlyS (p10: earliest 10% of the 16 forecast runs, plan against this), arrivalMedianS (p50)}
- forecast_meta {id, version, computedAtS, horizonS, members, weatherVersion, fireVersion, updatedAt}
- road_closure {id, name, lat1, lon1, lat2, lon2, source: apify|manual|fire, active, updatedAt}. A straight segment from point 1 to point 2. It blocks every grid cell it crosses. Not snapped to roads.
- event_log {id, at, simS, actor, kind, message, requestId (0 = none)}. Newest 400 kept. No names or locations.
- agent {identity, role, name, stationId, fetchAddress, status, detail, lastSeen}
- world_version {id, weather, fire, roads, requests, forecast, danger, plan}

Show these as plain text and never branch on them: event_log.kind, fire_cell.source, unit.kind, queue_entry.policy, flag.recommendation, flag.resolution.

## Role-scoped views (rows depend on who is signed in)
- my_requests (resident, own app requests only) -> ResidentCard {requestId, status, level, queuePosition (0 = not waiting), stationName, unitCallsign, etaS?, reason, headcount, needs, consentExpiresAt, createdAt}
- ops_request (commander: all; responder: own station's queue) -> help_request {id, resident, channel: app|asi1|sms_sim|synthetic, externalRef, lat, lon, locationPurged, headcount, needs, note, status, createdAt, createdSimS, consentExpiresAt, level, slackS?, fireEtaS?, extractS, dangerVersion, pinnedStationId (0 = none), hopCount, updatedAt}. If locationPurged is true, lat/lon are 0: don't plot.
- ops_queue (commander: all; responder: own station) -> queue_entry {requestId, stationId, rank, unitId (0 = waiting), etaS, reason (operator-facing), residentReason, policy, planVersion, updatedAt}
- ops_travel (commander only) -> travel_estimate {key, requestId, stationId, travelS, reachable, dangerVersion}
- ops_flag (commander only) -> flag {id, requestId, kind: unreachable|suspect|escalation, detail, recommendation, raisedBy, resolved, resolution, createdAt}

Enums
- request status: pending|queued|assigned|en_route|on_scene (these 5 are active) | rescued|not_found|safe|revoked|expired (closed)
- level: unknown|unreachable|critical|high|moderate
- needs: comma list of mobility,medical,oxygen,infant,elderly,pets,language. Anything else is dropped.

## Reducers the UI calls (errors come back as a message string)

Resident
- submit_help_request(lat, lon, headcount 1..50 (default 1), needs, note max 500 chars, consentMinutes 15..240 (default 60)). Rejected if outside the grid or if you already have an active request.
- close_my_request(requestId, externalRef = "", outcome: safe|revoked). Both close the request, free the crew and delete the location. Revoked cancels the rescue.
- extend_consent(requestId, externalRef = "", minutes 15..240, default 60). Sets expiry to now + minutes (resets, does not add).

Commander (after claim_operator with role commander)
- set_weather(windSpeedMps 0 to under 80, windFromDeg, gustMps, source = "manual"). Locks the wind until release_weather_lock().
- set_sim(running, speed above 0 up to 600)
- add_road_closure(name, lat1, lon1, lat2, lon2, source = "manual"); set_road_closure_active(id, active)
- override_assignment(requestId, stationId, note). stationId 0 unpins.
- flag_request(requestId, kind, detail); resolve_flag(flagId, resolution). Free text.

Crew (after claim_operator with role responder and a stationId)
- After login the responder picks one unit of their station (unit rows where stationId matches). The shell saves unitId.
- unit_en_route(unitId, arriveAtS, freeAtS). Only when unit.status = assigned. arriveAtS = that request's queue_entry.etaS. freeAtS (proposed) = arriveAtS + extractS + (arriveAtS - simS), meaning load time plus a return trip as long as the trip out.
- unit_on_scene(unitId) when en route.
- complete_mission(unitId, outcome: rescued|not_found|aborted). rescued and not_found close the request. aborted puts it back in the queue. The unit becomes returning.
- unit_available(unitId, lat, lon) once currentRequest is 0. Send the station's lat/lon.
- decline_mission(unitId, reason): unit goes available, request goes back to queued.
- Units move on the map because station agents simulate them. /crew never sends real GPS (the venue is outside the grid). "Where to go" = the request's lat/lon from ops_request plus an Open in Maps link.

## New shapes (not in the database)

POST /api/intake
- in: { note: string, headcount?: number }
- out: { headcount: number, needs: string, note: string, language: string, summary: string, source: "claude" | "fallback" }
- language is an ISO 639-1 code ("en", "es", "zh"), "unknown" on fallback. summary is one English line for crews. note is the original text, not translated.
- Must answer within 3 s. On timeout or error: source "fallback", headcount = the form value or 1, needs "", language "unknown", summary "", raw note.
- The DB has no language or summary column. Before submitting, /help adds "language" to needs when language is not "en" or "unknown", and sends note = summary + " | " + original, cut to 500 chars.
- No reducer edits a request after submit. So /help runs intake while the person types (debounced) and the button submits right away with whatever has been parsed by then. The button never waits.

web/public/scoreboard.json (Pranay's eval script writes it)
- { generatedAt: ISO string, fires: 200, totalRequests: number, policies: [{ name: "lookahead" | "first_come" | "nearest", rescuedBeforeFire: number, missed: number, medianSlackS: number }] }
- Counts are totals across all fires. missed = totalRequests - rescuedBeforeFire. medianSlackS = median of (fire arrival - crew arrival) in seconds; positive means the crew got there first.

## Needs a team decision (not blocking v1 lanes)
1. Sathvik: /crew and the station agents could both drive the same unit. Decide which unit the station agent leaves alone for the live /crew demo.
2. Sathvik: confirm station agents use the same freeAtS math as above.
3. Pranay: confirm the scoreboard.json format and when the first real file lands.
4. Optional contract adds after 7 PM: update_my_request (intake fills fields after the button), a language column on help_request (reasons in the resident's language, a Should).
