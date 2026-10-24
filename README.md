# Wildfire Rescue Queue

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

A consent-first, transparent rescue queue for fast-moving wildfires. Residents ask
for help with one button (or in an ASI:One chat). A mesh of Fetch.ai agents works
out how long each person has before the fire reaches them, and builds a separate
queue for each fire station. Residents, responders and the incident commander all
see the same live state through SpacetimeDB.

> **Everything here is simulated.** Synthetic residents, a simplified fire model,
> no real dispatch. This is decision support for a human incident commander. It
> never replaces 911.

## Architecture

```
 NASA FIRMS / NWS / closures                       ASI:One chat
          │                                     (residents, commander)
          ▼                                              │
 ┌───────────────────────── Fetch.ai agent mesh (uAgents) ──────────────────────────┐
 │ hazard · danger · delegation · station-1..3 · intake · commander                   │
 └───────────────▲──────────────────────────────────────────────┬───────────────────┘
      subscribe  │ live row deltas (WebSocket)                  │ reducer calls (validated, atomic)
                 │                                              ▼
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │ SpacetimeDB module (spacetimedb/src): shared world state + rules                 │
 │  public:  sim_clock · grid · weather · fire_cell · forecast_cell · station ·      │
 │           unit · road_closure · world_version · event_log · agent               │
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
    policy.py                 Policy interface + B0/B1 baselines + Lookahead + LearnedPolicy hook
agents/rescue/agents/         one module per agent (base.py = registration/subscription/heartbeat)
agents/rescue/hazard/         the hazard agent's engines: fire.py, weather.py, forecast.py
agents/rescue/data/           external feeds: nws.py (wind), firms.py (NASA satellite fire detections)
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
| `commander` agent (ASI:One) | working: pools the hazard agent's fire + weather report (one uAgents round trip) with queue state; login, status, fire, weather, wind, release wind, pause/resume, pin/unpin |
| `danger`, `delegation`, `station` | **stubs**: subscribe and react; the TODO in each file says what to build (core math is already in `rescue/core`) |
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
all 8 agents. Useful commands:

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
| wildfire-danger | danger | time-dependent routing + slack → `help_request.level/slack_s`, `travel_estimate` |
| wildfire-delegation | delegation | per-station queues via policy → `publish_plan` |
| wildfire-station-1..3 | station | unit missions for one station |
| wildfire-intake | intake | ASI:One resident help desk |
| wildfire-commander | commander | ASI:One incident-command console |

## Notes for teammates

- **RL workstream:** build the Gym env on `rescue/core`. Use the same fire model,
  router, and slack, and use `policy.PlanInput`/`Plan`/`evaluate()`. Export a
  TorchScript scorer that matches `LearnedPolicy.features()`, then set
  `RL_POLICY_PATH`.
- **Frontend:** subscribe to the public tables and `my_requests` (residents) or
  `ops_*` (operators, after the `claim_operator` reducer). The wind slider calls
  `set_weather`. Column names on the wire are snake_case.
- `AGENTS.md` and `.cursor/rules/` are SpacetimeDB's official AI-assistant rules
  for the 2.x TypeScript module API.
