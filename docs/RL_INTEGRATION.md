# Connecting the RL component

**Edit one file: [`agents/rescue/rl_policy.py`](../agents/rescue/rl_policy.py). Run the agents with `POLICY=rl`.**

The agent system already scores every help request for danger and keeps the per-station queues. It hands your code the
current picture, takes back an ordered assignment, and publishes it. You don't need to touch agents, the database or the frontend.

## The contract

```python
class RLPolicy:
    def plan(self, inp: PlanInput) -> Plan: ...
```

**You receive** (`agents/rescue/core/policy.py`, `core/situation.py`):

| Field | Meaning |
|---|---|
| `inp.requests` | each pending request: `headcount`, `needs`, `fire_eta_s` (p10, absolute sim seconds), `extract_s`, `travel_s[station]` (inf = no safe route), `pinned_station`, `current_station` |
| `inp.units` | each unit: `station_id`, `available`, `free_at_s` |
| `inp.stations` | `{id: name}` |
| `inp.now_s`, `inp.margin_s` | sim clock, safety margin |
| `inp.situation` | fire, wind and news summary **with data freshness**: `situation.feature_vector()` is a 24-number encoding (`FEATURE_NAMES`, `FEATURE_VERSION`); `wind_observed_at`, `wind_age_min`, `data_fresh`, `stale_reasons` say how old the inputs are |

Slack of a request served by station `s` = `fire_eta_s - (unit free + travel_s[s] + extract_s) - margin_s`. Negative = the fire arrives first.

**You return** a `Plan`: one `Assignment` per request (`station_id`, `rank` in that station's queue, `unit_id` to dispatch now or 0,
`eta_s`, a one-line `reason`, a resident-facing `resident_reason`), plus `unreachable` for requests no unit can reach in time.
The full field list is in the docstring of `rl_policy.py`.

You do **not** enforce commander pins, units already committed, or one-unit-per-request: the database does. Your output is also
sanity-checked before publishing (unknown ids, duplicate requests, non-finite ETAs are dropped and logged), and if `plan()`
raises, the delegation agent shows `degraded` with your error and keeps the last plan. A bug in the model can't corrupt the queues.

## Run it

```bash
python3.13 -m venv venv && venv/bin/pip install -r agents/requirements.txt
cp .env.example .env                          # set secrets; STDB_SERVER=local for offline work
# in .env: POLICY=rl   (default is POLICY=lookahead, a placeholder heuristic so the pipeline runs without a model)
MAILBOX_AGENTS=none scripts/dev.sh reset      # local SpacetimeDB + module + demo scenario + all agents
cd agents && ../venv/bin/python scripts/check_mesh.py       # PASS/WARN/FAIL for the pipeline
```

Needs the SpacetimeDB CLI: `curl -sSf https://install.spacetimedb.com | sh`. `NEWS_SOURCE=file` (the default) never calls Bright Data.

See your output: `spacetime sql --server local wildfire-rescue "SELECT request_id, station_id, rank, unit_id, policy FROM queue_entry"`
(the `policy` column shows `rl`). Re-planning happens on every new request, danger update or unit change; plans are only
published when they actually changed.

## Training and evaluation (your side)

- Train **offline in your simulator**: build `PlanInput` / `Situation` from it, score plans with `core.policy.evaluate()`.
  Live data doesn't train anything.
- B0 / B1 baselines (`NearestStationPolicy`, `GreedyUrgencyPolicy`) are in `core/policy.py` for the comparison the design doc asks for.
  `LookaheadPolicy` is only the default placeholder.
- The live models (`core/fire.py`, `routing.py`, `slack.py`) are importable without any network code: reuse them so training matches serving.
- Real situations the head agent saw are in the `situation` table: `agents/scripts/export_situations.py [--features]` writes JSONL
  (drops empty-world rows).

## Status

Done: SpacetimeDB module; hazard, news, danger and delegation agents; commander and intake (ASI:One); freshness; export; health check.
**Not done / not yours:** the station agents (missions don't progress after a dispatch), the frontend, the resident-facing agent,
the RL model itself. The road network is the fire grid as a stand-in; the fire model is simplified; the demo world is synthetic.
The plug-in path (`POLICY=rl`) is wired but not yet exercised with a real model.

## If you change shared pieces

- A new column on a table that already has rows goes **last** with `.default(...)`, or `spacetime publish` refuses to migrate.
- Changing a message model in `rescue/messages.py` means restarting every agent together.
- Changing `Situation`: update `situation` in `spacetimedb/src/schema.ts` and `SituationInput`, and bump `FEATURE_VERSION` if the vector changed.
