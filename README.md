# Wildfire Rescue Queue

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

A consent-first, transparent rescue queue for fast-moving wildfires. Residents ask
for help with one button (or in an ASI:One chat). A mesh of Fetch.ai agents works
out how long each person has before the fire reaches them, and builds a separate
queue for each fire station. Residents, responders and the incident commander all
see the same live state through SpacetimeDB.

> **Risk pipeline:** [recorded incident runbook and app contract](docs/RECORDED_RISK_PIPELINE.md).
> Recorded fire observations now drive the trained U-Net through the hazard agent; the commander publishes
> per-resident exposure, routing, slack and accepted evidence through `ops_risk` / `my_risk`.
> [RL_INTEGRATION.md](docs/RL_INTEGRATION.md) describes the separate dispatch-policy extension.

> **Everything here is simulated.** Synthetic residents, a simplified fire model,
> no real dispatch. This is decision support for a human incident commander. It
> never replaces 911.

## Recorded-incident risk pipeline

The RL workstream's current trained artifact is a **supervised fire U-Net**. Its job in this application is to
provide risk prediction and analysis to the agents and people requesting assistance. Fire prediction,
routing/travel, danger/slack and resident-evidence weighting all participate in the complete pipeline.
`POLICY=lookahead` remains the working dispatcher; `POLICY=rl` still requires a separate dispatch implementation.
Forecast selection and dispatch selection are independent.

- `FIRE_SOURCE=recorded` loads a checksum-bound, portable observation bundle. T+0 maps to the first acquisition UTC;
  future observations never become model inputs before their replay time. The recorded fire does not spread synthetic
  ground truth between acquisitions. Physical forecasts continue supplying short-horizon travel deadlines.
- The hazard agent publishes all learned probabilities losslessly in **one transaction**, using a compact dense
  transport to stay within the HTTP body limit. `risk_pipeline` reports ready/fallback/error with forecast trace IDs.
- The commander combines exposure with station travel, estimated unit wait, extraction time, physical slack and
  accepted resident reports. `publish_risk_assessments` atomically writes risk, danger and travel, rejecting changed
  input snapshots and retrying failed transfers. `PlanInput.requests[].risk` carries the complete current assessment.
- Apps subscribe to **`my_risk`** (resident) or **`ops_risk`** (command/station/intake). Each card contains `assessment`,
  `current`, and `stale_reason`; stale or expired estimates remain visibly marked while reassessment is pending.
  Risk includes model/forecast/assessment IDs, input versions, probabilities/horizons, assistance timing, evidence,
  uncertainty and a readable explanation. Intake chat status reads the same exposure estimates.
  Consent withdrawal/closure purges the private risk row.

The model supports **6–72-hour exposure horizons**; these do not imply precise minute-level arrival times.
Recorded acquisition time is an idealized information-release assumption. Demo station locations, units and residents
are synthetic. Real emergency-station discovery through Bright Data Google Maps remains deferred. The grid router
remains a road-network approximation, and automated unit missions/frontends are still separate application work.

See [the runbook](docs/RECORDED_RISK_PIPELINE.md) for bundle preparation, configuration, seeding, app subscriptions,
reproducible tests, migration and failure diagnosis. No training runs during replay or normal CI.

## Architecture

```
 NASA FIRMS / NWS / Bright Data news              ASI:One chat
          │                                     (residents, commander)
          ▼                                              │
 ┌───────────────────────── Fetch.ai agent mesh (uAgents) ──────────────────────────┐
 │ commander (head: reports → danger → planner/RL) · hazard · news · intake            │
 └───────────────▲──────────────────────────────────────────────┬───────────────────┘
      subscribe  │ live row deltas (WebSocket)                  │ reducer calls (validated, atomic)
                 │                                              ▼
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │ SpacetimeDB module (spacetimedb/src): shared world state + rules                 │
 │  public:  sim_clock · grid · weather · fire_cell · forecast_cell · station ·      │
 │           unit · road_closure · world_version · event_log · agent · news_article│
 │  private: help_request · queue_entry · travel_estimate · flag · field_report ·   │
 │           report_assessment                                                      │
 │  views:   my_requests (resident) · ops_* (role-scoped: command/station/intake)   │
 │  timers:  sim_tick (1 s) · expire_consent (per request)                          │
 └─────────────────────────────────────────────────────────────────────────────────┘
                 ▲ same subscriptions
        web dashboard / resident & responder phones (frontend, TODO)
```

**Why SpacetimeDB is load-bearing:**
- Agents never call each other to share state. Each agent subscribes to the
  tables it needs and reacts when a transaction commits. The chain runs wind
  change → forecast → commander (danger → plan) → every screen, all through the DB;
  a resident's photo → intake → commander → queue, the same way.
- Every write is a reducer. That lets the database enforce the invariants no agent
  can bypass: a commander pin beats the policy, a committed unit can't be
  reassigned, and one active request per person.
- Privacy is enforced at row level with per-sender views:
  - Residents see only their own card.
  - A station sees only its own queue.
  - The intake agent sees requests and their reports (it reads them all), nothing else.
  - Data-feed agents see no people at all.
- Consent expiry is a scheduled reducer. Location is deleted in the same
  transaction that closes a request.

**Why Fetch.ai is load-bearing:** one head agent (`commander`) orchestrates three subagents, each
with one data source: `hazard` (fire + weather), `news` (X via Bright Data), `intake` (residents). Each
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
agents/rescue/agents/         one module per agent: commander, hazard, news, intake (base.py = registration/subscription/heartbeat)
agents/rescue/forecast_ml/    trained U-Net, recorded source adapter, probability transport and frozen evaluation
agents/rescue/core/risk.py    risk composition: exposure + assistance timing + accepted evidence + provenance
agents/rescue/orchestrator/   the commander's engines: reports.py (weigh residents' claims), danger.py, planner.py (Situation + policy)
agents/rescue/intake/         analysis.py: residents' text / voice / photos / video frames -> claims (Qwen3-VL on Hugging Face, keyword fallback)
    core/reports.py           how far a resident's claims may move danger and queues (credibility, corroboration, plausibility)
agents/rescue/hazard/         the hazard agent's engines: fire.py, weather.py, forecast.py
agents/rescue/data/           external feeds: nws.py (wind), firms.py (NASA satellite fire detections), brightdata.py (X posts scraper)
agents/rescue/news/           sources.py: trusted X accounts near the incident; signals.py: evacuations, closures, shelters, containment, acres, relevance
agents/news_sources.json      trusted X accounts (kind, official, area covered) the news agent can follow
agents/fixtures/              synthetic posts in Bright Data's X output format, for free/offline news testing
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
| forecast engine (hazard) | **done**: re-forecasts on wind/fire change (~0.1 s) |
| `intake` agent (resident-facing) | **done**: reads every ping and its reports (text, voice transcript, photos, video frames) into an `Assessment` it sends the commander (uAgents, acknowledged and re-sent until it is), using an open vision-language model on Hugging Face (`Qwen/Qwen3-VL-30B-A3B-Instruct` by default; keyword fallback offline). Its ASI:One chat is a test harness. Vision path verified against a stub, not yet against the live router |
| `hazard` agent (fire + weather + forecast) | **done**: simulated fire spread every tick (NASA FIRMS detections with `FIRE_SOURCE=firms`, untested without a key); live NWS wind that defers to the commander's manual wind; ensemble arrival forecast; answers the commander's `HazardReportRequest` |
| `commander` agent (ASI:One) | working: pools the hazard agent's fire + weather report and the news agent's headlines with queue state; `news`, `refresh news`, `track <x.com post>`, `ping <lat> <lon> [place]`, `window <from> <to>` / `window live`; login, status, fire, weather, wind, release wind, pause/resume, pin/unpin |
| `news` agent (Bright Data X) | **done**: follows trusted wildfire accounts on X near the incident (`news_sources.json`) through Bright Data's X Posts scraper (or replays `fixtures/`), scores relevance (incident name/places, recency, account trust and locality), extracts evacuations/closures/shelters & relief/containment/acres, stores in `news_article`; answers `NewsReportRequest` / `NewsRefreshRequest` / `NewsTrackRequest`. Real API untested without a key (mock-tested: `scripts/test_news.py`) |
| Planner synthesis (inside commander) | **synthesis done, policy TODO**: every `SITUATION_PERIOD_S` it asks the hazard and news agents for their typed reports, merges them into one `Situation` (`rescue/core/situation.py`), keeps it as `self.latest` for the policy, and records it in the `situation` table when something material changes. Records nothing, and reports `degraded`, if the hazard agent is silent |
| `danger` engine (inside commander) | risk + slack + level + travel time per request, via `rescue/core/danger.py` (written; end-to-end run on a throwaway database: 24 requests scored, 24 queued, 5 units dispatched) |
| Commander planning loop | builds `PlanInput` from the database, runs the policy chosen by `POLICY` (`lookahead` placeholder by default, `rl` = the RL teammate's `rescue/rl_policy.py`), publishes the plan with current risk records and trace IDs; learned fire risk exercised through the real local agent mesh. The separate RL dispatcher remains a stub. See `docs/RL_INTEGRATION.md` |
| Unit missions | Lifecycle reducers exist; automatic execution is not implemented |
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
all 4 agents (commander, hazard, news, intake). Useful commands:

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

The news agent follows **trusted wildfire accounts on X** (CAL FIRE units, sheriffs / county OES, NWS
offices, Caltrans districts, Red Cross, PG&E, NIFC) through Bright Data's pre-built **X (formerly Twitter) -
Posts** scraper (dataset `gd_lwxkxvnf1cynvib9co`, Web Scraper API):

- **Discover by profile url**: `POST /datasets/v3/trigger?...&type=discover_new&discover_by=profile_url` with
  one `https://x.com/<handle>` input per account and `limit_per_input` posts each, then poll
  `/datasets/v3/progress/<snapshot>` and download `/datasets/v3/snapshot/<snapshot>`.
- **Collect by URL**: `POST /datasets/v3/scrape` (synchronous) for single posts: the incident catalog's `posts`,
  and any post the commander hands over with `track https://x.com/<account>/status/<id>`.

`agents/news_sources.json` lists each account with its kind (fire, emergency, relief, weather, transport,
utility, tracker), whether it is an official agency, and the area it covers. For an incident the agent follows
the accounts covering it: the most local fire agency, evacuation authority, relief org and forecaster first,
then the most local of the rest (`NEWS_MAX_ACCOUNTS`). Official accounts and local accounts score higher.

1. `.env`: `NEWS_SOURCE=brightdata`, `BRIGHTDATA_API_KEY` (brightdata.com/cp/setting/users → Add API key).
2. Check the handles in `news_sources.json` on x.com (written from memory; a wrong one shows up as an
   input error in the news agent's log and status) and add your area's accounts, or list extras in `NEWS_ACCOUNTS`.
3. Tune `NEWS_MAX_ACCOUNTS`, `NEWS_POSTS_PER_ACCOUNT` (Bright Data bills per post returned), `NEWS_PLACES`.

**Where and when (plug-in points).** Two shared rows steer the news agent, so any component can drive it with
one reducer call and read the results from `news_article` by subscription:

| Want | Call | Who can call it |
|---|---|---|
| look at a location | `ping_news(lat, lon, label)` → `news_focus` row | operators (web app), registered agents, commander `ping 38.58 -122.58 Calistoga` |
| stop pinning a location | `clear_news_focus()` | same |
| a past time window | `set_incident(...)`: a catalog fire (`incident glass-fire-2020`) or any range (`window 2020-09-27 2020-10-20`) | commander, scenario loader |
| back to now | `clear_incident()` (`window live`) | same |

On every change the agent re-scores stored posts for the new place (free) and pulls the trusted accounts near it
that aren't on file yet for that window (`NEWS_FETCH_ON_PING`). Live mode keeps the last `NEWS_LIVE_LOOKBACK_H`
hours. Posts are tagged with the incident key (`''` = live); the `news` report and `NewsReport.focus` say where and
when it is looking. `scripts/ping_news.py` makes the same calls from the shell and watches the result;
`scripts/try_brightdata.py` calls Bright Data directly (no mesh) to check a key, handles and date inputs.

`NEWS_SOURCE=file` (default) replays `agents/fixtures/news_sample.json` (synthetic posts in the X
scraper's output format) for free; point `NEWS_FIXTURE` at a `news_archive/<incident>.jsonl` to replay a real
scrape. `agents/scripts/test_news.py` checks account selection, scoring and the API flow with a mocked Bright Data.

### Replaying a real incident (news date window)

`agents/incidents.json` lists real fires (Glass Fire 2020, LNU Lightning Complex 2020, Camp Fire 2018) with the
real time sim T+0 stands for, a news date window, the fire's name(s), place names, and a center that picks the
nearby X accounts. Pick one:

```bash
cd agents
../venv/bin/python scripts/set_incident.py --list
../venv/bin/python scripts/set_incident.py glass-fire-2020      # or: seed_scenario.py <scenario> --incident glass-fire-2020
```

or tell the commander `incident glass-fire-2020` in ASI:One. With an incident selected the news agent follows the
X accounts near it, keeps only posts published inside its window, and tags them so incidents never mix.
It **never scrapes automatically** in this mode (a historical window doesn't change); say `refresh news` once,
and the raw results are saved to `agents/news_archive/<incident>.jsonl` (gitignored). Profile discovery returns
an account's newest posts, so for a past fire list known status posts under the incident's `posts` (collected by
URL, any date) or, once you've confirmed the date input fields in the Bright Data dashboard, set `NEWS_SEND_DATES=1`.
Dates, names and centers in the catalog are from memory of public coverage: verify them.

### Connecting to Agentverse / ASI:One

1. Set `MAILBOX_AGENTS=intake,commander` (the default) and run `scripts/dev.sh`.
2. Each mailbox agent logs an Agent Inspector URL. Open it, click **Connect**,
   then choose **Mailbox**.
3. The agent READMEs (`agents/agent_readmes/*.md`, with Innovation Lab badges)
   are published as the Agentverse profile.
4. In ASI:One, talk to the intake agent ("I need help, fire near me"), or to the
   commander ("login <OPERATOR_PASSCODE>", "status", "wind 15 from 0").

## Agents

One head agent (**commander**) orchestrates three subagents. Judges and users talk to the commander in ASI:One. The
subagents run behind it and coordinate through SpacetimeDB and typed uAgents messages. The commander's full architecture,
message table and example chat are in [agents/agent_readmes/commander.md](agents/agent_readmes/commander.md).

| Agent | Role | Address |
|---|---|---|
| **wildfire-commander** (ASI:One entry point) | Head agent: pools the subagents' reports, scores danger, builds station queues | `agent1qdfdzq2ga6mgrv2lnltpq6rvvsps9cz0sq38cg079kca660dh857x5f8y30` |
| wildfire-hazard | Fire perimeter, wind, physical ensemble and learned U-Net forecast | `agent1qtgg77a64ge3s9x7dwfe0xvygtycsmrs32qx2ce4fxwuyj5w8afcqzf5lv7` |
| wildfire-news | Trusted wildfire accounts on X via Bright Data; hints for the commander | `agent1qvf5umfps3q8wt0evup4lga9ukmss5y6x7puten9mwdpc5xqcy22j9ena79` |
| wildfire-intake | Reads residents' reports (text, voice, photo, video) into structured claims | `agent1qtqgj8yp9emj5me8evu8h0mh5jgd6h60nr9pf9xrc4v8qvgu6mfh53h6vv6` |

Addresses derive from `AGENT_SEED_PREFIX`; the table above is for the submitted deployment. Print yours with
`cd agents && ../venv-risk/bin/python -m rescue.mesh`.

**Test it in ASI:One:** message the commander with `status`, then
`signal 35.6322 -112.7351 2 people elderly, smoke visible down the street, we can still drive out`.

## Data flow to the head agent

```
 hazard agent (fire + weather + forecast) ──HazardReport (uAgents)──┐
 news agent (X via Bright Data)           ──NewsReport (uAgents)────┼─▶ commander (head) ──▶ Situation ──▶ `situation` table
 intake agent (resident ping + text /     ──Assessment (uAgents) ────┘        │      (records it: report_assessment)
   voice / photo / video → claims)                                           ├─ reports engine: credibility, corroboration, plausibility
                                                                             ├─ danger engine: slack per request (+ accepted report adjustments)
                                                                             └─ planner: PlanInput ─▶ dispatch policy (heuristic / RL) ─▶ publish_plan
```

**What a resident's report can change.** Intake turns what they sent into claims; the commander decides how much of it
counts (`rescue/core/reports.py`):

- About their own party (people, needs, injured, trapped): applied right away, at the same trust as the request form,
  which already lets anyone tick "medical". This adds no new way to jump the queue.
- About the world (fire seen nearby, road blocked): this would push their own request up, so it has to earn a credibility
  score. The score is built from the analyzer's confidence, whether the photo or video actually shows the claim, agreement
  with the fire model and weather at the resident's own location (burning cells within a wind-dependent spotting radius,
  the forecast arrival there), and other residents reporting the same thing nearby.
  Text gets a higher bar than pictures: words alone never move the automatic order, unless two other residents nearby
  report the same thing.
  - Score of 0.6 or more: the fire ETA moves earlier (never later), and a blocked road adds on-scene time. Slack, the
    danger level and every policy follow.
  - Lower: recorded, and shown to responders next to the raw reports. There is no review queue: responders always see the
    original text, photos and video, and decide for themselves. The agent only orders attention.
  - Responders can write to a resident (`message_resident`) and read their answers (`reply_to_responder`, which also
    feeds the report). The intake agent relays this to ASI:One residents. The backend supports it; whether the frontend
    exposes it is up to you.
- Station choice is never taken from a report. Routing gives each request a travel time per station, and the policy
  (heuristic or RL) picks the station.

### How context reaches the RL policy

- **Live (inference):** the policy runs *inside* the commander agent's Python process: the RL teammate implements
  `RLPolicy.plan` in `agents/rescue/rl_policy.py` and runs with `POLICY=rl` (see `docs/RL_INTEGRATION.md`). It receives one typed
  object, `core.policy.PlanInput`: the requests, units and stations plus `situation`, the head agent's `Situation` (fire, wind,
  news, field-report counts, with data freshness). `situation.feature_vector()` is a fixed 28-number encoding (`FEATURE_NAMES`,
  `FEATURE_VERSION` 3); each request also carries `credibility`, `reported_urgency`, `trapped`, `injured` from its reports. It
  is a starting point: change it, bump the version, and store the version with any trained model.
- **Log / dataset:** every `Situation` the head agent records lands in the `situation` table. Export it with
  `agents/scripts/export_situations.py [--features]` (JSONL; empty-world rows dropped).
- **Training:** offline in the RL workstream's simulator, which builds the same `PlanInput` / `Situation`
  from `rescue/core`. Live rows are for replay, evaluation and sanity checks, not online learning.
- **Where things run:** SpacetimeDB hosts the database and the rule-enforcing module (TypeScript, no Python, no PyTorch).
  The Fetch agents and the RL model are ordinary Python processes (your laptop now, a small VM later) that connect to it.

The subagents answer with typed uAgents messages (`rescue/messages.py`), not text. Only the head agent writes `situation`
(`record_situation` is commander-only). The RL workstream can export that table as training / evaluation data, or build the
same `Situation` from the simulator. Live data does not train anything by itself: training happens offline in the simulator.

## Checking the orchestration layer

```bash
cd agents && ../venv/bin/python scripts/check_mesh.py     # read-only; uses the database .env points at
```

Verifies from the database's own contents that every agent is online and heart-beating, that the head agent is recording
situations (so its messages to the hazard and news agents work), that what it recorded matches the real fire / weather / news
tables, and that the log has no empty-world rows. Live test: tell the commander `wind 15 from 0` in ASI:One; within about a
minute a new `situation` row appears with the new wind and `red_flag` set.

Field reports end to end (plays the resident app: ping, then a report; prints the intake reply and the queue placement):

```bash
cd agents && ../venv/bin/python scripts/send_report.py 39.765 -121.60 --resident alice --people 3 \
    --text "flames about 200 feet behind the house, tree down across the road, we can't get out"
../venv/bin/python scripts/test_reports.py       # offline checks: weighing, plausibility, danger adjust, hold, features
```

Then write to the resident as a responder (`scripts/message_resident.py --station 1 --message <id> "..."`), answer as the
resident (`send_report.py --resident alice --reply "..."`), and ask the commander `reports` in ASI:One to see what was
applied.

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

## Demo access

The commander's read-only commands (`status`, `signal`, `reports`, `fire`, `weather`, `news`, `help`) need no login.
Control commands (`wind`, `pause`, `resume`, `pin`, `unpin`, `refresh news`, `incident`, `ping`, `window`) need
`login ka9Nrv0euv`, the operator passcode for this demo deployment.
