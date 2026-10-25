# Wildfire Rescue Queue

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

A consent-first, transparent rescue queue for fast-moving wildfires. Residents ask
for help with one button (or in an ASI:One chat). A mesh of Fetch.ai agents works
out how long each person has before the fire reaches them, and builds a separate
queue for each fire station. Residents, responders and the incident commander all
see the same live state through SpacetimeDB.

> **RL teammate: start at [docs/RL_INTEGRATION.md](docs/RL_INTEGRATION.md).** It says exactly what to implement and how to plug it in.

> **Everything here is simulated.** Synthetic residents, a simplified fire model,
> no real dispatch. This is decision support for a human incident commander. It
> never replaces 911.

## Architecture

```
 NASA FIRMS / NWS / Bright Data news              ASI:One chat
          │                                     (residents, commander)
          ▼                                              │
 ┌───────────────────────── Fetch.ai agent mesh (uAgents) ──────────────────────────┐
 │ hazard · news · danger · delegation · station-1..3 · intake · commander            │
 └───────────────▲──────────────────────────────────────────────┬───────────────────┘
      subscribe  │ live row deltas (WebSocket)                  │ reducer calls (validated, atomic)
                 │                                              ▼
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │ SpacetimeDB module (spacetimedb/src): shared world state + rules                 │
 │  public:  sim_clock · grid · weather · fire_cell · forecast_cell · station ·      │
 │           unit · road_closure · world_version · event_log · agent · news_article│
 │  private: help_request · queue_entry · travel_estimate · flag                    │
 │  views:   my_requests (resident) · ops_* (role-scoped: command/station/intake)   │
 │  timers:  sim_tick (1 s) · expire_consent (per request)                          │
 └─────────────────────────────────────────────────────────────────────────────────┘
                 ▲ same subscriptions
        web dashboard / resident & responder phones (frontend, TODO)
```

**Why SpacetimeDB is load-bearing:**
- Agents never call each other to share state. Each agent subscribes to the
  tables it needs and reacts when a transaction commits. The chain runs wind
  change → forecast → danger → delegation → every screen, all through the DB.
- Every write is a reducer. That lets the database enforce the invariants no agent
  can bypass: a commander pin beats the policy, a committed unit can't be
  reassigned, and one active request per person.
- Privacy is enforced at row level with per-sender views:
  - Residents see only their own card.
  - A station sees only its own queue.
  - The intake agent sees only what it filed.
  - Data-feed agents see no people at all.
- Consent expiry is a scheduled reducer. Location is deleted in the same
  transaction that closes a request.

**Why Fetch.ai is load-bearing:** each agent owns one job and has its own
identity and role in the DB. The ASI:One agents (`intake`, `commander`) run the
primary workflows entirely in chat over the Agent Chat Protocol, using
Interactive Cards. Direct uAgents messages (`rescue/messages.py`) carry anything
that must *not* become shared state: what-if forecasts, explanations, policy
comparisons, health checks.

## Layout

```
spacetimedb/src/schema.ts     tables + reducer arg types + env (AGENT_JOIN_KEY, OPERATOR_PASSCODE)
spacetimedb/src/index.ts      reducers, scheduled jobs, role-gated views
agents/rescue/stdb.py         Python SpacetimeDB client (HTTP reducers/SQL + WS subscription replica)
agents/rescue/core/           pure models shared with the RL simulator
    fire.py                   wind-driven spread, 16-member ensemble -> p10/p50 arrival grid
    routing.py                time-dependent travel times (road "closes" before the fire gets there)
    slack.py                  slack formula, levels, extraction time, vulnerability weight
    policy.py                 Policy interface + B0/B1 baselines + Lookahead placeholder
agents/rescue/agents/         one module per agent (base.py = registration/subscription/heartbeat)
agents/rescue/hazard/         the hazard agent's engines: fire.py, weather.py, forecast.py
agents/rescue/data/           external feeds: nws.py (wind), firms.py (NASA satellite fire detections), brightdata.py (news scraper)
agents/rescue/news/           signals.py: evacuations, road closures, containment, acres, relevance from article text
agents/fixtures/              saved Bright Data export for free/offline news testing
agents/rescue/mesh.py         roster: names, ports, seed-derived addresses, local resolver
agents/scenarios/             demo worlds (synthetic)
agents/scripts/seed_scenario.py
scripts/dev.sh                start DB -> publish -> seed -> run all agents
```

### Status

| Piece | State |
|---|---|
| SpacetimeDB schema, reducers, views, timers | done, tested |
| Python client (subscribe/replica/reconnect, reducer calls) | done, tested |
| Agent base (register, subscribe, heartbeat, status protocol, local resolver) | done, tested |
| `forecast` agent | **done**: re-forecasts on wind/fire change (~0.1 s) |
| `intake` agent (ASI:One) | working: form card → submit → status → "I'm safe"; proactive updates |
| `hazard` agent (fire + weather + forecast) | **done**: simulated fire spread every tick (NASA FIRMS detections with `FIRE_SOURCE=firms`, untested without a key); live NWS wind that defers to the commander's manual wind; ensemble arrival forecast; answers the commander's `HazardReportRequest` |
| `commander` agent (ASI:One) | working: pools the hazard agent's fire + weather report and the news agent's headlines with queue state; `news`, `refresh news`; login, status, fire, weather, wind, release wind, pause/resume, pin/unpin |
| `news` agent (Bright Data) | **done**: runs your Scraper Studio collector (or replays `fixtures/`), scores relevance to the incident, extracts evacuations/closures/containment/acres, stores in `news_article`; answers `NewsReportRequest` / `NewsRefreshRequest`. Real API untested without a key (mock-tested) |
| `delegation` agent (the **head agent**) | **synthesis done, policy TODO**: every `SITUATION_PERIOD_S` it asks the hazard and news agents for their typed reports, merges them into one `Situation` (`rescue/core/situation.py`), keeps it as `self.latest` for the policy, and records it in the `situation` table when something material changes. Records nothing, and reports `degraded`, if the hazard agent is silent |
| `danger` agent | slack + level + travel time per request, via `rescue/core/danger.py` (written; end-to-end run on a throwaway database: 24 requests scored, 24 queued, 5 units dispatched) |
| `delegation` planning loop | builds `PlanInput` from the database, runs the policy chosen by `POLICY` (`lookahead` placeholder by default, `rl` = the RL teammate's `rescue/rl_policy.py`), publishes the plan; not yet exercised with a real model. See `docs/RL_INTEGRATION.md` |
| `station` | **stubs**: dispatched units do not progress yet |
| Frontend | not started; generate bindings with `spacetime generate --lang typescript --out-dir <web>/src/module_bindings --module-path spacetimedb` |

## Quick start

Prereqs: Node 18+, Python 3.12/3.13, the SpacetimeDB CLI
(`curl -sSf https://install.spacetimedb.com | sh`).

```bash
python3.13 -m venv venv && venv/bin/pip install -r agents/requirements.txt
cp .env.example .env            # then set real secrets
MAILBOX_AGENTS=none scripts/dev.sh reset   # everything local, fresh data
```

That starts SpacetimeDB on `127.0.0.1:3000`, publishes the module, loads
`agents/scenarios/paradise_demo.json`, starts the sim clock at 30x, and launches
all 9 agents. Useful commands:

```bash
spacetime sql --server local wildfire-rescue "SELECT name, role, status, detail FROM agent"
spacetime sql --server local wildfire-rescue "SELECT actor, message FROM event_log"
spacetime logs --server local wildfire-rescue
scripts/dev.sh db                                  # republish module only (agents keep running)
cd agents && ../venv/bin/python -m rescue.run_all hazard commander   # subset of agents
```

### Deploying to Maincloud (spacetimedb.com)

```bash
spacetime login                      # browser: links the CLI to your spacetimedb.com account
# in .env:  STDB_SERVER=maincloud   STDB_DB=wildfire-rescue-<team>   (names are global)
scripts/dev.sh reset                 # publish to Maincloud, seed, run agents (agents still run locally)
```

The database then appears in your spacetimedb.com dashboard (logs, tables,
usage). The agents and the frontend connect to `wss://maincloud.spacetimedb.com`
with the same database name. `scripts/dev.sh db` republishes the module without
wiping data. Switch back to `STDB_SERVER=local` for offline work.

### Bright Data news

The news agent drives a Bright Data **Scraper Studio** collector (the CNN
search → article scraper) through the batch API: `POST /dca/trigger` with one
input per keyword, then poll `GET /dca/dataset` until rows are ready (30–90 s).

1. In Scraper Studio, save the scraper to production ("Finish editing").
2. `.env`: `NEWS_SOURCE=brightdata`, `BRIGHTDATA_API_KEY` (brightdata.com/cp/setting/users →
   Add API key), `BRIGHTDATA_COLLECTOR_ID` (the `c_...` id from brightdata.com/cp/scrapers).
3. Tune `NEWS_KEYWORDS`, `NEWS_LOCATION`, `NEWS_PLACES`, `NEWS_POLL_S` (billing is per page
   load, so keep polling slow; the commander can say `refresh news`).

`NEWS_SOURCE=file` (default) replays `agents/fixtures/brightdata_cnn_sample.json`
for free; drop a fresh export from the Bright Data UI there to test new data.

### Replaying a real incident (news date window)

`agents/incidents.json` lists real fires (Glass Fire 2020, LNU Lightning Complex 2020, Camp Fire 2018) with the
real time sim T+0 stands for, a news date window, search queries and place names. Pick one:

```bash
cd agents
../venv/bin/python scripts/set_incident.py --list
../venv/bin/python scripts/set_incident.py glass-fire-2020      # or: seed_scenario.py <scenario> --incident glass-fire-2020
```

or tell the commander `incident glass-fire-2020` in ASI:One. With an incident selected the news agent uses that
incident's queries, keeps only articles published inside its window, and tags them so incidents never mix.
It **never scrapes automatically** in this mode (a historical window doesn't change, and each query costs
~100 Bright Data page loads); say `refresh news` once, and the raw results are saved to
`agents/news_archive/<incident>.jsonl` (gitignored: it holds full article text). `agents/brightdata/search_stage.js`
is a reference copy of the scraper that skips out-of-window articles before loading them.
Dates and queries in the catalog are from memory of public coverage: verify them.

### Connecting to Agentverse / ASI:One

1. Set `MAILBOX_AGENTS=intake,commander` (the default) and run `scripts/dev.sh`.
2. Each mailbox agent logs an Agent Inspector URL. Open it, click **Connect**,
   then choose **Mailbox**.
3. The agent READMEs (`agents/agent_readmes/*.md`, with Innovation Lab badges)
   are published as the Agentverse profile.
4. In ASI:One, talk to the intake agent ("I need help, fire near me"), or to the
   commander ("login <OPERATOR_PASSCODE>", "status", "wind 15 from 0").

## Agents

Addresses are derived from `AGENT_SEED_PREFIX`. Print the current table with
`cd agents && ../venv/bin/python -m rescue.mesh` and paste it here before
submitting.

| Agent | Role | What it owns |
|---|---|---|
| wildfire-hazard | hazard | fire perimeter → `fire_cell`, NWS wind → `weather` (ignored while commander has manual control), ensemble arrival times → `forecast_cell` |
| wildfire-news | news | Bright Data news scrape → `news_article` (signals are hints for the commander, never auto-applied) |
| wildfire-danger | danger | time-dependent routing + slack → `help_request.level/slack_s`, `travel_estimate` |
| wildfire-delegation | delegation | per-station queues via policy → `publish_plan` |
| wildfire-station-1..3 | station | unit missions for one station |
| wildfire-intake | intake | ASI:One resident help desk |
| wildfire-commander | commander | ASI:One incident-command console |

## Data flow to the head agent

```
 hazard agent (fire + weather + forecast) ──FireReport/WeatherReport──┐
                                                                      ├─▶ delegation (head) ──▶ Situation ──▶ SpacetimeDB `situation` table
 news agent (Bright Data → news_article)  ──NewsReport────────────────┘            │                             (typed columns, newest 2000 rows)
                                                                                   └─▶ self.latest ─▶ dispatch policy (RL workstream)
 commander (ASI:One console) asks the same two agents on demand, only to show a human the picture
```

### How context reaches the RL policy

- **Live (inference):** the policy runs *inside* the delegation agent's Python process: the RL teammate implements
  `RLPolicy.plan` in `agents/rescue/rl_policy.py` and runs with `POLICY=rl` (see `docs/RL_INTEGRATION.md`). It receives one typed
  object, `core.policy.PlanInput`: the requests, units and stations plus `situation`, the head agent's `Situation` (fire, wind,
  news, with data freshness). `situation.feature_vector()` is a fixed 24-number encoding (`FEATURE_NAMES`, `FEATURE_VERSION`); it
  is a starting point: change it, bump the version, and store the version with any trained model.
- **Log / dataset:** every `Situation` the head agent records lands in the `situation` table. Export it with
  `agents/scripts/export_situations.py [--features]` (JSONL; empty-world rows dropped).
- **Training:** offline in the RL workstream's simulator, which builds the same `PlanInput` / `Situation`
  from `rescue/core`. Live rows are for replay, evaluation and sanity checks, not online learning.
- **Where things run:** SpacetimeDB hosts the database and the rule-enforcing module (TypeScript, no Python, no PyTorch).
  The Fetch agents and the RL model are ordinary Python processes (your laptop now, a small VM later) that connect to it.

The subagents answer with typed uAgents messages (`rescue/messages.py`), not text. Only the head agent writes `situation`
(`record_situation` is delegation-only). The RL workstream can export that table as training / evaluation data, or build the
same `Situation` from the simulator. Live data does not train anything by itself: training happens offline in the simulator.

## Checking the orchestration layer

```bash
cd agents && ../venv/bin/python scripts/check_mesh.py     # read-only; uses the database .env points at
```

Verifies from the database's own contents that every agent is online and heart-beating, that the head agent is recording
situations (so its messages to the hazard and news agents work), that what it recorded matches the real fire / weather / news
tables, and that the log has no empty-world rows. Live test: tell the commander `wind 15 from 0` in ASI:One; within about a
minute a new `situation` row appears with the new wind and `red_flag` set.

Message handlers wait for the agent's world to finish loading (`MeshAgent.when_ready`); the head agent also refuses to record a
report whose weather source is `none`. Before this fix a restart could log a fire-0 row.

## Notes for teammates

- **RL workstream:** build the Gym env on `rescue/core`. Use the same fire model,
  router, and slack, and use `policy.PlanInput`/`Plan`/`evaluate()`. Plug the
  model in at `agents/rescue/rl_policy.py` (`POLICY=rl`); the full guide is `docs/RL_INTEGRATION.md`.
- **Frontend:** subscribe to the public tables and `my_requests` (residents) or
  `ops_*` (operators, after the `claim_operator` reducer). The wind slider calls
  `set_weather`. Column names on the wire are snake_case.
- `AGENTS.md` and `.cursor/rules/` are SpacetimeDB's official AI-assistant rules
  for the 2.x TypeScript module API.
