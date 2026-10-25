# Demo runbook: recorded Arizona wildfire replay

One scenario, end to end: a real 2020 wildfire replayed from aerial infrared perimeters, a learned model forecasting
its spread, and the agent mesh triaging synthetic residents into station rescue queues, shown in the web app.

## What the audience sees, and what is real

- **Real:** the fire. NIROPS aerial infrared perimeters of a northern-Arizona wildfire (sequence
  `2bdb2cbdb71e878fee72eef8`, near 35.65°N 112.73°W), 7 observations from Jul 8 01:10 UTC to Jul 14 02:20 UTC 2020,
  burned area 1.57 → 3.50 → 4.32 → 4.32 → 6.39 → 6.39 → 6.39 km². Also real: the trained time-conditioned U-Net that
  forecasts spread (the learned fire-risk layer, 6 / 12 / 24 h horizons).
- **Synthetic:** 2 fire stations, 4 units and 24 residents placed inside the fire area by the seeder, plus any mock pings
  you add. Say so.
- **Causal replay:** an observation reaches the model only when the replay clock gets to it. The model never sees the
  future.
- **Model score, if asked:** Brier 0.0121 vs 0.0134 for persistence, on a reused test panel the benchmark report calls
  "diagnostic, not pristine unseen evidence". Don't claim more.
- Pitch line: *"We replay a real 2020 Arizona wildfire from aerial infrared perimeters. A learned forecast model predicts
  where it spreads. Synthetic residents and stations let us test the rescue queue on real fire behavior."*

## One-time setup on the demo laptop

1. Code: `git fetch origin && git switch web-backend-integration`.
2. Tools: SpacetimeDB CLI 2.13 (`spacetime --version`), Node 18+, and the Python 3.12 forecast environment from
   [RECORDED_RISK_PIPELINE.md](RECORDED_RISK_PIPELINE.md) (`.venv-risk`, which has torch, rasterio and affine; the plain
   `venv` cannot load a recorded bundle).
3. The bundle: `runs/recorded-integration/` with `incident.json`, `observations.npz`, `model.pt`,
   `model_metadata.json`. It is gitignored, so copy the folder over if it is missing.
4. `.env` in the repo root. Keep your existing `AGENT_JOIN_KEY` / `OPERATOR_PASSCODE` / `AGENT_SEED_PREFIX`, and set:

   ```dotenv
   STDB_SERVER=local
   STDB_DB=wildfire-rescue
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
   SIM_CREWS=1
   SIM_SPEED=60
   ```

   `POLICY=lookahead` matters: `rl` is still a stub that raises, and the queue would stay empty.
5. `cd web && npm install`.

## Start (two terminals)

```bash
# 1: fresh database, publish the module, seed the recorded fire + 24 synthetic residents, start the agents and crews
scripts/dev.sh reset

# 2: the web app (it follows STDB_SERVER / STDB_DB from the root .env)
cd web && npm run dev          # http://localhost:5173
```

Give the agents ~30 s to come online (`hazard`, `news`, `intake`, `commander`, plus the `sim-crews` driver).

| Screen | URL | Sign-in |
|---|---|---|
| Incident command (main screen, live) | `http://localhost:5173/#/command` | name + `OPERATOR_PASSCODE` |
| Responder phone (live) | `http://localhost:5173/#/responder/1` (units 1–4: SIM-1..SIM-4) | name + `OPERATOR_PASSCODE` |
| Resident ("I need help") | `http://localhost:5173/#/` | none. Submits to SpacetimeDB and follows its own private request. The pin must be inside the active incident area; use Adjust location → Show active incident area → Place entrance pin for the demo. |

Use separate browser windows for command and responder. Each keeps its own identity, so they don't clash.

## Demo flow (about 5 minutes)

1. **Command console.** The header reads REPLAY · RECORDED FIRE with the recording's real time in UTC (starts
   Jul 8 2020 01:10), T+ and the speed. On the map: the recorded perimeter and the short-horizon fire forecast; the
   stations, units and 24 synthetic residents, scored and sorted into the two stations' queues, each with a reason. The
   line under the wind control shows the learned forecast: model id, issue time and pipeline status (`ready` once the
   U-Net has run on the current observation).
2. **Fast-forward.** Pick 300× or 600× in the speed menu. The next perimeters arrive (1.6 → 3.5 → 4.3 → 6.4 km²), the
   learned forecast re-issues, and the queue re-ranks. Units go out, rescue and return (simulated crews). Drop back to
   60× for the rescue part.
3. **Mock pings.** Map tools: choose 5 and press Mock pings. Five simulated residents ping from 300–1500 m off the fire,
   each with a field report. The intake agent reads them (trapped / injured / fire seen / road blocked) and they enter
   the queues within ~20–30 s. Headless alternative: `cd agents && ../.venv-risk/bin/python scripts/mock_pings.py
   --count 6 --reports --cluster`.
4. **Responder.** Open `#/responder/1` in another window and sign in: that unit's active mission, route and danger level.
   Mark it complete. While a phone is open for a unit, the crew driver leaves the "rescued" call to the phone.

## If something is off

| Symptom | Fix |
|---|---|
| Console stuck on "No incident loaded" | The seed failed. Check terminal 1: usually `PYTHON` is not the forecast env (no rasterio / affine) or `RECORDED_INCIDENT_PATH` is wrong. Fix it and run `scripts/dev.sh reset` again. |
| "Learned forecast: waiting" / pipeline `fallback` or `error` | Check `FIRE_FORECAST_BACKEND=learned` and the checkpoint / metadata paths, then restart terminal 1. The physical forecast and the queue still work meanwhile. |
| Units stay "Dispatched" and never move | The crew driver is offline: `SIM_CREWS=1`, and terminal 1 (run_all) must be running. Look for `[run_all] crews exited` in its log. |
| Requests stay "Assessing", no queue | `POLICY` must be `lookahead`. The planner also waits for a current risk assessment after every change; give it a few seconds. |
| "Wrong passcode" | It is `OPERATOR_PASSCODE` from `.env`, published with the module by `scripts/dev.sh`. Re-run it after changing the value. |
| Signed out after a reset | A reseed deletes responder sign-ins; sign in again. |
| Web app shows another database | It reads `STDB_SERVER` / `STDB_DB` from the root `.env` at startup: restart `npm run dev`. `web/.env.local` (`VITE_STDB_URI`, `VITE_STDB_DB`) overrides. |
| Want the UI without any backend | `VITE_DATA_SOURCE=sim npm run dev` runs Sharon's in-browser simulation. |

Keep everything on one laptop. Phones on the LAN would need SpacetimeDB listening on `0.0.0.0`,
`VITE_STDB_URI=ws://<laptop-ip>:3000` and `npm run dev -- --host`.

## Not done yet (say so if asked)

- The learned forecast shows as a status line, not as a map layer (its grid is UTM; the map needs a projection step).
- Reordering planned stops and the what-if preview remain simulation-only. Live command can dispatch a specific unit.

## Map and rescue slack

Command defaults to USGS/USDA aerial imagery, with road labels and translucent red fire / amber forecast overlays.
The Satellite / Streets switch keeps the current operational layers and selection; unavailable imagery falls back to
streets. The photographic background is reference imagery, not a current photograph of the fire.

Map callouts show **slack in minutes**, not distance. A request without a safe ground route has no numeric slack.
The physical forecast projects forward from the observed perimeter at the current simulation time and refreshes
as the replay clock advances. Recovered ground assignments clear their automatic unreachable escalation.

## Browser call → command → crew

1. Open the caller and command views in separate tabs. Send a help alert with a pin inside the active incident area.
2. Command immediately shows the call as **Received / assessing** in the table and map, even before the agents plan it. Use **Review caller alert** to find the latest app call.
3. Select it, choose an available unit under **Dispatch a ground unit**, and press **Dispatch unit**. Busy units and parties above a unit's capacity cannot be dispatched.
4. Open that unit's responder view using the link on the request. Its mission pin, route, turn instructions and Google Maps destination use the caller's coordinates. **Show entire route** frames the trip.
5. Moving the caller's pin updates command and recalculates the responder route. Canceling closes the shared request and removes the location. Reloading the caller restores server status under its saved identity.

Live caller text, headcount, needs and entrance edits are supported. Local photo/video uploads remain unavailable in live mode; the app does not claim to upload them. `VITE_DATA_SOURCE=sim` retains the standalone simulated caller flow.
