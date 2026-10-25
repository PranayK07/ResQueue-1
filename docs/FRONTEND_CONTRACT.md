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
| Add what they see | reducer `submit_report(requestId, externalRef = "", kind, text, mediaUrl, frameUrls)` |
| Answer a responder | reducer `reply_to_responder(requestId, externalRef = "", text)` |
| Keep sharing longer | reducer `extend_consent(requestId, externalRef = "", minutes)` |
| "I'm safe" / stop sharing | reducer `close_my_request(requestId, externalRef = "", outcome = "safe" or "revoked")`. Deletes location, reports and messages at once |
| Show their card | subscribe `my_requests` (status, danger level, queue position, station, unit, ETA, reason, and `intakeReply`: what the intake agent says back) |
| Show the conversation | subscribe `ops_message` (only their own request's messages) |

`submit_report` kinds:

| kind | text | mediaUrl | frameUrls |
|---|---|---|---|
| `text` | the message | | |
| `voice` | the transcript (transcribe on the device) | | |
| `image` | optional caption | https URL of the photo | |
| `video` | optional caption | https URL of the video (for the console to play) | up to 8 https URLs of still frames sampled from it (what the vision model reads) |

Media are uploaded by the client to your object storage first; the database only stores `https://` URLs (max 1000
chars). A new ping is held out of the queue for up to `INTAKE_GRACE_S` (20 s) while the intake agent reads it, so show
"assessing" until `my_requests` gets a queue position.

## Responder (station console) and commander

Sign in once with `claim_operator(passcode, role = "responder" or "commander", stationId, name)`. Then subscribe:

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
| Commander only | `override_assignment(requestId, stationId, note)` (pin; the policy must obey), `flag_request` (a manual escalation flag), `resolve_flag`, `set_sim`, `set_weather`, `set_incident`, `ping_news` |

## Everyone (public tables, no personal data)

`sim_clock`, `grid`, `station`, `unit`, `weather`, `fire_cell`, `forecast_cell` (fire arrival times, for the map),
`road_closure`, `situation` (the commander's pooled picture and the log the RL model reads), `news_article`,
`event_log`, `agent` (who is online).

## Rules the frontend can rely on

- The agents never show a resident another resident's data, and a station sees only its own queue.
- There is no review queue: responders see every resident's raw reports (text, transcripts, photos, video) next to the
  agent's assessment, unfiltered, and decide for themselves.
- Words alone never move the automatic queue order unless two neighbours report the same thing. Claims backed by photos
  or video can, when they fit the fire and weather at the resident's location.
- Requests expire after the consent window (default 24 h) and their location, reports and messages are deleted then.
