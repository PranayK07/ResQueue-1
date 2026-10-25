# Recorded incident → agent risk → app contract

The risk workstream predicts fire exposure and explains the time available for assistance. The trained artifact is
the existing supervised U-Net; no training or online learning runs here. Fire forecasting, routing, travel/wait,
extraction, operational slack and accepted resident evidence form one risk pipeline. Dispatch is still selected
independently by `POLICY`. Real emergency-station discovery via Bright Data Google Maps is deferred.

## Data flow and ownership

1. `forecast_ml/recorded.py` verifies a `recorded-fire-v1` manifest and the SHA-256 of its observation NPZ. Paths
   inside a bundle are relative. T+0 corresponds to the first acquisition UTC; only the last two acquired masks
   reach the predictor. Future masks remain unavailable until the replay clock reaches their acquisition.
2. `hazard/fire.py` publishes the latest recorded perimeter on the application's routing grid. Coordinates are
   transformed explicitly from UTM; cell IDs are never copied between grids. No synthetic spread is inserted into
   recorded observations. Physical ensemble forecasts are still computed for short-horizon routing deadlines.
3. `hazard/forecast.py` runs the validated native model in a worker thread, reuses its loaded weights, converts
   issue UTC to simulation seconds, and calls `publish_recorded_fire_risk`. New observations, weather/fire versions,
   restarts and scenario reloads are handled. Missing inputs/model/runtime or failed gates produce public health
   state and a physical-only risk assessment, with the reason retained.
4. `orchestrator/reports.py` weighs intake claims through `core/reports.py`. `orchestrator/danger.py` applies accepted
   fire ETA/access adjustments and effective needs/headcount, then `core/risk.py` composes exposure and assistance.
   Evidence is applied once. Text-only, photo/video support and corroboration keep their existing credibility rules.
5. `publish_risk_assessments` commits private resident risk, danger and per-station travel in the same transaction.
   Commander-only writes validate the captured scenario, weather/fire/roads/requests/forecast versions, unit stamp,
   geographic product stamp and pipeline-health stamp. Concurrent input changes reject the write and trigger retry.
6. `ops_risk` / `my_risk` deliver the same records to authorized agents and clients. `planning.build_plan_input`
   passes each **current** record intact as `RequestState.risk`. Planning waits for current risk inputs before
   replacing a plan, so new evidence is never mixed with old danger/travel. Existing policies retain their scheduling behavior
   and reference the assessment ID in their explanations. No trained RL dispatcher is introduced by this integration.

The forecast's 6–72-hour probability horizons are retained. They do not replace the physical p10 arrival used for
minute-level routing/slack. A crossing is an interval or censored result, not a precise arrival timestamp. Unit waits
are estimates using `free_at_s` (the existing 30-minute fallback for busy units with missing return estimates).
Travel is the existing grid approximation; mission execution and real road/station discovery remain future work.

## Prepare a portable bundle

Run from repository root with Python 3.12. The tested environment combines application and forecasting dependencies:

```bash
python3.12 -m venv .venv-risk
.venv-risk/bin/pip install -r agents/requirements.txt -r agents/requirements-forecast.lock
```

The lock records macOS arm64 versions. On other platforms install `agents/requirements-forecast.in` with the
application requirements and record resolved versions. These commands do not train or download a model.

Use an existing processed NIROPS dataset and validated native export:

```bash
.venv-risk/bin/python agents/scripts/prepare_recorded_incident.py \
  --dataset /path/to/data/codex/dataset.json \
  --sequence-id <sequence_id_from_dataset> \
  --model-export /path/to/runs/supervised/export \
  --output runs/recorded-demo
```

The output directory must be new. The command verifies source/model hashes and copies `model.pt`,
`model_metadata.json`, `observations.npz` and `incident.json`. The manifest records original dataset/sequence hashes
without modifying the frozen dataset. Bundles and weights are gitignored; transfer this entire directory to another
machine. The prepared stations, fleet and 24 residents are synthetic fixtures located within the recorded domain.
Model export still requires its original trained-state, feature-schema, validation and inference gates.

Configure `.env` (paths may be absolute or relative to repository root):

```dotenv
FIRE_SOURCE=recorded
RECORDED_INCIDENT_PATH=runs/recorded-demo/incident.json
FIRE_FORECAST_BACKEND=learned
FIRE_FORECAST_CHECKPOINT=runs/recorded-demo/model.pt
FIRE_FORECAST_METADATA=runs/recorded-demo/model_metadata.json
FIRE_FORECAST_HORIZONS_S=21600,43200,86400
POLICY=lookahead
WEATHER_SOURCE=scenario
NEWS_SOURCE=off
INTAKE_ANALYZER=keywords
MAILBOX_AGENTS=none
```

Set the normal `AGENT_JOIN_KEY`, `OPERATOR_PASSCODE`, `STDB_SERVER`/`STDB_HTTP` and `STDB_DB` too. All processes must
target the same database. Restart agents after configuration/model changes. `scripts/dev.sh` now selects the
recorded seeder when `FIRE_SOURCE=recorded`; seeding replaces the active scenario, as the existing demo seeder does:

```bash
PYTHON=.venv-risk/bin/python scripts/dev.sh
```

For explicit control, publish the module with the configured environment, seed while paused, then start the agents:

```bash
spacetime publish --server local --yes wildfire-rescue
.venv-risk/bin/python agents/scripts/seed_recorded_incident.py runs/recorded-demo/incident.json
cd agents
../.venv-risk/bin/python -m rescue.run_all
```

`seed_recorded_incident.py --run --speed 30` starts time; `--no-residents` omits the synthetic requests. The existing
commander/responder reducers still control the clock, reports, wind and assignments. Historical acquisition is an
idealized release time: actual source delivery latency was unavailable in the dataset and is not fabricated.

## App and agent read contract

Regenerate TypeScript bindings after publishing:

```bash
spacetime generate --lang typescript --out-dir <web>/src/module_bindings --module-path spacetimedb
```

| Subscription | Access / meaning |
|---|---|
| `fire_risk_meta`, `fire_risk_cell` | Public geographic probabilities, horizons, model/forecast/observation IDs, grid/CRS and issue time |
| `risk_pipeline` | Public `ready`, `fallback`, `error` or `disabled`, active backend and diagnostic reason |
| `ops_risk` | Commander/intake: all; responder/station: only their station queue; resident: their own |
| `my_risk` | Only the caller's app request; agent-submitted external references are excluded |

Each risk card has this shape:

```text
{ assessment: { request_id, assessment_id, schema_version: "resident-risk-v1", ... },
  current: boolean, stale_reason: string }
```

| Assessment fields | Interpretation |
|---|---|
| `level`, `slack_s`, `fire_eta_s`, `extract_s` | Existing physical danger calculation, including accepted evidence |
| `station_id`, `travel_s`, `wait_s`, `scheduled_slack_s`, `reachable` | Earliest estimated station-unit assistance option, including wait; no dispatch promise |
| `headcount`, `needs`, `credibility`, `reported_urgency`, `trapped`, `injured`, `report_note` | Effective needs and weighed evidence; raw reports remain in `ops_report` |
| `forecast_id`, `model_id`, `forecast_issue_s`, `forecast_state`, `horizons_s`, `probabilities` | Learned exposure with explicit provenance; empty arrays mean unavailable/unknown, never zero risk |
| `arrival_lower_s`, `arrival_upper_s`, `exposure_slack_lower_s`, `exposure_slack_upper_s` | Coarse exposure and assistance-adjusted bounds; optional endpoints express uncertainty/censoring |
| `quality_flags`, `reason` | Known limitations and readable explanation |
| `scenario`, `assessed_at_s`, input versions/stamps, `danger_version`, `updated_at` | Exact publication context for tracing stale or inconsistent results |

All durations/times use seconds; arrival and issue times are absolute **simulation seconds**. `source_issue_utc_s`
in geographic metadata retains the original UTC. Missing optional values are `None` in Python, SDK option values in
TypeScript. The Python reducer adapter encodes them using SATS `some`/`none` without discarding any other fields.
Resident reports keep the existing API: `submit_report(..., frameUrls)` takes newline-separated frame URLs.

`current` becomes false when captured versions, unit state, pipeline status/product or scenario change, or the
learned horizon expires. Always display it alongside the prediction. A current physical-only assessment still has
an explicit unavailable/fallback/expired forecast state. Unknown, censored and stale products must not be presented
as low risk. No resident locations, reports or request IDs appear in public probability/health tables. Closing or
revoking consent deletes the private risk row in the same transaction as the request's other private data.

## Transfer integrity and diagnosis

Recorded publication transports ascending valid cell IDs, horizon-major **f64 probabilities**, and observed cell IDs.
The server validates/reconstructs all geographic rows in one transaction. Repeating named fields for ~49k cells
exceeds SpacetimeDB's HTTP body limit; this dense representation preserves the values without rounding or partial
uploads. Requests exceeding the 1.9 MB transport budget fail visibly; reduce requested horizons. The default three
128² maps fit. Legacy `publish_fire_risk` remains compatible with the earlier contract demo.

Clock progress during inference is permitted by the recorded publication contract. Timestamp comparisons allow
one microsecond of JSON float roundoff, preventing persistent rejection at a fractional paused clock. Changed scenario/fire/weather
snapshots are rejected. Risk records remain versioned and source-specific. Publication acknowledgments are recorded
only after successful reducer calls. Failed transfers retry; reconnecting commander replicas clear publication caches.
Planner signatures include policy, ETA and reasons so explanations can refresh without changing queue membership.

```bash
.venv-risk/bin/python agents/scripts/check_recorded_risk.py
```

The read-only diagnostic prints pipeline status and request/assessment/forecast IDs without locations or report text.
Follow `risk transfer committed` in agent logs, `risk_pipeline.reason`, and the matching assessment's input versions.
An initial stale-snapshot rejection while intake is writing is expected; persistent rejection indicates continuously
changing inputs or a mismatched deployment. Errors are never silently converted to low exposure.

## Verification and rollout

The executed local integration receipt (test results, runtime versions, artifact/source hashes and trace IDs) is
[`reports/recorded_risk/verification.json`](../reports/recorded_risk/verification.json).

```bash
.venv-risk/bin/python -m pytest -q
PYTHONPATH=agents .venv-risk/bin/python agents/scripts/test_planning.py
PYTHONPATH=agents .venv-risk/bin/python agents/scripts/test_reports.py
npm run typecheck --prefix spacetimedb
```

`tests/test_recorded_risk.py` checks causal observation release, checksum failure, geographic roundoff, exposure,
wait/slack/evidence composition, stale/expired/missing states and full policy-input transfer. Forecast tests do not fit
weights. An opt-in test exercises the real running mesh, database and resident WebSocket replica. Start a dedicated
loopback server/database named `wrq-recorded-*`, publish with known fixture credentials, seed the bundle and run all
four agents against it; then:

```bash
RISK_INTEGRATION_HTTP=http://127.0.0.1:3157 \
RISK_INTEGRATION_DB=wrq-recorded-integration \
RISK_INTEGRATION_PASSCODE=<fixture-passcode> \
RISK_INTEGRATION_JOIN_KEY=<fixture-join-key> \
.venv-risk/bin/python -m pytest -q tests/test_recorded_risk_database.py
```

This test creates a synthetic resident, verifies exact probability transfer, submits evidence through real intake
messages, checks station/resident/feed-agent scope, rejects an obsolete snapshot after a wind change and checks
consent cleanup while the clock advances. It changes wind and must only run against its dedicated fixture database. Ordinary CI skips it.

Publish the extended schema before starting updated agents; earlier modules do not provide the new views/reducers.
New columns on `fire_risk_meta` are appended with migration defaults; existing request/queue schemas and legacy
reducers remain compatible. Deploy agents together, regenerate app bindings, then require the diagnostic to show
current assessments for every active request. To disable learned forecasting use `FIRE_FORECAST_BACKEND=simulation`
and restart the agents; assessments retain physical routing/slack/evidence and explicitly report fallback.
