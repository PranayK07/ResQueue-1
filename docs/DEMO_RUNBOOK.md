# Demo runbook: recorded Arizona wildfire replay

The demo replays a real 2020 wildfire through a trained time-conditioned U-Net. LOOKAHEAD dispatch prioritizes assistance using location-dependent slack, travel and extraction estimates.

## What is real

- NIROPS aerial infrared perimeters near 35.65°N, 112.73°W, sequence `2bdb2cbdb71e878fee72eef8`. The bundle does not identify the fire's name.
- Seven acquisitions, Jul 8 01:10 UTC to Jul 14 02:20 UTC 2020. Burned areas: 1.57 → 3.50 → 4.32 → 4.32 → 6.39 → 6.39 → 6.39 km². The source grid is 128 × 128 at 60 m in UTM zone 12N.
- A trained U-Net predicts exposure at 6, 12 and 24 hours from each acquired observation. Later recorded perimeters are unavailable to inference until their replay time.
- Two stations, four units and three resident fixtures are synthetic. The original bundle contains 24 residents; `DEMO_PROFILE=hackathon` selects three new positions using actual inference and slack calculations. No fixture stores a preset risk level.
- If asked about scores: Brier 0.0121 vs 0.0134 for persistence on the reused test panel, described by the benchmark as “diagnostic, not pristine unseen evidence.”

Pitch: “We replay a real 2020 Arizona wildfire from aerial infrared perimeters. A learned forecast model predicts where it spreads. Synthetic residents and stations let us test the rescue queue on real fire behavior.”

## Configuration

Use the Python forecast environment described in [RECORDED_RISK_PIPELINE.md](RECORDED_RISK_PIPELINE.md), containing torch, rasterio and affine. The bundle `runs/recorded-integration/` must contain `incident.json`, `observations.npz`, `model.pt` and `model_metadata.json`; it is gitignored.

Keep existing credentials in the root `.env` and configure:

```dotenv
STDB_SERVER=local
STDB_DB=wildfire-rescue-arizona-demo
PYTHON=.venv-risk/bin/python
FIRE_SOURCE=recorded
RECORDED_INCIDENT_PATH=runs/recorded-integration/incident.json
FIRE_FORECAST_BACKEND=learned
FIRE_FORECAST_CHECKPOINT=runs/recorded-integration/model.pt
FIRE_FORECAST_METADATA=runs/recorded-integration/model_metadata.json
FIRE_FORECAST_HORIZONS_S=21600,43200,86400
POLICY=lookahead
WEATHER_SOURCE=scenario
NEWS_SOURCE=off
INTAKE_ANALYZER=keywords
MAILBOX_AGENTS=none
DEMO_PROFILE=hackathon
SIM_CREWS=1
SIM_SPEED=60
```

`PYTHON` may also be an absolute path. In `web/.env.local`:

```dotenv
VITE_DATA_SOURCE=live
VITE_DEMO_MODE=true
```

Callers always start within the loaded incident area without requesting device GPS, including when the demo flag is false. The caller sees a normal location preview without fire layers. Moving a pin or choosing an address outside the incident area shows a warning and prevents confirming/sending that location, with a button to return to the incident. `VITE_DEMO_MODE=true` also hides the responder phone's GPS option; set it to false when you want to offer responder GPS.

## Start

```bash
# Terminal 1: publish, replace the selected database scenario, seed three calls, start agents
scripts/dev.sh

# Terminal 2
cd web && npm install && npm run dev
```

The hackathon profile starts paused at the first observation, even when the seeder receives `--run`. Allow roughly 30 seconds for learned forecasts, assessments and queues. The initial calls should be wheelchair assistance near fire (high), no listed needs nearby (moderate), and no listed needs farther away (low). These are computed results for T+0; they change with position, needs, resources and the acquired fire.

| Screen | URL | Sign-in |
|---|---|---|
| Commander | `http://localhost:5173/#/command` | Any display name and `OPERATOR_PASSCODE` |
| Caller | `http://localhost:5173/#/` | None |
| Responder | `http://localhost:5173/#/responder/4` | Display name and `OPERATOR_PASSCODE` |

The operator name is a display label attached to actions in the audit log. Use separate tabs for roles; each tab has its own stored identity. Existing browser tabs must reload after changing Vite environment variables.

## Demonstration

1. In command, show the three fixture calls and their slack ordering. Select a call to see learned exposure probabilities and the assistance timing calculation.
2. The satellite map renders the recorded fire in red. Orange/yellow cells are actual U-Net probabilities, with the selected 6/12/24-hour horizon and a 10% display threshold. Red-to-yellow is exposure, not a predicted minute of arrival. Narrow bands are valid model output; the UI never expands them with a visual buffer. There are no replay wind controls: this checkpoint has no wind input.
3. Open the caller in another tab. Send an alert. Command immediately shows the new call, including before the agents assign its queue. “Show request and pin” selects it. Assign an available ground unit from Request details, or allow LOOKAHEAD to assign one.
4. Open the assigned unit's responder URL. Its destination pin, route, entrance and risk assessment come from the shared database. “Start response” and “Mark on scene” update the caller's receipt. “Mark complete” closes it and purges shared coordinates.
5. On the caller page, use “My location has changed” and click a new map position. The confirmed update changes the command/responder destination; the pipeline recalculates exposure and slack. A location farther from the fire normally has lower exposure, but the actual priority also depends on travel, extraction and unit availability.
6. “Next observation” pauses at the next recorded acquisition and runs inference from that newly available perimeter. The observed time, footprint and forecast ID update. Resume/speed controls remain available for continuous replay.

## Interpretation and troubleshooting

- U-Net probabilities describe exposure at hour-scale horizons. The existing physical ensemble and grid router supply short-horizon fire/travel estimates used in slack. LOOKAHEAD consumes the complete assessment; no RL dispatch checkpoint is involved. Do not describe approximate slack as measured historical rescue timing.
- Road directions use OSRM when available. They are ordinary road directions; no fire-safe road-routing guarantee is made. A timed-out road request shows an explicit direct-route fallback.
- `SIM_CREWS=1` executes missions automatically: travel, extraction, then a feasible unserved caller or a return to station. Use `SIM_CREWS=0` for manual crew control. The standalone crew driver accepts `--manual-phones` to let an open responder phone control completion. Truck markers and their labels follow the replay clock; pausing the replay pauses movement.
- A pending/error forecast shows its pipeline state and does not paint a fallback as learned exposure. Check bundle/checkpoint paths and `FIRE_FORECAST_BACKEND=learned`.
- “Reassessing location risk” means an input version changed; the previous card is marked stale until the commander publishes a matching assessment.
- A destination outside the red perimeter may still fail the routing model's five-minute fire-clearance requirement. This does not establish a road closure: the safety router uses a grid approximation. The separate physical forecast is valid for three hours from its acquired perimeter. After that, assessments are marked “Reassessing” with an explicit expired-routing explanation until a fresh observation/forecast is available; old deadlines are not treated as current route blocks. Agent restarts preserve the historical acquisition time.
- Running `scripts/dev.sh` again replaces the selected scenario and restores the three-call, paused opening. `scripts/dev.sh db` only republishes code. Use `reset` only when you intend to delete that selected database's data.

The satellite basemap and OSRM require network access. The fire/model pipeline runs locally from the recorded bundle.

If SpacetimeDB repeatedly logs `not a registered agent` or `requires agent role`, verify the database target first: the sprite preview on 5173 uses the local `wildfire-arizona-a66a` database, while the separate Maincloud stack uses its own database. The Python client now restores a previously successful registration after reconnecting or after a reducer detects a lost role. It retries once with the same role and join key; invalid credentials and real permission failures still surface. Restart agents after updating their Python code, without running the seeder or deleting incident data. Older log entries remain visible after recovery.

## Recorded demo with road routes and sprites

Run `scripts/demo.sh` to prepare the three synthetic callers on connected roads, with their risk calculated from the acquired fire observation, forecast, travel, and assistance needs. The replay starts paused so the queue remains ready for a fourth caller. `scripts/demo.sh run` resumes the agents without reseeding the incident. In another terminal, run `npm --prefix web run dev -- --host 127.0.0.1 --port 5173 --strictPort`; caller, command, and responder views share that URL. The demo script writes the matching local database target into `web/.env.local`.

Risk bands are critical below 10 minutes of slack, high below 30, moderate below 60, and low above that. A negative rescue margin is critical; observed fire and unavailable ground routes are reported separately. No fixture inserts a fixed risk label. For road graph and sprite details, see `docs/DEMO_QA.md` and `web/src/assets/firetruck-pixel.README.md`.

The hosted website also needs continuously running calculation and routing workers; Fetch.ai registration and a static frontend deployment do not start those Python processes. With the target database's join key in the environment file, run `scripts/hosted-workers.sh maincloud wildfire-rescue-75xb9`. Set `HOSTED_ENV_FILE` to use a separate environment file. This launcher preserves incident data and opens no additional website port. Keep the worker process running throughout the demo.

Slack is advisory for dispatch and mission continuation. Negative margins stay critical and remain eligible when a route and compatible unit exist. An elapsed arrival estimate at a location without observed fire is flagged as uncertain, rather than treated as proof that the caller has burned. Ground reachability uses observed fire and actual road closures; forecast deadlines do not close roads.
