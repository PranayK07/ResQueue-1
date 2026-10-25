# Plugging in the RL policy

The RL model decides **who goes in which station's queue, in what order, and which unit leaves now**. Nothing else.
Everything it needs is already computed and handed to it. It does not touch agents, the database or the frontend.

## Quick start

1. Open [`agents/rescue/rl_policy.py`](../agents/rescue/rl_policy.py) and implement `RLPolicy.plan(inp) -> Plan`.
2. Run the agents with `POLICY=rl` in `.env`.
3. Check it is live: `queue_entry.policy` shows `rl` (set `name` in your class to see a model version there).

```bash
# in .env
POLICY=rl

# local: everything, fresh data
MAILBOX_AGENTS=none scripts/dev.sh reset

# see which policy produced the queues
spacetime sql --server local wildfire-rescue "SELECT request_id, station_id, rank, unit_id, policy FROM queue_entry"
cd agents && ../venv/bin/python scripts/check_mesh.py     # PASS / WARN / FAIL for the pipeline
```

The policy runs inside the **commander** agent's process. Changing `POLICY` or your model means restarting the commander.

**Do not set `POLICY=rl` until `plan()` is implemented.** The stub raises `NotImplementedError`; the commander then shows
`degraded` and publishes no queues at all. Until your model works, leave `POLICY=lookahead` (the default heuristic), or
have `plan()` return `LookaheadPolicy().plan(inp)` as its first line.

There is a second, older path: `POLICY=learned` with `RL_POLICY_PATH=<TorchScript file>` (`LearnedPolicy` in
`agents/rescue/core/policy.py`). It scores each (request, station) pair from 8 features and falls back to the lookahead
heuristic if the file is missing. It does not see the situation or report features below. For anything beyond a quick
test, use `rl_policy.py`.

## The contract

```python
class RLPolicy:
    name = "rl"                       # stored in queue_entry.policy
    def plan(self, inp: PlanInput) -> Plan: ...
```

Types are in [`core/policy.py`](../agents/rescue/core/policy.py). `plan()` runs in a worker thread, so keep it under about a second.

### You receive: `PlanInput`

| Field | Meaning |
|---|---|
| `now_s`, `margin_s` | sim clock (seconds since scenario start) and the safety margin in the slack formula |
| `stations` | `{station_id: name}` |
| `units` | each: `id`, `station_id`, `callsign`, `available` (free right now), `free_at_s` (absolute sim second it is back) |
| `requests` | the pending requests (see below) |
| `situation` | the commander's pooled picture of fire, wind, news and residents' reports, or `None`. `situation.feature_vector()` is a 28-number encoding |

Each request (`RequestState`):

| Field | Meaning |
|---|---|
| `id`, `created_s` | request id and when it was filed (sim s) |
| `headcount`, `needs` | people and needs (`mobility, medical, oxygen, infant, elderly, pets, language`). **Already include** what a resident's own reports added |
| `fire_eta_s` | when fire reaches the person: p10 forecast, absolute sim s. **Already includes** a credible report that fire is closer |
| `extract_s` | time on scene (people and needs, plus extra if a road is reported blocked) |
| `travel_s[station_id]` | travel seconds to the person from each station; `inf` = no safe route |
| `pinned_station` | a commander pin (0 = none). The database enforces it |
| `current_station` | the station whose queue it is in now (0 = not queued yet). Use it to avoid shuffling people between queues |
| `credibility`, `reported_urgency`, `trapped`, `injured`, `report_note` | what the intake agent read from the person's text / voice / photos / video, as weighed by the commander (`core/reports.py`). 0 / false / `""` when they sent nothing. Optional extra features |

Slack of request `r` served by a station: `fire_eta_s - (unit free time + travel_s[station] + extract_s) - margin_s`.
Negative means the fire arrives first. `core/slack.py` has `slack_s`, `vulnerability` (reward weight) and `extract_time_s`.

### You return: `Plan`

```python
Plan(policy="rl", entries=[Assignment(...), ...], unreachable=[(request_id, detail, recommendation), ...])
```

One `Assignment` per request you place: `request_id`, `station_id`, `rank` (1 = first in that station's queue),
`unit_id` (nonzero = dispatch that unit **now**; it must be available and belong to `station_id`; 0 = just queue),
`eta_s` (absolute sim second you expect a unit on scene), `reason` (one line for the commander) and `resident_reason`
(a coarse sentence shown to the resident: no formulas). `unreachable` lists requests no unit can reach before the fire; the
commander is asked for other resources.

### What is handled for you

- **Commander pins win, a unit already committed is never reassigned, one unit per request:** the database enforces these.
- **Bad output is dropped, not published:** unknown ids, duplicate requests and non-finite ETAs are removed and logged
  (`planning.validate_plan`), and ranks are renumbered per station.
- **If `plan()` raises**, the commander shows `degraded` with your error and keeps the last published plan.
- **Plans are published only when they change.**

## What the policy does NOT do

| Not yours | Where it lives |
|---|---|
| Fire prediction (when fire reaches a place) | hazard agent: `core/fire.py` + `hazard/forecast.py`, a deliberately simple wind-driven spread model. Arrives as `fire_eta_s` |
| Routing and travel times | `core/routing.py`, via `core/danger.py`. Arrives as `travel_s` |
| Danger level and slack | `core/slack.py`, `core/danger.py` |
| How much a resident's photo or text counts | `core/reports.py`. Arrives folded into the fields above plus `credibility` etc. |

Prediction is not a decision problem (nothing the dispatcher does changes the fire), so keep it a separate model and let
the policy consume its output.

## What your policy must cope with

- **It is called often.** Every new request, every resident report read by the intake agent, every danger update (a
  resident whose location changes gets new travel times), and every unit change triggers a re-plan, at most every 2 s.
  Expect the same requests again with slightly different numbers.
- **Be stable.** Moving a person between queues on a tiny change is bad for responders. `current_station` tells you where they
  are now; a small switching penalty is enough.
- **Be fast and stateless.** Load the model once in `__init__`; `plan()` should not depend on earlier calls.
- **Handle edge cases:** `inf` travel to some or all stations, no available units, a pinned request, zero requests, and a
  request that arrives with no report (credibility 0).
- **Reports are claims:** an unverified claim has already been weighed. Do not re-trust `report_note` text, and text alone
  never raises the danger level on its own.

## Training and evaluation (your side)

- **Train offline in your simulator.** Build `PlanInput` (and `Situation`) from it, run your policy, and score the plan with
  `core.policy.evaluate(inp, plan)`: people reached in time, weighted, late, unreachable, mean slack. Live data trains
  nothing by itself.
- **Reuse the live models** (`core/fire.py`, `core/routing.py`, `core/slack.py`, `core/danger.py`, `core/reports.py`). They have
  no network or uAgents imports, so training and serving use the identical numbers.
- **Baselines for the comparison** are in `core/policy.py`: `NearestStationPolicy` (B0), `GreedyUrgencyPolicy` (B1),
  `LookaheadPolicy` (the default heuristic).
- **Real situations** the commander saw are in the public `situation` table: `agents/scripts/export_situations.py [--features]`
  writes JSONL (empty-world rows dropped).
- **Features:** `Situation.feature_vector()` is a starting point (`FEATURE_NAMES`, `FEATURE_VERSION` 3: fire, wind and
  humidity, news signals, nearest-station ETA and distance, data freshness, and four field-report counts). Change it freely,
  bump `FEATURE_VERSION`, and store the version with your model so training and serving agree.
- **Model files** can live anywhere; point to them with an env var of your choice (for example `RL_POLICY_PATH`) and load
  them in `__init__`. PyTorch and ONNX Runtime are not installed in the project venv; add what you need to
  `agents/requirements.txt`.

## Trying a policy without the agents

`rescue.planning.build_plan_input` turns plain row dicts into a `PlanInput`. [`agents/scripts/test_planning.py`](../agents/scripts/test_planning.py)
builds one by hand (an overloaded station, an unreachable request, locked and purged requests) and runs two policies on it. Copy
that pattern to unit-test yours:

```bash
cd agents && ../venv/bin/python scripts/test_planning.py     # existing checks
../venv/bin/python scripts/test_reports.py                   # report features, including how they reach the policy input
```

End to end against a running system: `scripts/send_report.py <lat> <lon> --resident alice --text "..."` plays a resident
pinging; the output shows the station and queue position your policy chose.

## Status

Done: SpacetimeDB module; the commander (head agent: reports, danger, planner) and its three subagents (hazard, news,
intake); freshness flags; situation export; health check. The `POLICY=rl` plug-in point is wired but **not yet exercised
with a real model**.

Not done / not yours: the RL model itself; unit missions (nothing advances a dispatched unit yet); the frontend. The road
network is the fire grid as a stand-in, the fire model is simplified, and the demo world is synthetic.

## If you change shared pieces

- A new column on a table that already has rows goes **last** with `.default(...)`, or `spacetime publish` refuses to migrate.
- Changing a message model in `rescue/messages.py` means restarting every agent together.
- Changing `Situation`: update `situation` and `SituationInput` in `spacetimedb/src/schema.ts` and the `record_situation`
  call, and bump `FEATURE_VERSION` if the vector changed.
