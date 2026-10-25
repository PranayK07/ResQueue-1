# Frontend contract

What a web or mobile client talks to. There is no other backend: the frontend connects to SpacetimeDB, calls
**reducers** to write, and subscribes to **tables / views** to read. The agents react to the same rows.

```bash
# TypeScript bindings (typed reducers + tables) into your web app
spacetime generate --lang typescript --out-dir <web>/src/module_bindings --module-path spacetimedb
```

Connect to `wss://maincloud.spacetimedb.com` (or `ws://127.0.0.1:3000`) with database `STDB_DB`. Each browser or phone
gets its own identity (SpacetimeDB issues a token; keep it in storage). `ctx.sender` is who the module sees.

## Resident (the help button)

| Step | Call |
|---|---|
| Ping, with consent and location | reducer `submit_help_request(lat, lon, headcount, needs, note, consentMinutes)`. `needs` is a comma list from `mobility, medical, oxygen, infant, elderly, pets, language`. `consentMinutes` is clamped to 15..1440 (24 h). One open request per identity |
| Add what they see | reducer `submit_report(requestId, externalRef = "", kind, text, mediaUrl, frameUrls)` (`frameUrls` is a newline-separated string) |
| Answer a responder | reducer `reply_to_responder(requestId, externalRef = "", text)` |
| Keep sharing longer | reducer `extend_consent(requestId, externalRef = "", minutes)` |
| Moved, or corrected the pin | reducer `update_my_location(requestId, externalRef = "", lat, lon)`. Same request and queue place; must stay inside the incident area; danger and travel are recomputed |
| "I'm safe" / stop sharing | reducer `close_my_request(requestId, externalRef = "", outcome = "safe" or "revoked")`. Deletes location, reports and messages at once |
| Show their card | subscribe `my_requests` (status, danger level, queue position, station, unit, ETA, reason, and `intakeReply`: what the intake agent says back) |
| Show the conversation | subscribe `ops_message` (only their own request's messages) |

`submit_report` kinds:

| kind | text | mediaUrl | frameUrls |
|---|---|---|---|
| `text` | the message | | |
| `voice` | the transcript (transcribe on the device) | | |
| `image` | optional caption | https URL of the photo | |
| `video` | optional caption | https URL of the video (for the console to play) | up to 8 https URLs of still frames, joined with newline characters (what the vision model reads) |

Media are uploaded by the client to your object storage first; the database only stores `https://` URLs (max 1000
chars). A new ping is held out of the queue for up to `INTAKE_GRACE_S` (20 s) while the intake agent reads it, so show
"assessing" until `my_requests` gets a queue position.

## Responder (station console) and commander

Sign in once with `claim_operator(passcode, role = "responder" or "commander", stationId, name)`. The `operator` table is
private; subscribe to the `my_operator` view to know who this identity is signed in as (it empties when a scenario reload
deletes responder operators, so sign in again then). Then subscribe:

| Subscribe | What it holds |
|---|---|
| `ops_queue`, `ops_request` | the requests in their station's queue (commander: all), with level, slack, fire ETA, status |
| `ops_assessment` | what the intake agent read for each request: people, needs, injured, trapped, fire seen and distance, road blocked, `mediaSupports`, confidence, urgency, a one-line summary, and which model read it (`analyzer`) |
| `ops_report` | the raw reports (text, transcripts, media URLs, video frames), always available unfiltered next to the assessment |
| `ops_message` | the responder / resident conversation per request |
| `ops_travel` (commander) | travel seconds, request by station |

Actions:

| Action | Call |
|---|---|
| Ask the resident | reducer `message_resident(requestId, text)` |
| Unit lifecycle | reducers `unit_en_route`, `unit_position`, `unit_on_scene`, `complete_mission`, `unit_available`, `decline_mission` |
| Responder phone open | reducer `crew_heartbeat(unitId, active)` every ~20 s while the phone shows that unit (`active = false` when it leaves). Fills the public `crew_presence` table; the simulated-crews driver then leaves "rescued" to the phone |
| Commander only | `override_assignment(requestId, stationId, note)` (pin; the policy must obey), `flag_request` (a manual escalation flag), `resolve_flag`, `set_sim(running, speed)`, `set_weather`, `release_weather_lock`, `set_incident`, `ping_news`, `submit_mock_requests(pings)` (below) |

### Mock help pings (demos and drills)

`submit_mock_requests(pings)` (commander operator, or the commander / scenario agent) files 1..25 simulated residents' pings
in one transaction. Each `MockRequestInput` is `{lat, lon, headcount, needs, note, report}`: the same validation as a real
ping (inside the incident area, headcount 1..50, note <= 500 chars), channel `synthetic`, its own externalRef
(`mock:<batch>:<i>`), consent 24 h, and an optional first text `report` (<= 4000 chars) that the intake agent reads. They
never appear in anyone's `my_requests`. One transaction means one planner pause instead of one per ping.

### Unit missions

Nothing in the backend moves units on its own. `publish_plan` sets a unit `assigned`; the lifecycle reducers take it
`en_route` → `on_scene` → `returning` (via `complete_mission`) → `available`. For scenarios and replays (synthetic units),
`agents/scripts/sim_crews.py` drives every unit through those steps (`run_all` starts it unless `SIM_CREWS=0`); a responder
phone that has a unit open makes the "rescued" / "can't reach" call for it. **Never stream `unit_position`:** every risk
card is stamped with all units' `updated_at`, and the planner keeps the old plan until risk is republished (at most every
5 s), so frequent unit writes stall planning. Write units only at lifecycle steps and animate positions in the client.

## Everyone (public tables, no personal data)

`sim_clock`, `grid`, `station`, `unit`, `weather`, `fire_cell`, `forecast_cell` (fire arrival times, for the map),
`road_closure`, `situation` (the commander's pooled picture and the log the RL model reads), `news_article`,
`event_log`, `agent` (who is online), `crew_presence` (which units have a responder phone open), `incident` (the
replayed fire and its time window; absent = live mode).

## Rules the frontend can rely on

- The agents never show a resident another resident's data, and a station sees only its own queue.
- There is no review queue: responders see every resident's raw reports (text, transcripts, photos, video) next to the
  agent's assessment, unfiltered, and decide for themselves.
- Words alone never move the automatic queue order unless two neighbours report the same thing. Claims backed by photos
  or video can, when they fit the fire and weather at the resident's location.
- Requests expire after the consent window (default 24 h) and their location, reports and messages are deleted then.

## Integrated resident risk

Subscribe to `my_risk` as a resident or `ops_risk` as a commander/responder/intake agent. Cards have
`assessment`, `current`, and `stale_reason`. The full field contract and example are in
[RECORDED_RISK_PIPELINE.md](RECORDED_RISK_PIPELINE.md). Always display freshness alongside predictions;
`current=false`, missing exposure or right-censored timing must not be presented as low risk.

`assessment.quality_flags` (list of strings) and `assessment.reason` also carry hints from the other agents. They never
change the numbers, so show them as notices next to the risk card:
- `news: evacuation reported for the incident area (unverified hint)` and `news: N road-closure post(s) reported; ...`
  come from the news agent's X posts. They are incident-wide, not per address.
- `resident fire sighting not reflected by learned exposure ...` or `... while learned exposure is <state>; the sighting
  is trusted` means a credible resident report (intake agent) disagrees with, or has no support from, the learned model.
  The sooner physical ETA is used. Responders should review.
The text is for display only. Do not parse it for logic; use the typed fields.

Public `fire_risk_meta` / `fire_risk_cell` provide geographic probability maps. `risk_pipeline` reports
activation/failure and the forecast ID. No personal information is stored in those public layers.
Risk writes are commander-only; frontend writes still use the existing request/report/override reducers.
Regenerate TypeScript bindings after publishing the extended module.
