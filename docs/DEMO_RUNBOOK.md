# Recorded Arizona wildfire demo

Run `scripts/demo.sh` in one terminal and `cd web && npm run dev` in another. The demo uses its own local database (`wildfire-arizona-demo`, or `DEMO_STDB_DB`), publishes the module, seeds the scene and starts the agents. It starts paused at the first observation. Use **Resume** in command and 30× for a response, or 600× to reach later observations. `scripts/demo.sh run` restarts agents without reseeding.

Prerequisites: SpacetimeDB CLI 2.13, Node 22+, web dependencies (`cd web && npm ci`), and a Python environment with the forecast dependencies from [RECORDED_RISK_PIPELINE.md](RECORDED_RISK_PIPELINE.md). Set `PYTHON` to that interpreter in root `.env`, alongside `AGENT_JOIN_KEY` and `OPERATOR_PASSCODE`. Keep the provided, gitignored `runs/recorded-integration/{incident.json,observations.npz,model.pt,model_metadata.json}` together. The first run downloads the road graph from OpenStreetMap via Overpass; subsequent runs use `web/public/replay/roads.json`.

The script selects `FIRE_SOURCE=recorded`, `FIRE_FORECAST_BACKEND=learned` and `POLICY=lookahead`. It writes `web/.env.local` for the matching database and enables the fictional caller placement. No GPS request is made in demo mode. `scripts/dev.sh` remains the ordinary development entry point.

## What is real

The NIROPS aerial infrared perimeters describe a northern Arizona fire near 35.65°N, 112.73°W, sequence `2bdb2cbdb71e878fee72eef8`. Its name is absent from the bundle. The 128 × 128 grid has 60 m cells, about 7.7 km across, in UTM zone 12N.

| Observation UTC, 2020 | Burned area |
|---|---:|
| Jul 8 01:10 | 1.57 km² |
| Jul 8 23:21 | 3.50 km² |
| Jul 10 03:46 | 4.32 km² |
| Jul 11 02:24 | 4.32 km² |
| Jul 12 07:31 | 6.39 km² |
| Jul 13 01:53 | 6.39 km² |
| Jul 14 02:20 | 6.39 km² |

Only observations reached by the replay clock enter the trained time-conditioned U-Net. The commander can select its actual 6, 12 or 24 hour probability output. Red shows the recorded burned area; orange to yellow shows learned exposure probabilities above 10% outside that area. Colors represent probabilities, not invented arrival times. The checkpoint uses the observed perimeter and time; the display makes no wind-conditioning claim. The same exposure layer and location probabilities reach responders.

The learned model does not resolve minute-level fire arrival. A separate conservative physical arrival estimate supplies immediate slack; real road travel, extraction needs and available units supply response timing. LOOKAHEAD consumes those assessments for dispatch. Committed missions use the assigned truck's remaining route. Moving a caller changes the shared location and triggers exposure, slack and route reassessment; no risk level is stored in the fixture.

The benchmark reports Brier 0.0121 versus 0.0134 for persistence on a reused test panel described as “diagnostic, not pristine unseen evidence.” This is not a claim of performance on pristine unseen incidents.

## Fictional response resources

The demo seeds **2 stations, 4 units and 3 background callers**. One caller needs wheelchair assistance near the fire, another has no listed needs near the fire, and the third is farther away. Their locations are chosen using calculated exposure and slack; their levels are calculated by the live pipeline. The original ordinary seeder can still load all 24 residents from the bundle.

Stations and caller pickup points sit on real OSM roads. Speeds and response timing are demo estimates. Red/white dashed closures are inferred where the recorded fire intersects those roads; they are not historical closure records. Routing excludes these edges and commander-entered closures, obeys one-way edges and shows no route when disconnected. The browser and worker share the same routing code and the truck animation samples the published road polyline.

## Five-minute flow

1. Open `#/command`, sign in with a display name and `OPERATOR_PASSCODE`. The name identifies your actions in the audit log. Inspect the three background callers, the red observed fire and U-Net exposure; change the horizon.
2. Open `#/` in another browser window. The app chooses a fictional road-access location without GPS and shows an ordinary caller map. Send an alert. It appears immediately on the command table and as a pixel exclamation point, gray while assessing, dark red for least slack through yellow for more slack.
3. Select the alert, choose **Assign ground unit**, select an available engine, then **Dispatch unit**. LOOKAHEAD may already have committed an engine automatically; that assignment remains visible. The caller receives the shared assignment and ETA.
4. Open `#/responder/4` (or the assigned engine number), sign in and inspect the pin, directions, exposure and slack. **Show whole route / Follow truck** changes map framing. **Start response**, then resume the clock in command. The truck follows the displayed road line. **Mark on scene** becomes available near the destination; then complete the mission.
5. On the caller page, use **My location has changed**, move the pin and send. The same request ID updates, its risk is recalculated, and the responder reroutes. Close the request to stop location sharing.

Pitch: “We replay a real 2020 Arizona wildfire from aerial infrared perimeters. A learned forecast model predicts where it spreads. Synthetic residents and stations let us test the rescue queue on real fire behavior.”

## Troubleshooting

If the model is pending, check the demo terminal, bundle paths and Python environment. No deterministic substitute is drawn as a U-Net prediction. An inaccessible pin produces a route-unavailable message; move it to a road access point or choose another unit. If the browser uses an old database, restart Vite after `scripts/demo.sh` writes `.env.local`. Local ports already in use can be avoided with `npm run dev -- --port 5188`.
