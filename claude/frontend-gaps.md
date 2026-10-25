# Frontend gaps and contract differences

This file lists the known differences between the frontend spec (`claude/frontend-spec.md`, called SPEC), the shared shapes (`claude/frontend-shapes.md` v1.1, called SHAPES) and the backend code (`spacetimedb/src` at commit 35000c3, the generated bindings and the spacetimedb 2.13 SDK). For each one it says how the frontend handles it. It was compiled on Oct 24 for Evan (frontend), Sathvik (backend) and Pranay (eval). SHAPES overrides SPEC on contract details (R1). Short paths used below: `index.ts` and `schema.ts` are in `spacetimedb/src/`, "bindings" means `web/src/module_bindings/`, and "SDK" means `web/node_modules/spacetimedb/src/`. Items marked (backend) need a change in Sathvik's lane. BLOCKED-BACKEND means the item can't be tested locally.

## Resolved by Evan's rulings (Oct 24)

- **R1: SHAPES wins on contract details.**
  - Danger fields that can be missing: SPEC treats `slackS`, `fireEtaS` and `ResidentCard.etaS` as plain numbers. SHAPES marks them optional, and the bindings type them `number | undefined` (`ops_request_table.ts:29-30`, `my_requests_table.ts:20`). Check for undefined before every minutes or slack calculation. Show "Not assessed yet" (or nothing on closed cards), never 0.
  - `extend_consent`: SPEC gives no args and no behavior. In SHAPES and the code it sets expiry to now + clamp(minutes, 15, 240), so a small value shortens the window, and it writes no log entry (`index.ts:550-561`). Send at least the minutes left, for example `min(240, ceil(remaining) + 60)`. Label the button "Share for N min from now", and read the new window from `consentExpiresAt`, never from the value sent.
  - Arg lists SPEC leaves out: `extend_consent {requestId, externalRef, minutes}`, `set_sim {running, speed}`, `set_road_closure_active {id, active}`, `release_weather_lock {}`. To pause, send `set_sim({ running: false, speed: sim_clock.speed })`. Speed 0 is rejected with 'speed must be in (0, 600]'.
  - Responder unit picker: it comes after login, as SHAPES says. `claim_operator` takes no unit, and the unitId lives only in localStorage. SPEC's own "No unit picked" state already fits this.
  - Scoreboard file: use the SHAPES shape, with `generatedAt` as the provenance stamp instead of SPEC's run id. Read `fires` from the file and never hardcode 200.
  - G1 is closed (see the table below).
- **R2: shell exports and paths.**
  - Export names: SPEC's `useRows` and `useSingleton`, and its `call()` returning `{pending, error}`, give way to the SHAPES exports: `useTable`, `useView`, `call` (a Promise that rejects with the server message), `login`, `cellCenter`, `cellPolygon`, `insideGrid` and `minsFromNow`.
  - SPEC extras are built on top of those exports: `useRows`, `useSingleton`, `useSimNow`, `formatT`, `gridBounds`, `cellBounds`, `errors` and `useAnchor`. The pending state, double-tap guard and error copy become a hook, for example `useCall`.
  - Clock: `minsFromNow(s, simS)` stays the export, but screens pass it SPEC's interpolated simNow. The shell measures elapsed time from the local time the last `sim_clock` update arrived (crediting at most 1 s of transit), not from the server's `lastTick`, so client clock skew drops out (`index.ts:249-255`, `web/src/lib/time/sim.ts`).
  - Folders: keep `web/src/lib`, `web/src/module_bindings` and `web/src/routes/...`, not SHAPES' `web/lib`, `web/help` and so on. Bindings regenerate into `web/src/module_bindings` with `npm run bindings` in `web/` (`web/package.json:13`). SHAPES points to a generate command in CLAUDE.md; it is now listed there.
  - Publish typed stubs of the SHAPES exports first, so the other lanes can start.
- **R3: every SPEC [confirm] reducer is in the contract.** All ten exist in SHAPES and in the bindings (`index.ts:263-288` in bindings). The FEATURES flags stay but default ON. `claim_operator` never goes behind a flag. G7 is closed.
- **R4: `unit_en_route` freeAtS = arriveAtS + extractS + (arriveAtS - simS)**, replacing SPEC's `etaS + extractS`. Pass `arriveAtS` as the current queue `etaS`, unchanged. Locally `extractS` is 0 (R7), so the result is a lower bound. Sathvik still needs to confirm the station agents use the same math (team decision 2).
- **R5: intake follows SHAPES.**
  - Shape: SPEC posts `{text}` and gets back `{headcount, needs[]}`, with a 3 s ring that starts at Send. SHAPES posts `{note, headcount?}` and gets back `{headcount, needs (comma string), note, language, summary, source}`.
  - How we build it: parse while the person types (debounced, with an AbortController and a client timeout of about 3 s). Send never waits. Headcount, needs, summary and the 'language' need show as editable chips before Send. Intake stays off until `VITE_INTAKE_URL` is set.
  - Rules for the chips:
    - Show AI chips or labels only when the response has `source === 'claude'`.
    - On a network error, build the SHAPES fallback locally.
    - A fallback or a late parse never overwrites a field the resident edited and never wipes chips they picked.
    - Keep only the 7 known needs. Join the edited chips with ','.
  - Privacy: keep ConsentSheet before DescribeStep, so parsing starts only after consent. The consent copy should say an automated assistant reads the description. Send only the note and headcount (never lat/lon), never log request or response bodies, and abort in-flight calls on unmount.
  - Labels: the drawer and the /crew card label the note as "summary plus the resident's words" (split on the first ' | '), not "raw line".
  - G8 no longer applies.
  - Hosting: Vite won't serve `web/api/intake`. It needs a function host or a separate server that holds the Claude key, plus a dev proxy. `VITE_INTAKE_URL` can be `/api/intake`.
- **R6: Figma is out of the build.** SPEC rule 0.1 and every Figma reference are void. G10 is moot.
- **R7: the danger, delegation and station agents are TODO stubs** (BLOCKED-BACKEND, `agents/rescue/agents/_stub.py:10-25`).
  - What this means locally:
    - `level` stays 'unknown', `slackS` and `fireEtaS` stay undefined, and `extractS` stays 0.
    - No `queue_entry` rows exist, so `queuePosition` is 0, `stationName` is '', `etaS` is undefined and the reason is the pending text.
    - No unreachable flags appear, closures change nothing, units stay at their stations and /crew stays Idle.
    - The seed files up to 24 synthetic requests that sit in Assessing.
  - Frontend handling:
    - Build empty and unavailable states for all of these.
    - Base "No help requests yet" on active `ops_request` rows, not on `ops_queue`.
    - Mark the reorder, move, queued, unreachable and /crew mission tests BLOCKED-BACKEND. Don't invent a dev path for assigning units.
    - What can be checked locally: the 'wind' log entry, the forecast bands, the pin badge, the 'override' log entry and the Assessing group filling.
    - `flag_request` with kind 'unreachable' is allowed as a dev aid for FlagsPanel.

## Open: SHAPES vs SPEC

**One identity token per surface, or one for the whole app**
- Spec: each surface keeps its own token, `stdb_token:help|command|crew` (`frontend-spec.md:121`).
- Shapes: "One SpacetimeDB connection", with one identity token saved in localStorage (`frontend-shapes.md:25-26, :29`).
- Code: `claim_operator` overwrites the identity's operator row, and `scopeFor` reads that row (`index.ts:311-321, :800-812`). With a shared identity, a /help request gets filed by an operator, and claiming responder turns the commander's views into one station's rows. The SDK's ConnectionManager keys connections by uri::module, ignores a new builder once a connection is live, and is not exported (`SDK sdk/connection_manager.ts:120-122, :241-250, :315-337`).
- Frontend handling: keep SPEC's per-surface token keys and a per-surface saved login. This still fits SHAPES' "saved in localStorage". Force a fresh connection per surface: either hard-navigate between /help, /command and /crew, or own the DbConnection and rebuild it with that surface's token. Use the remembered role only to skip the gate on its own route, never to redirect a resident off /help.

**/crew read set**
- Spec: sim_clock, grid, station, unit, fire_cell, road_closure, agent, ops_request, ops_queue (`frontend-spec.md:132`).
- Shapes: unit, station, ops_request, ops_queue, sim_clock (`frontend-shapes.md:20`).
- Frontend handling: keep SPEC's larger set. The mini map needs grid, fire_cell and road_closure, and the station-agent banner needs agent. They are all public tables, and a screen's read set isn't a contract detail.

**Scoreboard: build it now, or no UI until there is data**
- Spec: not built until it has a data source, and no placeholder (`frontend-spec.md:265, :379`).
- Shapes: component 5 reads `web/public/scoreboard.json` (`frontend-shapes.md:22, :94-96`).
- Code: there is no table or view, and `web/public/` holds only `favicon.svg`.
- Frontend handling: if it gets built, code it against the SHAPES schema under `web/src/routes/command`. Render nothing while the file is missing or fails validation: no placeholder and no sample rows. See team decision 9.

**Wind direction range**
- Spec: 0 to 359 (`frontend-spec.md:261`).
- Shapes: 0-360 (`frontend-shapes.md:11`).
- Code: `set_weather` stores `((d % 360) + 360) % 360`, so 360 comes back as 0 (`index.ts:409-412`).
- Frontend handling: keep the slider at 0..359 and display the stored value.

**Who drives a unit (G6)**
- Spec: decide per station (`frontend-spec.md:327, :381`).
- Shapes: decide which unit the station agent leaves alone (`frontend-shapes.md:99`).
- Code: `requireStationActor` lets the station's agent and any responder of that station drive every unit of the station, with no per-unit ownership (`index.ts:112-118`). The stub station agents heartbeat 'online' but drive nothing.
- Frontend handling: until team decision 1 is made, the /crew banner says "A station agent is online for this station". It does not say the agent is driving.

## Open: code vs SHAPES or SPEC

### Types, names and the shell

**u64 values are bigint**
- Spec: rule 7 lists request ids, flag ids and versions as bigint. CurrentMission is gated on `unit.currentRequest ≠ 0` (`frontend-spec.md:21, :307`).
- Shapes: "currentRequest (0 = none)", "requestId (0 = none)", with no TS types (`frontend-shapes.md:37, :42-43`).
- Code: `unit.currentRequest`, `event_log.id` and `requestId`, `road_closure.id`, `travel_estimate.key` and every version are u64, so bigint (`schema.ts:100, :181, :246, :285, :291`). Unit, station and cell ids, `queue_entry.unitId`, `stationId`, `rank`, `pinnedStationId`, `hopCount` and `queuePosition` are u32, so number. tsc rejects `currentRequest !== 0` (TS2367). Forced through with a cast, it is always true at runtime.
- Frontend handling: compare with `0n`. Pass closure ids as bigint. Join `unit.currentRequest` to `ops_request.id` (both bigint), and join `queue.unitId` to `unit.id` (both number). Key maps by `String(id)`. Add closure ids, event ids and travel keys to the rule 7 list in lib/domain.

**Binding names are camelCase**
- Spec: `useRows('station')`, `useSingleton('sim_clock')`, plus rule 6 ("use the casing the generated TS exposes") (`frontend-spec.md:20, :136`).
- Shapes: snake_case names for tables, views and reducers, e.g. `call('submit_help_request', ...)` (`frontend-shapes.md:27-28`).
- Code: the accessors are `simClock`, `fireCell`, `myRequests`, `opsRequest` and so on. snake_case aliases exist only for the 5 views, and they are @deprecated. `conn.db.sim_clock` is undefined. Reducers are `conn.reducers.submitHelpRequest` and so on (bindings `index.ts:88-258, :262-289`). Reducer arg keys are camelCase with no remap.
- Frontend handling: R2 keeps the snake_case export names, so the shell needs an explicit typed map from wire name to accessor for tables, views and reducers. Build it from the exported `tables` and `reducers`, since REMOTE_MODULE is private. Don't rename arg keys, and don't use the deprecated aliases.

**View row types in types.ts are empty**
- Shapes: calls the rows ResidentCard, help_request, queue_entry, travel_estimate and flag (`frontend-shapes.md:50-54`).
- Code: `MyRequests`, `OpsRequest`, `OpsQueue`, `OpsTravel` and `OpsFlag` infer to `{}`, so every field access fails with TS2339 (bindings `types.ts:142-143, :154-164`). The real types are `ResidentCardRow`, `HelpRequest`, `QueueEntry`, `TravelEstimate` and `Flag`. The bindings index doesn't re-export types.ts.
- Frontend handling: type view rows with the real types, or let `useTable(tables.x)` infer them. Never use the empty types, and never paper over them with `as any`.

**The SDK's own useTable differs from the shell's**
- Spec: "if spacetimedb/react exists, use it", plus named query sets (`frontend-spec.md:55, :125-132`).
- Code: spacetimedb 2.13 `useTable(query)` takes a query-builder object (a string throws). It returns `[rows, isReady]`, throws outside SpacetimeDBProvider, and opens a subscription per call (`SDK react/useTable.ts:69-72, :82-90, :138-150`).
- Frontend handling: the shell's `useTable(name)` and `useView(name)` are thin wrappers. Import the SDK hook under an alias. Expose readiness separately, because the Loading and stale states need it. Pick one subscription model, per-hook or named query sets, not both.

**call(): rejections, offline queuing, sync throws, hangs**
- Spec: calls are disabled unless the connection is live. On /help, nothing is queued for later (`frontend-spec.md:123, :138, :216`).
- Shapes: call() rejects with the server's message (`frontend-shapes.md:28`).
- Code: the SDK can reject with SenderError (the module text in `.message`), InternalError, DisconnectedError (only with auto-reconnect) or UnknownCallResultError ("may or may not have run"). Without auto-reconnect, a call made before the socket opens is queued, and calls never settle after the connection ends. Args are serialized synchronously, so a missing string or a non-bigint u64 throws TypeError (`SDK sdk/db_connection_impl.ts:772, :866, :997-1007, :1459-1484, :1950-1980`).
- Frontend handling:
  1. Refuse locally unless the shell state is live. Never use SDK `useReducer` (it also queues calls).
  2. Wrap the call in try/catch so a sync throw becomes a rejection.
  3. Reject with `{message, kind: server | disconnected | unknown_outcome | internal}`. errors.ts maps server text only.
  4. Add a timeout.
  - After an unknown outcome, re-read `my_requests` or the unit row before offering a retry. A retry can hit an "already done" error, for example '<CALLSIGN> has no pending assignment', 'request 0 not found' or 'no mission to decline'.

**SHAPES defaults are client-side only**
- Shapes: `externalRef = ''`, `source = 'manual'`, headcount default 1, consentMinutes and minutes default 60 (`frontend-shapes.md:64-66, :69, :71`).
- Code: every binding field is required. A missing string throws. A missing u32 is sent as 0, which gives a headcount error, or quietly clamps consentMinutes or minutes to 15. A missing f64 is sent as NaN, which `set_weather` stores (`SDK lib/binary_writer.ts:135-139, :205-217`, `index.ts:189, :191, :409-411, :556`).
- Frontend handling: fill the defaults explicitly, and type args with the generated `*Params` so a missing field fails at compile time. The Extend default of 60 applies only when it doesn't shorten the window.

**Agent-only and seed-only reducers are exposed in the bindings**
- Spec: `load_scenario` is never wired (`frontend-spec.md:19, :241`).
- Code: all 26 reducers are exposed. `load_scenario` and `upsert_fire_cells` accept a human commander, so the commander UI could wipe every request and responder login. `unit_position` accepts a responder (`index.ts:343-357, :435, :699-704`).
- Frontend handling: type call()'s name as a union of the 17 SHAPES reducers, and keep all reducer access inside call().

**Connection lifecycle**
- Spec: backoff 1, 2, 4, 8, then every 10 s, and resubscribe on reconnect (`frontend-spec.md:122`).
- Code: `withAutomaticReconnect` doubles from 1 s up to a 30 s cap, with ±50% jitter. It replays subscriptions itself and does not retry a failed initial connection. The provider forces auto-reconnect (`SDK sdk/db_connection_builder.ts:158-173, :221-234`).
- Frontend handling: use `withAutomaticReconnect({ minDelayMs: 1000, maxDelayMs: 10000 })`. Don't resubscribe by hand. Retry the initial connect yourself when not using the provider. Derive 'reconnecting' from `conn.isReconnecting` or `nextReconnectAttempt`.

**Token keys don't include the server or database**
- Spec: keys are `stdb_token:<surface>` (`frontend-spec.md:120-121`).
- Code: the same VITE_* vars point at local or hosted servers (`CLAUDE.md:23`, `web/.env.example:2`). A token from one server fails on the other with WebSocketTokenError. The SDK never falls back to anonymous, and the provider keeps retrying the same token (`SDK sdk/ws.ts:101-112`).
- Frontend handling: key tokens by uri + db + surface. On a 401 or 403 at connect, clear that key, reconnect anonymously and show "We can't find your earlier request on this phone."

### Sessions and reloads

**Operator logins don't survive re-seeds, and nothing confirms a claim**
- Spec: remember `{role, stationId, unitId, name}`. If the views stay empty for 2 s, resubscribe once (G3). The error table has no auth row (`frontend-spec.md:140-150, :378`).
- Shapes: "The DB row persists for the identity, so views keep working." (`frontend-shapes.md:29`).
- Code: `load_scenario` deletes every responder operator row, and every plain `scripts/dev.sh` run calls it. `scripts/dev.sh reset` (`--delete-data=always`) also deletes commander rows (`index.ts:355-357`, `scripts/dev.sh:25-32`). After that, the views return [] and every commander or crew reducer throws 'requires commander'. Crew reducers fall through to `requireCommander`, so acting on another station's unit gives the same error (`index.ts:103-118`). Re-seeding the same file keeps the scenario name and the ids, and only `simS` drops to 0. Empty views are also a normal result.
- Frontend handling:
  - A resolved `call('claim_operator')` is the success signal. Empty views never count as a failed claim.
  - Treat 'requires commander', and 'station N not found' from a claim, as signed out: clear the saved record and show OperatorGate with the copy "You're signed out. Sign in again."
  - When `sim_clock.simS` goes backwards, sign /crew out (any re-seed). /command learns about a wipe from the next 'requires commander'.
  - On load, check the saved stationId and unitId against live rows.
  - The passcode is never stored, so the operator types it again.
  - After a reconnect, offer "Sign in again" beside "No help requests yet" and "No one waiting".

**Resident cards are wiped by a re-seed**
- Spec: losing the token loses the card, which shows the "Token lost" copy (`frontend-spec.md:121, :215, :228`).
- Code: `load_scenario` deletes every help_request, and `dev.sh reset` wipes everything (`index.ts:345`).
- Frontend handling: an empty `my_requests` with a token still in place shows the normal empty state (the help button). Show the token-lost copy only when the device has a trace of an earlier request and the token is gone or the identity has changed.

### /help

**Reason text**
- Spec: pending shows "Received" + reason, the guide says reasons are written from queue numbers, and level is never shown to residents (`frontend-spec.md:192, :203, :218`).
- Code: the pending text already starts with "Received.". Closed rows get ''. A plan with `residentReason` '' also gives '', because `??` doesn't catch ''. A pin gives 'Assigned by incident command' (`index.ts:913, :761`). The planned policy text includes "You are #<rank>" and a fire-risk word (`agents/rescue/core/policy.py:173-180`).
- Frontend handling: render the reason alone, without prepending "Received". Hide an empty reason. Gate the help.card.reason guide step on a queued card with a non-empty reason. See team decision 6.

**queuePosition is not rank**
- Spec: the card shows "#queuePosition in line", and the ops screens show rank as line order (`frontend-spec.md:193, :253, :255`).
- Code: `queuePosition` = 1 + the waiting entries (unitId 0) with a strictly lower rank at the same station, and 0 once a unit is on the entry. Rank is the raw plan rank, and dispatched entries count in it (`index.ts:898-909`). Tied ranks give equal positions.
- Frontend handling: never present rank as the resident's place in line. If ops needs a place in line, compute it the same way. Demo narration must not compare the two numbers.

**'' means none for stationName and unitCallsign**
- Code: both are '' when there is no queue entry or no unit (`index.ts:896-897, :910-911`).
- Frontend handling: show the "Moved to" toast only when the previous and next `stationName` for the same request are both non-empty and different. Treat '' as "not assigned yet".

**Consent auto-extension happens only at expiry**
- Spec: "While a crew is committed, the module extends consent by itself." (`frontend-spec.md:205`).
- Code: when the timer fires on an assigned, en_route or on_scene request, expiry moves to now + 15 min and 'consent_extended' is logged. This repeats every 15 min. A queued request still expires (`index.ts:47, :257-272`).
- Frontend handling: when the request is locked and the countdown is at or below 0, show "Held while a crew is on the way". Expect the 15-minute sawtooth. Prompt Extend on pending or queued requests close to expiry.

**Resident error mapping**
- Spec: 'not your request' and 'request is closed' both map to "This request is already closed." (`frontend-spec.md:146`).
- Code:
  - 'not your request' means the identity or `externalRef` doesn't match (`index.ts:545, :554`).
  - `close_my_request` on an already closed request resolves with no change (`index.ts:155-156`).
  - 'request is closed' comes only from `extend_consent` and `override_assignment`.
  - A wiped request gives 'request N not found'.
  - A non-finite location gives 'invalid location' (`index.ts:187`).
- Frontend handling:
  - Map 'not your request' to the token-lost copy and drop any cached card.
  - Always take requestId from the live `my_requests` row.
  - After a close resolves, render the status the row actually holds: it may be rescued, not_found or expired rather than safe.
  - Map 'request N not found' to the closed copy and 'invalid location' to the geolocation-failed copy.

**With no scenario loaded, the server accepts any location**
- Spec: when `grid.rows === 0`, "Help requests are closed right now", and `geo/grid.ts` mirrors `insideGrid` (`frontend-spec.md:156, :214`).
- Shapes: requests outside the grid are rejected (`frontend-shapes.md:64`).
- Code: `insideGrid` returns true when there is no grid or `rows === 0`. Otherwise all four edges count as inside. The next `load_scenario` deletes any request filed in that window (`index.ts:146-152, :345`).
- Frontend handling: the client gate is the only guard. The shell's `insideGrid` mirrors the module exactly (true when `rows === 0`, inclusive edges), so /help gates on `hasScenario(grid)` and shows "Help requests are closed right now" instead of the help button.

**Headcount and note limits, intake headcount, note composition**
- Code: checks stop at the first failure, in this order: duplicate request, location, outside area, headcount, note. Note length counts UTF-16 code units. u32 truncates fractions (`index.ts:187-190`). There is no language column.
- Frontend handling:
  - Validate headcount (an integer 1..50) and note length (`String.length` up to 500) on the client.
  - Round and clamp the parsed intake headcount to 1..50 before showing the chip. A parse like 60 or 0 would otherwise fail after Send has already fired.
  - Prepend "summary | " only when the summary is non-empty. Trim the summary first so the resident's own words aren't cut.
  - Slice to 500 without splitting a surrogate pair.
  - Optionally keep the ISO language code in the note, e.g. "[es]".

### /command

**Other module errors missing from the copy table**
- Code: 'request N not found', 'unit N not found', 'station N not found', 'no mission to decline', '<CALLSIGN> is still on request #N', 'closure N not found', 'flag N not found' and 'requires commander' are not in the table (`index.ts:108, :122, :128, :316, :501, :686, :742, :756, :788`).
- Frontend handling:
  - 'request N not found': "That request no longer exists." on /command, the closed copy on /help, the "Request closed" banner on /crew.
  - 'unit N not found': clear the saved unitId and show the unit picker.
  - 'station N not found' on a claim: "That station isn't in this scenario. Pick again."
  - 'no mission to decline' and 'is still on request': "The mission already changed."
  - 'closure N not found' and 'flag N not found': "That item no longer exists."
  - The rest stay raw toasts.

**Pins: duplicate ranks and side effects**
- Code: `override_assignment` moves an unlocked entry with its old rank and etaS, so ranks can collide. It sets reason 'Commander override: <note>' and `residentReason` 'Assigned by incident command'. It doesn't touch hopCount. On a pending request it only sets `pinnedStationId`. Unpin only clears `pinnedStationId`. `publish_plan` doesn't check that ranks are unique (`index.ts:617-629, :757-763`).
- Frontend handling: sort by rank, then etaS, then requestId. Require a note. Show the pin icon on Assessing rows and in RequestDrawer too. /help will toast "Moved to <station>: Assigned by incident command". The move path can't run locally (R7).

**Pins on locked requests are accepted**
- Spec: Pin is disabled on a locked request (`frontend-spec.md:259`).
- Code: the pin is written and logged, but the queue entry and unit stay as they are. It takes effect after a decline or abort. The ASI:One commander agent can send these pins (`index.ts:755-766`).
- Frontend handling: disable Pin for assigned, en_route and on_scene. Unpin stays available. Label an existing pin on a locked request "applies if the crew aborts".

**slackS is a snapshot**
- Code: stored as sent, with no time of assessment (`index.ts:565-581`).
- Frontend handling: label it "slack at last assessment". Don't age it on the client and don't recompute the level from it.

**Forecast coverage**
- Spec: three bands from `arrivalEarlyS` (`frontend-spec.md:247`).
- Code: rows exist only for unburnt cells with a finite p10, up to a 3 h horizon. When p50 isn't finite, `arrivalMedianS` is set to now + horizon. `members` is stored in `forecast_meta` (`index.ts:454-475`, `agents/rescue/hazard/forecast.py:23-24, :77-84`).
- Frontend handling: a missing row means "no forecast", never safe. Put arrivals already in the past in the first band. Check `arrivalMedianS` against `computedAtS + horizonS` before showing it. Read `members` from `forecast_meta` instead of printing 16.

**Free-text "enums"**
- Shapes: `weather.source` nws|manual|scenario, `road_closure.source`, `channel` (`frontend-shapes.md:38, :42, :51`).
- Code: none of these are validated. `weather.source` is 'none' at init and stays 'manual' after a release (`index.ts:230, :372, :409-426`).
- Frontend handling: render them as plain text with a fallback, and never write an exhaustive switch on them.

**release_weather_lock doesn't restore live wind**
- Code: it only clears `locked`, and it logs even when the wind wasn't locked. The hazard agent writes again only on a fresh NWS reading (about hourly), and never when `WEATHER_SOURCE=scenario` (`index.ts:422-427`, `agents/rescue/hazard/weather.py:47-68`).
- Frontend handling: drive the lock badge from `weather.locked`. After a release, show "Live wind returns at the next feed update". Disable the button when the wind isn't locked.

**event_log carries operator names and free text**
- Spec and Shapes: "no names or locations" (`frontend-spec.md:281`, `frontend-shapes.md:43`).
- Code: actors are 'commander:<name>', 'responder:<name>' and 'station:<agentName>'. Messages include "<name> signed in as <role>", the pin note, the flag resolution, the decline reason and closure names. The schema comment says it "Never contains location or names" (`schema.ts:280-281`, `index.ts:105, :116, :320, :491, :504, :694, :766, :790`). No resident names appear anywhere.
- Frontend handling: guide copy says "no resident names or locations". OperatorGate suggests a callsign and says the name appears in the public log. The free-text inputs get the helper text "Shown in the public log. No names or addresses." Never prefill them from a request note. See team decision 5.

**event_log ordering and size**
- Code: rows from one reducer share `at` and `simS`. Each insert deletes id-400, so any gap in ids leaves old rows behind (`index.ts:67-78`).
- Frontend handling: sort by `at` desc, then id desc (bigint compare). Don't assume 400 rows or fewer, and virtualize the list.

**event_log survives re-seeds**
- Code: `load_scenario` doesn't clear event_log. After a re-seed, old rows remain with a larger `simS` and requestIds that no longer exist. `dev.sh reset` does clear them (`index.ts:328-378`).
- Frontend handling: clicking a row whose request is gone does nothing. See team decision 8 for how to show the boundary.

**Agent count and liveness**
- Spec: "N/8 agents online", online means `lastSeen` under 30 s, and an Agents-down banner (`frontend-spec.md:164, :245, :275`).
- Code: there is no expected-count table. The seed registers a 'scenario' agent that never heartbeats, so the table has 9 rows. Rows are never deleted. `onDisconnect` is a no-op, although `base.py` says the module marks agents offline. The stubs heartbeat 'online' while publishing nothing (`index.ts:241-243, :279-309`, `agents/scripts/seed_scenario.py:38`).
- Frontend handling: count agents from the rows, excluding role 'scenario', and never hardcode 8. Decide online from `lastSeen` only. Show stored status text only for online agents. Add a real-data signal for "queues aren't updating", for example active requests that stay 'unknown' with no queue entry for N seconds.

**Sim speed in guide copy**
- Spec: the cmd.clock step says "30×", which breaks rule 0.3 (`frontend-spec.md:281`).
- Code: init sets 20, the seed sets 30, and `set_sim` accepts (0, 600] (`index.ts:227, :385`).
- Frontend handling: guide copy leaves the number out. The chip reads `sim_clock.speed`.

### /crew

**"Request closed" banner: closed requests disappear**
- Spec: banner "Request #N was closed by the resident. Unit released." (`frontend-spec.md:324, :348`).
- Code: `closeRequest` deletes the queue entry, removes the request from the responder's views and sets the unit to 'available' with `currentRequest` 0n, leaving its position and `freeAtS` mid-route. Decline makes the same unit change but keeps the request queued. `complete_mission` sets the unit to 'returning' (`index.ts:155-177, :688-693, :725`).
- Frontend handling: when `currentRequest` goes from N to 0n, the status becomes 'available' and N is gone from `ops_request`, the resident closed it. If N is still there, it was a decline. 'returning' means the crew completed or aborted it. Keep the banner generic, since safe and revoked can't be told apart. Optionally offer "Back to station" through `unit_available`. Not reachable locally (R7).

**unit_en_route stores whatever it is sent**
- Code: there are no checks. `arriveAtS` also overwrites `queue_entry.etaS`. An undefined `arriveAtS` is stored as NaN in both fields (`index.ts:666-679`).
- Frontend handling: enable En route only once the `ops_queue` row for `currentRequest` exists. See team decision 7 for an ETA already behind `simS`.

**Mission reducers don't check status**
- Spec: On scene only from en_route, outcomes only from on_scene, Decline only from assigned (`frontend-spec.md:315-317`).
- Code:
  - `unit_on_scene` runs from assigned or on_scene (and logs twice).
  - `complete_mission` runs from assigned or en_route.
  - `decline_mission` only needs `currentRequest != 0`.
  - With no request, the first two throw 'request 0 not found'.
  - Abort and decline keep the old rank and a stale etaS.
  - Evidence: `index.ts:681-694, :708-733`.
- Frontend handling: gate every button on status on the client. Map 'request N not found' to the "Request closed" banner. After any outcome, show "Back in service". /help shows a past ETA sensibly, never "about -N min". Don't treat re-assignment to the same unit as an error. Ask for a short decline reason with no personal details.

### Scoreboard

**Policy names don't match the code**
- Shapes: 'lookahead' | 'first_come' | 'nearest' (`frontend-shapes.md:95`).
- Code: the registry is nearest, greedy, lookahead and learned. There is no first_come policy (`agents/rescue/core/policy.py:371-376`).
- Frontend handling: render the name as plain text with an optional label lookup. Don't assume exactly three rows.

**Metric definitions don't match evaluate()**
- Shapes: counts requests, and `medianSlackS` is the median of (fire arrival - crew arrival) in seconds (`frontend-shapes.md:96`).
- Code: `evaluate()` returns people_in_time (a headcount sum), late, unreachable and mean_slack_min, using a 300 s margin (`agents/rescue/core/policy.py:379-408`).
- Frontend handling: label exactly what the file contains. Don't recompute `missed` and don't apply the level thresholds. Hide the panel if `rescuedBeforeFire > totalRequests` or `missed < 0`.

## Tooling notes

- `scripts/dev.sh` loads `.env` after reading its environment, so a `MAILBOX_AGENTS=none` prefix on the command line is overridden by the `.env` value (`.env.example` has `intake,commander`). Set `MAILBOX_AGENTS=none` in `.env` itself for a local run (`scripts/dev.sh:10`, `agents/rescue/config.py:38`). (backend, docs only)
- spacetime CLI 2.13.0 generates the view row types in `module_bindings/types.ts` as empty objects. The shell infers view row types from the per-table schemas in `web/src/lib/stdb/rows.ts`; import row types from `@/lib/stdb`.

## Spec gaps G1-G10, updated

| # | Gap | Status now | Handling |
|---|---|---|---|
| G1 | `frontend-shapes.md` not found | Resolved | SHAPES v1.1 exists and comes from the same commit (35000c3). Differences are logged above. Keep `claude/` as the one copy, because `.claude/frontend-shapes.md` is an identical duplicate. |
| G2 | No Claude intake endpoint | Settled by R5 | Manual fields ship. Intake turns on when `VITE_INTAKE_URL` is set. Hosting `web/api/intake` needs a function host or a separate server. |
| G3 | No view returns the caller's operator role | Open (backend) | A resolved claim means signed in. 'requires commander' or a drop in `simS` on /crew means signed out. Ask Sathvik for a `my_operator` view. |
| G4 | No scoreboard data | Open | SHAPES format, with `generatedAt` as the run marker (R1). Render nothing until the file loads. Pranay confirms the format (team decision 3). |
| G5 | `unit_en_route` needs freeAtS | Settled by R4, pending Sathvik | The R4 formula, until Sathvik confirms the station agents match it (team decision 2). |
| G6 | Station agent and /crew can both drive a unit | Open, same as SHAPES team decision 1 | Neutral banner copy until decided. |
| G7 | Reducers not in the PRD list | Closed by R3 | All are in SHAPES and the bindings. FEATURES flags default ON. |
| G8 | 3 s fallback is tight | Moot | R5: parsing runs while the person types and Send never waits. |
| G9 | Map tile provider | Resolved | CARTO Dark Matter is the default style through `VITE_MAP_STYLE_URL`. |
| G10 | Figma frame says "Canyon" | Moot | Figma is out of the build (R6). |
| G11 | Danger, delegation and station agents are stubs (backend) | BLOCKED-BACKEND (R7) | Queues, levels, slack, flags, missions and unit movement never happen locally. Build the empty states and mark those tests blocked. |
| G12 | Agent liveness can't see stub or hung agents (backend) | Open | `onDisconnect` is a no-op and stubs heartbeat 'online'. Use `lastSeen` plus a real-data signal, and count agents excluding role 'scenario'. |
| G13 | Re-seeds wipe operator rows and resident requests, but not event_log | Open | Sign out on 'requires commander' or a drop in `simS`, don't read an empty card as a lost token, and treat old log rows as data only. |
| G14 | event_log has operator names and free text, against the schema comment and SHAPES (backend) | Open | Frontend copy changes as described above. The contract wording needs a decision (team decision 5). |
| G15 | Planned policy reason text says "#<rank>" and a fire-risk word (backend) | Open | It can contradict `queuePosition` and "don't show level to residents". Sathvik to decide (team decision 6). |
| G16 | Module accepts out-of-order crew calls and pins on locked requests (backend, optional) | Open | The UI gates every button. Sathvik may add server-side checks. |
| G17 | `submit_help_request` is accepted with no scenario loaded | Open | Client gate on `grid.rows === 0`. The next `load_scenario` deletes such requests. |
| G18 | Scoreboard policy names and metrics don't match `policy.py` | Open | Plain-text names and exact labels. Pranay to confirm (team decision 9). |

## Needs a team decision

Carried from SHAPES:
1. **Sathvik:** /crew and the station agents could both drive the same unit. Decide which unit the station agent leaves alone for the live /crew demo (G6).
2. **Sathvik:** confirm the station agents use the same freeAtS math as R4 (G5).
3. **Pranay:** confirm the scoreboard.json format and when the first real file lands (G4).
4. **Optional contract adds after 7 PM:** `update_my_request` (intake fills fields after the button), and a language column on help_request (reasons in the resident's language, a Should).

New:

5. **Sathvik and Evan:** event_log shows operator names and free text. Either keep this and update the schema comment and SHAPES line 43, or redact it (G14).
6. **Sathvik:** the planned `residentReason` uses "#<rank>", which can disagree with `queuePosition` on the same card, and a fire-risk word, which goes against "don't show level to residents" (G15).
7. **Evan:** when the queue `etaS` is already behind `simS`, R4's return leg goes negative. Should the frontend clamp `(arriveAtS - simS)` at 0?
8. **Evan:** event_log after a re-seed. Options: show the old rows (T+ jumps backwards), cut the list where `simS` drops between rows, or allow a 'scenario_loaded' exception to SHAPES line 47.
9. **Pranay and Evan:** the scoreboard policy names (no first_come exists in code), the metric units (requests vs people, median seconds vs mean minutes) and an optional `runId`. Also whether to build the panel now (SHAPES) or wait for real data (SPEC).
10. **Sathvik:** a `my_operator` view (G3), and whether `onDisconnect` should mark agents offline as `base.py` claims (G12).
11. **Sathvik (optional):** server-side status checks for `unit_on_scene`, `complete_mission` and `decline_mission`, and rejecting pins on locked requests (G16).
12. **Evan:** delete `.claude/frontend-shapes.md` so the one copy in `claude/` can't drift.