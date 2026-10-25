"""Pure translation between SpacetimeDB rows and the policy interface (no uAgents, no network).

    rows (ops_request, ops_travel, unit, station, ops_queue) + Situation  --build_plan_input-->  PlanInput
    Plan  --plan_to_reducer_args-->  arguments of the `publish_plan` reducer

This is the seam the RL workstream plugs into: a policy is anything with `.name` and `.plan(PlanInput) -> Plan`
(core/policy.py). The delegation agent calls build_plan_input, runs the policy, and publishes the result."""
from __future__ import annotations

import math
from collections.abc import Iterable

from .core.policy import Plan, PlanInput, RequestState, UnitState
from .core.situation import Situation

PLANNABLE = ("pending", "queued")  # a request whose unit is already committed is the database's to keep, not the policy's
# Until station agents report real free_at times, a unit that is not available is assumed busy this long.
UNIT_BUSY_DEFAULT_S = 1800.0


def build_plan_input(
    now_s: float,
    requests: Iterable[dict],
    travel: Iterable[dict],
    units: Iterable[dict],
    stations: Iterable[dict],
    situation: Situation | None = None,
    queue: Iterable[dict] = (),
) -> PlanInput:
    names = {s["id"]: s["name"] for s in stations}
    travel_by_req: dict[int, dict[int, float]] = {}
    for t in travel:
        if t["station_id"] in names:
            travel_by_req.setdefault(t["request_id"], {})[t["station_id"]] = t["travel_s"] if t["reachable"] else math.inf
    current = {q["request_id"]: q["station_id"] for q in queue}

    reqs = []
    for r in requests:
        if r["status"] not in PLANNABLE or r["location_purged"] or r["fire_eta_s"] is None or r["id"] not in travel_by_req:
            continue  # not assessed by the danger agent yet, or not the policy's to place
        legs = {sid: travel_by_req[r["id"]].get(sid, math.inf) for sid in names}
        reqs.append(RequestState(
            id=r["id"], headcount=r["headcount"], needs=r["needs"], fire_eta_s=r["fire_eta_s"], extract_s=r["extract_s"],
            travel_s=legs, pinned_station=r["pinned_station_id"], current_station=current.get(r["id"], 0),
            created_s=r["created_sim_s"],
        ))

    us = []
    for u in units:
        if u["status"] == "out_of_service" or u["station_id"] not in names:
            continue
        free = now_s if u["status"] == "available" else (u["free_at_s"] if u["free_at_s"] > now_s else now_s + UNIT_BUSY_DEFAULT_S)
        us.append(UnitState(id=u["id"], station_id=u["station_id"], callsign=u["callsign"], available=u["status"] == "available", free_at_s=free))
    return PlanInput(now_s=now_s, requests=reqs, units=us, stations=names, situation=situation)


def validate_plan(inp: PlanInput, plan: Plan) -> tuple[Plan, list[str]]:
    """Make a policy's output safe to publish; returns (clean plan, problems found).

    Drops entries for requests/stations that don't exist in `inp`, keeps only the first entry per request,
    renumbers ranks per station (1..n) in the order the policy gave, and replaces non-finite ETAs (which cannot be
    sent as JSON). The database separately enforces its own rules (commander pins, committed units, ...)."""
    problems: list[str] = []
    known = {r.id for r in inp.requests}
    seen: set[int] = set()
    kept = []
    for e in plan.entries:
        if e.request_id not in known:
            problems.append(f"unknown request {e.request_id}")
        elif e.station_id not in inp.stations:
            problems.append(f"request {e.request_id}: unknown station {e.station_id}")
        elif e.request_id in seen:
            problems.append(f"request {e.request_id} placed twice")
        else:
            seen.add(e.request_id)
            if not math.isfinite(e.eta_s):
                problems.append(f"request {e.request_id}: ETA is {e.eta_s}")
                e.eta_s = 1e9
            kept.append(e)
    per_station: dict[int, int] = {}
    for e in sorted(kept, key=lambda x: (x.station_id, x.rank)):
        per_station[e.station_id] = per_station.get(e.station_id, 0) + 1
        e.rank = per_station[e.station_id]
    unreachable = [(rid, d, rec) for rid, d, rec in plan.unreachable if rid in known and rid not in seen]
    return Plan(policy=plan.policy, entries=kept, unreachable=unreachable), problems


def plan_to_reducer_args(plan: Plan) -> tuple[str, list[dict], list[dict]]:
    entries = [{"request_id": e.request_id, "station_id": e.station_id, "rank": e.rank, "unit_id": e.unit_id,
                "eta_s": round(e.eta_s, 1), "reason": e.reason, "resident_reason": e.resident_reason} for e in plan.entries]
    unreachable = [{"request_id": rid, "detail": detail, "recommendation": rec} for rid, detail, rec in plan.unreachable]
    return plan.policy, entries, unreachable


def plan_signature(plan: Plan) -> tuple:
    """What matters for 'did the plan change?': who goes to which station, in what order, with which unit."""
    return (tuple(sorted((e.request_id, e.station_id, e.rank, e.unit_id) for e in plan.entries)),
            tuple(sorted(rid for rid, _, _ in plan.unreachable)))
