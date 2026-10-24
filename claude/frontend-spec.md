# Wildfire Rescue Queue: Frontend Spec

For Claude Code. Owner: Evan. Status: ready to build, Sat Oct 24.

**Sources.** PRD "Wildfire Rescue Queue: PRD" (current; ignore the one marked obsolete). Repo `sat-malla/wildfire-rescue` @ `35000c3` (`spacetimedb/src/schema.ts`, `spacetimedb/src/index.ts`). Figma file `Tn0gae14FsUd54lTaRZYVG` "Wildfire-Response-Queue". Visual reference: jimo.ai/product/ai.

**Contract source.** `claude/frontend-shapes.md` was not in the repo or Drive when this was written, so every table, view and reducer below comes straight from `spacetimedb/src`. If `frontend-shapes.md` exists when you start, read it first. Where it disagrees with this file, it wins; list the differences in `claude/frontend-gaps.md`.

---

## 0. Rules for Claude Code (read before anything else)

1. **Figma first.** Before building a screen, read its frame through the Figma MCP (design context, screenshot, variables). Match layout, spacing and copy to the frame. Use this spec's tokens only where Figma is silent. If the Figma MCP is unavailable or the frame is missing, stop and say so. Exception: /help has no frame yet (Evan is making it in Figma Make). If it still isn't there when you reach /help, build from this spec and put `// FIGMA: pending` above each top-level component.
2. **Never hand-edit generated bindings.** `web/src/module_bindings/` is output only. Regenerate with:
   `spacetime generate --lang typescript --out-dir web/src/module_bindings --module-path spacetimedb`
   If a binding looks wrong, the fix is in `spacetimedb/src`, which is a backend change: flag it, don't make it.
3. **Never fake data the backend doesn't have.** No mock rows, sample arrays, placeholder numbers, random ETAs or hardcoded station names. Missing data renders an explicit empty or unavailable state. Only two invented things are allowed: demo persona labels on /help (always labeled "Demo persona") and guide copy (which never states data values such as counts, times or positions; a suggested input in a `tryIt` line is fine).
4. **Don't touch the backend.** Nothing in `spacetimedb/` or `agents/` changes. Any need goes in `claude/frontend-gaps.md`, then tell Evan and Sathvik (the PRD says to flag contract changes to both lanes right away).
5. **Use only the reducers listed for each screen.** Reducers tagged **[confirm]** exist in the module but aren't in the PRD's contract list. Wire them, but keep them behind `FEATURES.<name>` in `web/src/lib/features.ts` (default off) until Sathvik confirms.
6. **Casing.** Wire names are snake_case (`queue_entry.eta_s`). Use whatever casing the generated TS exposes (likely camelCase: `etaS`). This spec uses the camelCase names from `schema.ts`.
7. **`u64` is `bigint`.** Request ids, flag ids and versions are bigint. Never `Number()` them; use `String(id)` for React keys.
8. **Ordering.** Queues sort by `rank`. `event_log` sorts by `at` (then `simS`), never by `id` (auto-increment ids have gaps and aren't ordered).
9. **Privacy.** Never `console.log` a request's lat/lon or note. No analytics SDKs. The resident UI reads only `my_requests`.
10. **Claude guardrails in UI.** No screen ever says "you're safe". Claude output appears only as fields the resident edits or confirms.
11. **No secrets in the client.** Only `VITE_*` vars ship. The operator passcode is typed at login and never stored.
12. **Test as you go.** Pass each screen's checklist before starting the next. Commit once per phase.

---

## 1. Stack and folder layout

| Layer | Choice |
|---|---|
| Build | Vite + React 18 + TypeScript (strict) |
| Routing | react-router v7 (library mode): `/help`, `/command`, `/crew`; `/` redirects to `/help` |
| Styling | Tailwind v4 (`@tailwindcss/vite`) + shadcn/ui (CLI init, dark theme) + lucide-react icons |
| Map | MapLibre GL JS via `react-map-gl/maplibre`; style from `VITE_MAP_STYLE_URL` (provider is still [VERIFY] in the PRD; a dark vector style fits the look) |
| Live data | `spacetimedb` client SDK, same minor as the module (`2.13.x`) |
| Motion | `motion` (Framer Motion), used only by the guide layer and banners |
| Tests | Vitest + Testing Library (lib), Playwright (screens) |

```
web/
  .env.example          VITE_STDB_URI, VITE_STDB_DB, VITE_MAP_STYLE_URL, VITE_INTAKE_URL (optional)
  index.html
  vite.config.ts
  src/
    main.tsx            router + <StdbProvider> + <GuideProvider>
    module_bindings/    GENERATED. Never edit.
    lib/                THE SHELL. Built first. Screens import from here only.
      stdb/
        connection.ts   builder, per-surface token, reconnect, connection state
        provider.tsx    <StdbProvider surface="help|command|crew">, useConnection()
        queries.ts      named query sets (WORLD, RESIDENT, COMMAND, CREW)
        hooks.ts        useRows(), useSingleton(), useView() typed wrappers
        reducers.ts     call(): pending, error text, double-tap guard
        errors.ts       SenderError text -> UI copy
      auth/operator.ts  claim(), remembered {role, stationId, unitId, name}
      time/sim.ts       useSimNow(), minutesUntil(), formatT()
      geo/grid.ts       gridBounds(), insideGrid(), cellBounds() (mirror of module math)
      geo/layers.ts     GeoJSON builders: fire, forecast bands, closures, pins
      domain/           status.ts, levels.ts, needs.ts (constants copied from index.ts)
      guide/            GuideProvider, Spotlight, TipCard, useAnchor, steps/{help,command,crew}.ts
      ui/               shadcn output + Panel, Stat, LevelBadge, ConnectionBanner, SimChip, EmptyState
      features.ts       flags for [confirm] reducers
    routes/
      help/             HelpPage.tsx, personas.ts, components/
      command/          CommandPage.tsx, components/
      crew/             CrewPage.tsx, components/
  tests/                help.spec.ts, command.spec.ts, crew.spec.ts
```

If `frontend-shapes.md` puts the shell somewhere else, its path wins.

---

## 2. Look and feel (Jimo-style)

What to borrow from jimo.ai/product/ai: a near-black UI, product surfaces in big rounded frames, one cool accent used only for "guidance", small mono tags naming UI parts (their "Interface Context" labels like `stat.mrr`), a "Guidance ready · 3 steps" pill, and tips that spotlight one part of the product at a time while everything else dims.

**Tokens** (CSS variables in `web/src/index.css`, mapped into shadcn's theme):

| Token | Value | Use |
|---|---|---|
| `--bg` | `#050607` | page |
| `--surface` / `--surface-2` | `#0C0E11` / `#13161B` | panels / raised cards |
| `--border` | `rgba(255,255,255,0.08)` | hairlines |
| `--text` / `--muted` | `#F2F4F7` / `#8A93A3` | |
| `--guide` | `#7AB1FE` | guide layer and focus only, never data |
| `--lvl-unreachable` | `#C084FC` | needs a human decision |
| `--lvl-critical` | `#FF5533` | slack under 10 min |
| `--lvl-high` | `#FF9F1C` | 10 to 30 min |
| `--lvl-moderate` | `#F2C94C` | over 30 min |
| `--lvl-unknown` | `#6B7280` | not assessed yet |
| `--ok` | `#3DD68C` | connection live, unit available |

- Radius: 20px frames, 12px cards, full pills. Type: Inter (400/500/600), Geist Mono for ids, callsigns, sim time and anchor tags; numbers use `tabular-nums`.
- Levels are never color alone: always a label and an icon too.
- Phones: tap targets at least 48px; the help button at least 72px tall.
- Motion 150 to 250ms ease-out. With `prefers-reduced-motion`, the spotlight jumps instead of gliding and nothing pulses.
- A `SIM 30×` chip (from `sim_clock.speed`) is always visible on ops screens. Everything is simulated, and the UI says so.

### 2.1 Guide layer (the interactive tips)

The Jimo behavior, rebuilt for this app. Engine in `lib/guide/`, steps in `lib/guide/steps/*.ts`.

- **Anchors.** Every guidable element gets `data-guide="<id>"` via `useAnchor(id)`. Ids are the mono tags shown in tips (`cmd.wind`, `help.card.position`). Place anchors while building each screen; write step content in phase 5.
- **Step shape.** `{ anchor, title, body, tryIt?, requires? }`. `body` is at most 2 sentences. `tryIt` is one line on a further use ("Try: drag wind to 25 m/s from 300°"). `requires(state)` gates the step on live data; if it's false, the step is skipped. Never fill it with sample data.
- **Spotlight.** Dim the page to `rgba(0,0,0,0.6)` except the anchor's rect (12px padding, `--guide` ring plus soft glow). The tip card docks beside the anchor and flips to stay on screen. It shows the anchor tag, title, body, `tryIt`, step dots ("2 / 6"), and Back / Next / Skip. Keys: arrows and Esc.
- **Scroll mode (phones and scrolling panels).** As each anchor crosses the middle of the viewport (IntersectionObserver, `rootMargin: "-45% 0px -45% 0px"`), it becomes the active step. It lights up, the rest dims a little, and its tip slides in. This is the "highlight as you scroll" effect.
- **Step mode (/command).** The desktop map doesn't scroll, so steps advance with Next, the arrow keys, or the wheel over the tip card.
- **Entry.** A "Guidance ready · N steps" pill in each header (N counts only the steps whose `requires` passes right now). Auto-starts once per screen per browser (`localStorage["guide:<screen>:done"]`, wrapped in try/catch).
- **Never in the way.** The guide never covers or delays an emergency action. On /help it never appears before a request exists and never auto-starts outside demo mode.
- **Anchor overlay (dev and pitch).** `?anchors=1` draws every anchor's tag in mono on top of its element, like Jimo's element catalog.

---

## 3. The shell (`web/src/lib`)

**Connection.** One `DbConnection` per tab, built with `VITE_STDB_URI` and `VITE_STDB_DB`. Use the builder methods the generated bindings expose; don't guess names.
- Each surface keeps its own token: `localStorage["stdb_token:help" | "stdb_token:command" | "stdb_token:crew"]`. Load it with `withToken`, save it in `onConnect`, and wrap both in try/catch. The resident's card depends on keeping the same identity (`my_requests` keys on `ctx.sender`), so losing the token loses the card. Say that in the /help error state.
- States: `connecting | live | reconnecting | offline | error`. Reconnect with backoff (1, 2, 4, 8, then every 10 s) and resubscribe on reconnect. `offline` when `navigator.onLine` is false. Data is **stale** after 5 s without a live connection.
- Reducer calls are disabled whenever the state isn't `live`.

**Queries** (`queries.ts`; views subscribe like tables):

| Set | Queries |
|---|---|
| `WORLD` (public) | `sim_clock`, `grid`, `weather`, `station`, `unit`, `fire_cell`, `forecast_cell`, `forecast_meta`, `world_version`, `road_closure`, `event_log`, `agent` |
| `RESIDENT` | `my_requests`, `sim_clock`, `grid` |
| `COMMAND` | `WORLD` + `ops_request`, `ops_queue`, `ops_travel`, `ops_flag` |
| `CREW` | `sim_clock`, `grid`, `station`, `unit`, `fire_cell`, `road_closure`, `agent`, `ops_request`, `ops_queue` |

Private tables (`help_request`, `queue_entry`, `travel_estimate`, `flag`, `operator`, timers) are never queried directly. The client only sees them through the views.

**Hooks.** If `spacetimedb@2.13` exports React hooks (`spacetimedb/react`), use them. If not, write a small store on `onInsert`/`onUpdate`/`onDelete` plus `useSyncExternalStore`. Either way screens call `useRows('station')`, `useSingleton('sim_clock')`, and so on.

**Reducers.** `call(reducer, args)` returns `{ pending, error }`, ignores repeat taps while pending, and maps `SenderError` text to copy (`errors.ts`):

| Module error | UI copy |
|---|---|
| `location is outside the active incident area` | "You're outside the active incident area." (demo mode offers a persona) |
| `you already have an active request (#N)` | load the existing card, no error shown |
| `headcount must be 1..50` / `note too long (max 500 chars)` | inline field error |
| `bad passcode` | "Wrong passcode." |
| `not your request` / `request is closed` | "This request is already closed." |
| `<CALLSIGN> has no pending assignment` | "No assignment to start. The line may have changed." |
| anything else | show the raw text in a toast, and never retry automatically |

**Operator sign-in** (`auth/operator.ts`). `claim_operator({ passcode, role, stationId, name })`. The `operator` table is private and there's no "who am I" view, so after a successful claim, remember `{ role, stationId, unitId, name }` in localStorage (never the passcode). If the ops views don't fill within 2 s of a claim, resubscribe once. Gap G3.

**Sim time** (`time/sim.ts`). Every fire, forecast and ETA number is an absolute sim second.
`simNow = simS + (running ? min((Date.now() - lastTick) / 1000, 5) * speed : 0)`, re-rendered every 250ms.
`minutesUntil(tS) = (tS - simNow) / 60`. Show `T+mm:ss` on ops screens and "about N min" on /help. Consent countdowns use real time (`consentExpiresAt` is a wall-clock timestamp). Timestamp to Date: `new Date(Number(ts.microsSinceUnixEpoch / 1000n))`.

**Grid math** (`geo/grid.ts`, mirrors `insideGrid` in index.ts). `dLat = rows*cellSizeM/111320`, `dLon = cols*cellSizeM/(111320*cos(originLat°))`. `cellId = row*cols + col`, row 0 is the south edge. A cell's bounds are `originLat + row*cellSizeM/111320` and `originLon + col*cellSizeM/(111320*cos(originLat°))`, each plus one cell. If `grid.rows === 0`, no scenario is loaded.

**Domain constants** (copy from index.ts, don't invent):
- Statuses: `pending, queued, assigned, en_route, on_scene` are active. `assigned, en_route, on_scene` are locked (a unit is committed). Closed: `rescued, not_found, safe, revoked, expired`. (`not_found` isn't in the schema comment, but `complete_mission` produces it.)
- Levels: `unknown, unreachable, critical, high, moderate`. They come from the danger agent; the UI never recomputes them.
- Needs: `mobility, medical, oxygen, infant, elderly, pets, language`.
- Consent: 15 to 240 min.
- Unit status: `available, assigned, en_route, on_scene, returning, out_of_service`.
- An agent counts as online if `lastSeen` is under 30 s old (they heartbeat every 10 s).

---

## 4. Screens

### 4.1 `/help`: resident (phone, design at 390×844)

**Figma:** none yet (Figma Make). **Purpose:** one button to ask for help, then a live card showing place in line, station, ETA and the reason, until they tap "I'm safe now". The demo opens here on a judge's phone.

**Data**
- Views: `my_requests`
- Tables: `sim_clock` (ETA), `grid` (area check, demo persona)
- Reducers: `submit_help_request`, `close_my_request`, `extend_consent` **[confirm]**

**Components**
- `HelpHeader`: app name from the `APP_NAME` constant (the name isn't locked yet, PRD Q7), a "Simulated demo" chip, and a "Call 911" link (`tel:911`) that is always visible, in every state.
- `DemoPersonaBanner`: shown when `?demo=1` (the QR link) or when the device's location is outside the grid. "Demo persona: Rosa, 78, uses a walker, no car." Personas live in `personas.ts` (label plus a suggested line only). The home is a random point inside the middle 80% of the live `grid`, fixed per device.
- `HelpButton`: "I need help", full width, 72px or taller.
- `ConsentSheet` (shadcn Drawer): says what's shared (location, people, needs, note) and for how long (30 / 60 / 120 / 240 min, default 60). "Share and continue" asks for geolocation (high accuracy, 10 s timeout) unless a persona is active. If denied: "A crew needs your location to find you. Call 911." In demo mode it also offers the persona.
- `DescribeStep`: one line, max 500 characters, placeholder "me and my husband, he's in a wheelchair, no car".
  - With `VITE_INTAKE_URL` set: POST `{ text }` and get back `{ headcount, needs[] }` (Claude Haiku). Show them as editable chips with Confirm. A 3 s ring starts at Send. If nothing is confirmed by then, submit the raw line plus the manual fields (headcount 1, no needs). The resident always confirms Claude's fields; unconfirmed Claude output is never submitted.
  - Without it (today): a headcount stepper (1 to 50), needs chips, and Send. No "AI read your message" UI when no AI ran.
  - Submit: `submit_help_request({ lat, lon, headcount, needs: needs.join(","), note, consentMinutes })`.
- `StatusCard`: from `my_requests`. Use the newest active row by `createdAt`; if none are active, the newest closed row. Copy by status:

| Status | Card shows |
|---|---|
| `pending` | "Received" + `reason` (the view supplies "Assessing your location...") |
| `queued` | "#`queuePosition` in line at `stationName`", "about N min" from `etaS`, `reason` |
| `assigned` | "`unitCallsign` from `stationName` is assigned to you", ETA, `reason` |
| `en_route` | "`unitCallsign` is on the way", ETA |
| `on_scene` | "`unitCallsign` is at your location" |
| `rescued` | "Marked rescued. Your location was deleted." |
| `not_found` | "The crew couldn't find you. Ask again or call 911." + help button |
| `safe` | "You closed this request. Your location was deleted." (never "you're safe") |
| `revoked` | "You stopped sharing. Location deleted, request closed." |
| `expired` | "Your sharing window ended. Location deleted. Ask again if you still need help." |

  - Don't show `level` to residents. A red CRITICAL helps nobody who's already scared.
  - **Moved stations:** when `stationName` changes between updates, show a toast "Moved to `stationName`: `reason`". This is the demo's 35 to 50 s beat.
  - `ConsentTimer`: "Sharing location for 42 more min" from `consentExpiresAt`; "Extend" calls `extend_consent` **[confirm]**. While a crew is committed, the module extends consent by itself.
  - `SafeActions`: "I'm safe now" (confirm dialog) calls `close_my_request({ requestId, externalRef: "", outcome: "safe" })`. "Stop sharing my location" uses `outcome: "revoked"`.

**States**

| State | Behavior |
|---|---|
| Loading | Button disabled with "Connecting..."; card skeleton; Call 911 still live |
| Empty | Help button (no request yet) |
| No scenario (`grid.rows === 0`) | "Help requests are closed right now." + Call 911 |
| Error | Mapped `SenderError` copy inline. Token lost: "We can't find your earlier request on this phone." |
| Offline | Banner "No connection. Your request can't be sent. Call 911." Submit disabled; nothing is queued for later (a late send at a stale location is worse than none). The card stays, grayed, with "Last updated hh:mm". |

**Guide** (scroll mode, demo mode only, after the card exists): `help.card.position` (your place, ordered by who the fire reaches first) → `help.card.reason` (written in code from the queue numbers, not invented) → `help.card.crew` (which station and crew, live) → `help.card.consent` (your location, your window; deleted on close) → `help.card.safe`.

**Test checklist**
- [ ] Persona flow: fresh device with `?demo=1` → submit → card shows `pending` within 5 s of tapping (PRD target).
- [ ] Location outside the grid gives the mapped error and offers the persona.
- [ ] Second submit loads the existing card; no duplicate request.
- [ ] With agents running, the card moves from pending to queued and shows position, station, ETA and reason with no reload.
- [ ] Changing the wind on /command so the request moves stations shows the "Moved to" toast.
- [ ] "I'm safe now" closes it: card shows `safe` and /command shows the location gone.
- [ ] Airplane mode: banner, submit disabled, Call 911 still works.
- [ ] Reload keeps the same card (token persisted).
- [ ] No string "you're safe" anywhere in `routes/help`.

---

### 4.2 `/command`: incident command (desktop, design at 1440×900, min width 1280)

**Figma:** "Wildfire rescue command". **Purpose:** every request on one map, already sorted into each station's line. The commander steps in only on judgment calls: pin someone to another station, or act on anyone a truck can't reach in time. It also hosts the demo's wind slider.

**Data**
- Views: `ops_request`, `ops_queue`, `ops_travel`, `ops_flag`
- Tables: all of `WORLD`
- Reducers: `claim_operator`, `set_weather`, `override_assignment`, `flag_request`, `resolve_flag`, `add_road_closure`, plus `release_weather_lock`, `set_sim`, `set_road_closure_active` **[confirm]**
- Never wired: `load_scenario` (the seed script owns it)

**Components**
- `OperatorGate` (role commander): name + passcode, then `claim_operator({ passcode, role: "commander", stationId: 0, name })`.
- `TopBar`: `sim_clock.scenario`, `T+` clock, `SimChip`, Run/Pause and speed (`set_sim` **[confirm]**), connection dot, "N/8 agents online" (opens `AgentMesh`), the Guidance pill.
- `IncidentMap` layers, bottom to top:
  - forecast bands from `forecast_cell.arrivalEarlyS` minus simNow (under 30 min, 30 to 60, over 60)
  - burning cells from `fire_cell` (opacity by `intensity`)
  - the incident-area outline from `grid`
  - active road closures, dashed
  - station pins
  - unit dots (color by `status`, `callsign` label)
  - request pins from `ops_request` (color by `level`, rank badge from `ops_queue`; skip rows where `locationPurged`)
  - Clicking a request opens `RequestDrawer`.
- `StationQueues`: one column per `station`, rows from `ops_queue` sorted by `rank`. A row shows rank, `#id` (mono), headcount + needs icons, `LevelBadge`, slack (`slackS/60`), ETA (`etaS` minus simNow), unit callsign if `unitId ≠ 0`, the operator `reason`, a pin icon if `pinnedStationId ≠ 0`, and hops if more than 0. A separate "Assessing" group holds active requests that have no queue entry yet.
- `RequestDrawer` (Sheet): note (raw line), needs, headcount, status, level, slack, minutes until fire (`fireEtaS`), per-station travel from `ops_travel` (`travelS`, `reachable`), queue reason, and flags.
  - Pin to station: `override_assignment({ requestId, stationId, note })`. Unpin: `stationId: 0`.
  - Flag: `flag_request({ requestId, kind: "suspect" | "escalation", detail })`.
  - When the request is locked: "Crew committed: can't be moved", and Pin is disabled.
- `FlagsPanel`: unresolved `ops_flag`, newest first. Unreachable flags show `detail` and `recommendation`. Resolve: `resolve_flag({ flagId, resolution })` with presets "Air support requested" and "Pinned to another station" plus free text. The copy says it records a decision; no air unit exists in the sim.
- `WindControl`: speed 0 to 40 m/s, direction 0 to 359 (the direction the wind blows from). On release, `set_weather({ windSpeedMps, windFromDeg, gustMps: windSpeedMps, source: "manual" })`. Shows `weather.source` and a lock badge; "Return to live wind" calls `release_weather_lock` **[confirm]**.
- `EventLog`: `event_log` sorted by `at` desc, showing `T+simS`, actor, message. Clicking a row with a `requestId` focuses that request.
- `AgentMesh` (popover): each `agent`'s name, role, status, detail and lastSeen, with an online dot.
- `ClosureTool`: two clicks on the map plus a name, then `add_road_closure({ name, lat1, lon1, lat2, lon2, source: "manual" })`. Toggle with `set_road_closure_active` **[confirm]**.
- **Scoreboard:** not built until it has a data source (gap G4). No placeholder panel.

**States**

| State | Behavior |
|---|---|
| Loading | Panel skeletons; map shows the base style only |
| Signed out | `OperatorGate` |
| No scenario (`grid.rows === 0` or `scenario === "none"`) | "No scenario loaded. Run `scripts/dev.sh reset`." |
| Empty queues | "No help requests yet. They appear here the moment a resident taps the button." |
| Agents down | Banner if `danger` or `delegation` is missing or stale: "Delegation agent offline: queues aren't updating." |
| Forecast stale | Chip "Forecast updating" while `forecast_meta.weatherVersion < world_version.weather` |
| Error | Inline next to the control that failed, plus a toast |
| Offline / reconnecting | Banner; every control disabled; data grayed with "Last update hh:mm:ss" |
| Load | Virtualize any list over 100 rows |

**Guide** (step mode): `cmd.clock` (simulated world at 30×) → `cmd.map.fire` (fire now plus when it reaches each spot) → `cmd.queue` (each station's line, ordered by who the fire reaches first, not who called first) → `cmd.queue.reason` (reasons built in code from the numbers; Claude never ranks) → `cmd.wind` (tryIt: drag the wind and watch every line reorder in the same second) → `cmd.flags` (requires an open flag: unreachable by ground means a human call) → `cmd.drawer.pin` (a pin beats the policy; a crew already sent is never pulled) → `cmd.log` (every decision logged, with no names or locations).

**Test checklist**
- [ ] Wrong passcode shows the error; the right one fills queues without a reload.
- [ ] Fire, forecast, stations, units and requests all render on the seeded Paradise world.
- [ ] Wind change reorders at least one queue and writes a `wind` event to the log.
- [ ] Pin moves an unlocked request to the chosen station; Pin is disabled on a locked one.
- [ ] An unreachable flag appears; resolving it removes it from the panel and logs it.
- [ ] Stopping the delegation agent shows the banner within 30 s.
- [ ] Killing the network disables every control.
- [ ] No hardcoded station names (grep the source for "Canyon" and "Station 8").

---

### 4.3 `/crew`: responder (phone, design at 390×844)

**Figma:** "Responder workspace · Canyon" (main) and "Responder alternate states" (offline and alert banners). There is no "Canyon" station in the seeded scenario (it has Station 81 (Paradise), Station 82 (Pentz) and Station 35 (Magalia)). Read the station name from `station`, never from the frame. **Purpose:** the next person in this station's line: where they are, how many people, what they need, and minutes before the fire. The crew taps en route, on scene, rescued, and the resident's phone updates on every tap. (A Should in the PRD; station agents play crews in the demo.)

**Data**
- Views: `ops_request`, `ops_queue` (station-scoped by the module)
- Tables: `sim_clock`, `grid`, `station`, `unit`, `fire_cell`, `road_closure`, `agent`
- Reducers: `claim_operator`, plus `unit_en_route`, `unit_on_scene`, `complete_mission`, `decline_mission`, `unit_available` **[confirm]**

**Components**
- `OperatorGate` (role responder): name, passcode, station (picked from `station`), unit (picked from that station's `unit` rows), then `claim_operator({ passcode, role: "responder", stationId, name })`. Remember the unit locally; the backend has no idea which unit a person holds.
- `CrewHeader`: station name, unit callsign and `unit.status`, connection dot, `SimChip`, Guidance pill.
- `CurrentMission` (when `unit.currentRequest ≠ 0`, joined to `ops_request`):
  - A big "N min before fire" (`fireEtaS` minus simNow) with a `LevelBadge`.
  - Headcount, needs as words and icons, the raw note, and a "Navigate" link built from lat/lon.
  - A mini map: this unit, the request, burning cells, closures.
  - Actions by `unit.status`:

| `unit.status` | Primary | Secondary |
|---|---|---|
| `assigned` | En route: `unit_en_route({ unitId, arriveAtS: queue.etaS, freeAtS: queue.etaS + request.extractS })` (gap G5) | Decline: `decline_mission({ unitId, reason })` |
| `en_route` | On scene: `unit_on_scene({ unitId })` | |
| `on_scene` | Rescued: `complete_mission({ unitId, outcome: "rescued" })` | Not found (`"not_found"`), Abort, back to line (`"aborted"`) |
| `returning` | Back in service: `unit_available({ unitId, lat, lon })` with the station's lat/lon | |

  - No optimistic updates: a button shows a spinner until the row changes.
- `StationLine`: the rest of `ops_queue` for this station, sorted by rank, read-only. Each row shows rank, headcount, needs, minutes before fire and level. Responders can't reorder; no reducer allows it.
- `AlertBanner` (match "Responder alternate states"):
  - **New assignment:** `unit.status` becomes `assigned`. Banner, plus `navigator.vibrate` where allowed.
  - **Request closed:** the resident tapped safe or stopped sharing, so the module released the unit. "Request #N was closed by the resident. Unit released."
  - **Escalated:** the current mission's level turns `critical` or `unreachable`.
  - **Offline:** "Offline. Taps won't send. Use the radio." Every action disabled.
  - **Station agent active:** the `station` agent for this station is online. "Station agent is also driving this station's units." (gap G6)

**States**

| State | Behavior |
|---|---|
| Loading | Skeleton |
| Signed out | `OperatorGate` |
| No unit picked | Unit picker |
| Idle (no mission) | "No assignment. The delegation agent assigns the next person." + `StationLine` |
| Mission | The table above |
| Empty line | "No one waiting at `station.name`." |
| Error | Mapped copy |
| Offline | Banner; actions disabled; last data grayed |

**Guide** (scroll mode): `crew.mission.time` (minutes before fire, from the forecast) → `crew.mission.needs` → `crew.mission.actions` (each tap updates the resident's phone right away) → `crew.line` (who's next and why) → `crew.alerts`.

**Test checklist**
- [ ] Sign in as a responder for station 1 and unit E81; `StationLine` shows only station 1's queue.
- [ ] With a plan assigning E81: banner, then the mission card.
- [ ] En route, On scene, Rescued each update the resident's /help card within 1 s.
- [ ] Resident taps "I'm safe" mid-mission: the closed banner shows and the unit is released.
- [ ] Abort sends the request back to the line.
- [ ] Offline banner matches the Figma alternate state, with every action disabled.
- [ ] No station name or callsign hardcoded.

---

### 4.4 Cut

"Rescue queue management" has no backend behind it. Don't build it or borrow its components. If something there looks necessary, stop and ask Evan.

---

## 5. Build order

0. **Prereqs:** module published and seeded (`MAILBOX_AGENTS=none scripts/dev.sh reset`), then bindings generated. Pin the `spacetimedb` client to the module's `2.13.x`.
1. **Shell** (`web/src/lib`): tokens, shadcn init, connection, queries, hooks, reducers, time, grid, domain, guide engine (no steps yet), `ConnectionBanner`, `SimChip`, `EmptyState`. **Done when** a dev-only `/_debug` route shows live row counts for every table and view, and the sim clock ticks.
2. **/help:** Figma Make frame if it exists. Anchors placed. **Done when** its checklist passes against the seeded DB.
3. **/command:** Figma frame first. **Done when** its checklist passes.
4. **/crew:** Figma frames first. **Done when** its checklist passes.
5. **Guide content and polish:** write `steps/*.ts`, tune the spotlight, add the `?anchors=1` overlay. Cut this first if time runs short; the loop never waits on it.

---

## 6. Gaps to raise (frontend can't solve these alone)

| # | Gap | Proposed handling |
|---|---|---|
| G1 | `claude/frontend-shapes.md` not found | Contract taken from `spacetimedb/src` @ `35000c3`; diff it against the shapes file when that turns up |
| G2 | No Claude intake endpoint in the repo | /help ships manual fields; Claude chips turn on when `VITE_INTAKE_URL` exists |
| G3 | No view returns the caller's operator role | Remember the role locally after the claim; ask Sathvik for a `my_operator` view |
| G4 | Scoreboard has no table or view | Pranay exports real eval results as `web/public/scoreboard.json` with a run id, or the backend adds a table. No UI until then. |
| G5 | `unit_en_route` needs `freeAtS`, and responders can't see `ops_travel` | Use `etaS + extractS` as a lower bound, or Sathvik changes the reducer |
| G6 | A station agent and a /crew phone can both drive one unit | Decide per station who drives during the demo |
| G7 | Reducers used but not in the PRD contract list | `claim_operator`, `set_sim`, `release_weather_lock`, `set_road_closure_active`, `extend_consent`, `unit_en_route`, `unit_on_scene`, `complete_mission`, `decline_mission`, `unit_available`: confirm with Sathvik |
| G8 | 3 s fallback is tight if Claude takes 1.5 s | Consider starting the 3 s when the fields appear, not at Send |
| G9 | Map tile provider still [VERIFY] | Pick one and set `VITE_MAP_STYLE_URL` before the /command build |
| G10 | The Figma frame says "Canyon"; no such station | Data wins; update the frame copy |
