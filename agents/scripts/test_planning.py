"""Plain-assert checks for rescue.planning and the policy seam. Run: ../venv/bin/python scripts/test_planning.py"""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rescue.core.policy import LookaheadPolicy, NearestStationPolicy  # noqa: E402
from rescue.planning import UNIT_BUSY_DEFAULT_S, build_plan_input, plan_signature, plan_to_reducer_args  # noqa: E402

NOW = 0.0
stations = [{"id": 1, "name": "A"}, {"id": 2, "name": "B"}]
units = [
    {"id": 1, "station_id": 1, "callsign": "A1", "status": "available", "free_at_s": 0.0},
    {"id": 2, "station_id": 2, "callsign": "B1", "status": "available", "free_at_s": 0.0},
    {"id": 3, "station_id": 2, "callsign": "B2", "status": "assigned", "free_at_s": 0.0},  # committed, free_at unknown
    {"id": 4, "station_id": 1, "callsign": "A2", "status": "out_of_service", "free_at_s": 0.0},
]


def req(i, status="pending", fire_eta=2400.0, purged=False, pinned=0):
    return {"id": i, "headcount": 2, "needs": "", "status": status, "fire_eta_s": fire_eta, "extract_s": 330.0,
            "pinned_station_id": pinned, "created_sim_s": 0.0, "location_purged": purged}


# 4 requests next to station A (5 min), station B is 15 min away: station A's one free unit is the bottleneck
requests = [req(i) for i in (1, 2, 3, 4)] + [
    req(5, status="assigned"),  # locked: the database's to keep
    req(6, fire_eta=None),  # not assessed by the danger agent yet
    req(7, purged=True),  # location deleted
]
travel = [{"request_id": r, "station_id": 1, "travel_s": 300.0, "reachable": True} for r in (1, 2, 3, 4, 5)]
travel += [{"request_id": r, "station_id": 2, "travel_s": 900.0, "reachable": True} for r in (1, 2, 3, 4, 5)]

inp = build_plan_input(NOW, requests, travel, units, stations, None, queue=[{"request_id": 2, "station_id": 1}])
assert [r.id for r in inp.requests] == [1, 2, 3, 4], [r.id for r in inp.requests]  # locked / unassessed / purged skipped
assert inp.requests[1].current_station == 1 and inp.requests[0].current_station == 0
assert {u.id for u in inp.units} == {1, 2, 3}  # out_of_service dropped
busy = next(u for u in inp.units if u.id == 3)
assert not busy.available and busy.free_at_s == NOW + UNIT_BUSY_DEFAULT_S  # unknown free_at -> assumed busy
assert inp.stations == {1: "A", 2: "B"} and inp.situation is None

nearest, look = NearestStationPolicy().plan(inp), LookaheadPolicy().plan(inp)
assert {e.station_id for e in nearest.entries} == {1}, "B0 sends everyone to the nearest station"
assert {e.station_id for e in look.entries} == {1, 2}, "lookahead spills the overload to station B"
assert sum(1 for e in look.entries if e.unit_id) == 2, "one dispatch per free unit, none for the busy unit"
assert all(e.unit_id != 3 for e in look.entries)

name, entries, unreachable = plan_to_reducer_args(look)
assert name == "lookahead" and not unreachable
assert set(entries[0]) == {"request_id", "station_id", "rank", "unit_id", "eta_s", "reason", "resident_reason"}
assert plan_signature(look) == plan_signature(LookaheadPolicy().plan(inp)) != plan_signature(nearest)

# an unreachable leg becomes inf, and a request nobody can reach is escalated rather than queued
dead = [{"request_id": 1, "station_id": s, "travel_s": 1e9, "reachable": False} for s in (1, 2)]
inp2 = build_plan_input(NOW, [req(1)], dead, units, stations)
assert all(math.isinf(v) for v in inp2.requests[0].travel_s.values())
plan2 = LookaheadPolicy().plan(inp2)
assert not plan2.entries and [u[0] for u in plan2.unreachable] == [1]
assert plan_to_reducer_args(plan2)[2][0]["request_id"] == 1
print("planning checks passed (build_plan_input, 2-station overload, unreachable escalation, reducer args)")


# ── validate_plan: a policy under development must not be able to corrupt the queues
def test_validate_plan():
    from rescue.core.policy import Assignment, Plan, PlanInput, RequestState, UnitState
    from rescue.planning import validate_plan
    inp = PlanInput(now_s=0.0, requests=[RequestState(1, 1, "", 3600.0, 300.0, {1: 100.0, 2: 200.0}),
                                         RequestState(2, 1, "", 3600.0, 300.0, {1: 100.0, 2: 200.0})],
                    units=[UnitState(1, 1, "E1", True, 0.0)], stations={1: "A", 2: "B"})
    mk = lambda rid, st, rank, eta=500.0: Assignment(rid, st, rank, 0, eta, "r", "rr")  # noqa: E731
    bad = Plan("rl", [mk(1, 1, 5), mk(99, 1, 1), mk(2, 7, 1), mk(2, 2, 3, float("inf")), mk(1, 2, 1)], [(99, "x", "y"), (1, "dup", "z")])
    clean, problems = validate_plan(inp, bad)
    assert [(e.request_id, e.station_id, e.rank) for e in clean.entries] == [(1, 1, 1), (2, 2, 1)], clean.entries
    assert all(e.eta_s < 1e10 for e in clean.entries) and clean.unreachable == [], clean.unreachable
    assert len(problems) == 4, problems
    print("validate_plan ok:", problems)


test_validate_plan()
