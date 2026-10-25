"""THE plug-in point for the RL component: implement `RLPolicy.plan`, run the agents with POLICY=rl.

The commander (head) agent calls `plan()` whenever the picture changes: a new request, a resident's field report being read,
a new danger assessment, a unit changing status. It already builds the input from the live database and publishes your output, so this file is all you edit.

INPUT  `PlanInput` (rescue/core/policy.py), everything the policy may know right now:
    inp.now_s        sim seconds since the scenario started
    inp.requests     list[RequestState]: id, headcount, needs, fire_eta_s (p10 forecast, absolute sim seconds),
                     extract_s, travel_s {station_id: seconds, inf = no safe route}, pinned_station (0 = free),
                     current_station (0 = not queued yet), created_s,
                     and from the resident's field reports (weighed by core/reports.py): credibility (0..1),
                     reported_urgency (0..1), trapped, injured, report_note. Accepted report effects are already in
                     headcount / needs / fire_eta_s / extract_s.
    inp.units        list[UnitState]: id, station_id, available, free_at_s (absolute sim seconds)
    inp.stations     {station_id: name}
    inp.margin_s     safety margin used in the slack formula
    inp.situation    Situation | None: fire / wind / news summary, with data freshness
                     (situation.feature_vector() is a ready-made 28-number encoding; FEATURE_NAMES lists them)

    slack of a request served by station s = fire_eta_s - (start + travel_s[s] + extract_s) - margin_s
    where start = when a unit of s is free. Negative slack = the fire arrives first.

OUTPUT `Plan` (rescue/core/policy.py):
    Plan(policy="rl", entries=[Assignment(...), ...], unreachable=[(request_id, detail, recommendation), ...])
    Assignment: request_id, station_id, rank (1 = first in that station's queue),
                unit_id (nonzero = dispatch that unit NOW, it must be available and belong to station_id; 0 = just queue),
                eta_s (absolute sim second you expect a unit on scene), reason (one line for the commander),
                resident_reason (coarse sentence shown to the resident: no formulas).
    `unreachable`: requests no unit can reach before the fire (the commander is asked for other resources).

You do not need to enforce: commander pins, units already committed to a request, or one-unit-per-request. The
database enforces those. Your output is also sanity-checked before it is published (unknown ids, non-finite ETAs
and duplicate requests are dropped and logged), so a bug in the model cannot corrupt the queues.

`plan()` runs in a worker thread and should return in about a second. If it raises, the commander agent reports
`degraded` with your error and keeps the last published plan.
"""
from __future__ import annotations

from .core.policy import Assignment, Plan, PlanInput  # noqa: F401  (Assignment is what you will build)


class RLPolicy:
    name = "rl"  # stored in queue_entry.policy, so you can see in the database which policy produced a queue

    def __init__(self) -> None:
        # Load your model here, once (e.g. weights = torch.jit.load(os.environ["RL_POLICY_PATH"])).
        pass

    def plan(self, inp: PlanInput) -> Plan:
        raise NotImplementedError("rescue/rl_policy.py: implement RLPolicy.plan, or run with POLICY=lookahead")
