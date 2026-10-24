"""Delegation policies: who goes in which station's queue, in what order.

This is THE interface between the live system and the RL work:

* the delegation agent builds a `PlanInput` from SpacetimeDB and calls
  `policy.plan(inp)`; the returned `Plan` is published atomically;
* the Gym environment should build the same `PlanInput` from its simulator
  and score plans with `evaluate()`, so training and the live demo optimise
  the identical objective.

Policies here:
  B0  NearestStationPolicy   – nearest station, sort by slack
  B1  GreedyUrgencyPolicy    – most urgent request -> unit that arrives first
  LookaheadPolicy (default)  – urgency order, cross-station insertion,
                               skips hopeless requests so units aren't wasted,
                               then a pairwise-swap improvement pass
  LearnedPolicy              – loads a trained model (RL_POLICY_PATH); falls
                               back to LookaheadPolicy if unavailable
"""
from __future__ import annotations

import heapq
import logging
import math
import os
from dataclasses import dataclass, field
from typing import Protocol

from .slack import MARGIN_S, fmt_min, vulnerability

log = logging.getLogger("policy")
INF = math.inf


# ─── State ──────────────────────────────────────────────────────────────────

@dataclass
class RequestState:
    id: int
    headcount: int
    needs: str
    fire_eta_s: float  # absolute sim second (p10)
    extract_s: float
    travel_s: dict[int, float]  # station_id -> seconds (inf = no safe route)
    pinned_station: int = 0
    current_station: int = 0  # station whose queue it is in now (0 = none)
    created_s: float = 0.0

    @property
    def weight(self) -> float:
        return vulnerability(self.headcount, self.needs)


@dataclass
class UnitState:
    id: int
    station_id: int
    callsign: str
    available: bool  # status == available right now
    free_at_s: float  # absolute sim second it is back at its station


@dataclass
class PlanInput:
    now_s: float
    requests: list[RequestState]
    units: list[UnitState]
    stations: dict[int, str]  # id -> name
    margin_s: float = MARGIN_S


@dataclass
class Assignment:
    request_id: int
    station_id: int
    rank: int
    unit_id: int  # nonzero only if a unit should be dispatched NOW
    eta_s: float  # absolute sim second the unit is projected on scene
    reason: str
    resident_reason: str


@dataclass
class Plan:
    policy: str
    entries: list[Assignment] = field(default_factory=list)
    unreachable: list[tuple[int, str, str]] = field(default_factory=list)  # (request_id, detail, recommendation)


class Policy(Protocol):
    name: str

    def plan(self, inp: PlanInput) -> Plan: ...


# ─── Shared simulation of a station's unit timeline ─────────────────────────

class _Timeline:
    """Per-station min-heap of (free_at, unit_id)."""

    def __init__(self, inp: PlanInput):
        self.now = inp.now_s
        self.heaps: dict[int, list[tuple[float, int]]] = {s: [] for s in inp.stations}
        self.available_now: set[int] = set()
        for u in inp.units:
            free = inp.now_s if u.available else max(u.free_at_s, inp.now_s)
            self.heaps.setdefault(u.station_id, []).append((free, u.id))
            if u.available:
                self.available_now.add(u.id)
        for h in self.heaps.values():
            heapq.heapify(h)

    def peek(self, station: int) -> tuple[float, int] | None:
        h = self.heaps.get(station)
        return h[0] if h else None

    def arrival(self, station: int, r: RequestState) -> tuple[float, float, int]:
        """(arrive_s, depart_s, unit_id) if served next by `station`."""
        top = self.peek(station)
        travel = r.travel_s.get(station, INF)
        if top is None or travel == INF:
            return INF, INF, 0
        depart, uid = top
        return depart + travel, depart, uid

    def commit(self, station: int, r: RequestState) -> tuple[float, float, int]:
        arrive, depart, uid = self.arrival(station, r)
        heapq.heapreplace(self.heaps[station], (arrive + r.extract_s + r.travel_s[station], uid))
        return arrive, depart, uid


def _saved(r: RequestState, arrive: float, margin: float) -> bool:
    return arrive + r.extract_s + margin <= r.fire_eta_s


def _slack(r: RequestState, arrive: float, margin: float) -> float:
    return r.fire_eta_s - (arrive + r.extract_s) - margin


def _nearest(r: RequestState) -> int:
    reachable = {s: t for s, t in r.travel_s.items() if t < INF}
    return min(reachable, key=reachable.get) if reachable else 0


def _best_case(r: RequestState, inp: PlanInput) -> float:
    """Slack if the closest station dispatched immediately."""
    t = min(r.travel_s.values(), default=INF)
    return _slack(r, inp.now_s + t, inp.margin_s)


def _station_options(r: RequestState, tl: _Timeline, inp: PlanInput) -> list[tuple[float, int]]:
    opts = []
    for s in inp.stations:
        if r.pinned_station and s != r.pinned_station:
            continue
        arrive, _, _ = tl.arrival(s, r)
        opts.append((arrive, s))
    return sorted(opts)


def _finalise(policy: str, inp: PlanInput, order: list[tuple[RequestState, int, float, float, int]], unreachable) -> Plan:
    """order: (request, station, arrive, depart, unit) in service order."""
    plan = Plan(policy=policy, unreachable=unreachable)
    rank: dict[int, int] = {}
    dispatched: set[int] = set()
    for r, s, arrive, depart, uid in order:
        rank[s] = rank.get(s, 0) + 1
        dispatch = uid if (depart <= inp.now_s + 1e-6 and uid not in dispatched) else 0
        if dispatch:
            dispatched.add(uid)
        nearest = _nearest(r)
        why = [f"fire in {fmt_min(r.fire_eta_s - inp.now_s)}", f"on scene in {fmt_min(arrive - inp.now_s)}"]
        resident = f"You are #{rank[s]} in {inp.stations[s]}'s queue."
        if nearest and nearest != s:
            why.append(f"{inp.stations[nearest]} is busy/later, {inp.stations[s]} gets there sooner")
            resident += f" {inp.stations[s]} can reach you sooner than the nearest station."
        if r.pinned_station:
            why.append("pinned by commander")
        slack = _slack(r, arrive, inp.margin_s)
        resident += " Fire risk at your location is " + ("very high." if slack < 600 else "high." if slack < 1800 else "moderate.")
        plan.entries.append(Assignment(
            request_id=r.id, station_id=s, rank=rank[s], unit_id=dispatch, eta_s=arrive,
            reason=f"slack {fmt_min(slack)}: " + "; ".join(why), resident_reason=resident,
        ))
    return plan


# ─── Policies ───────────────────────────────────────────────────────────────

class NearestStationPolicy:
    """B0: each request to its nearest station, served in order of slack."""

    name = "B0-nearest"

    def plan(self, inp: PlanInput) -> Plan:
        tl = _Timeline(inp)
        reqs = sorted(inp.requests, key=lambda r: _best_case(r, inp))
        order, unreachable = [], []
        for r in reqs:
            s = r.pinned_station or _nearest(r)
            if not s:
                unreachable.append((r.id, "no safe ground route", "Request air support or shelter-in-place guidance"))
                continue
            order.append((r, s, *tl.commit(s, r)))
        return _finalise(self.name, inp, order, unreachable)


class GreedyUrgencyPolicy:
    """B1: most urgent request first, to whichever station's unit arrives first."""

    name = "B1-greedy"

    def plan(self, inp: PlanInput) -> Plan:
        tl = _Timeline(inp)
        reqs = sorted(inp.requests, key=lambda r: _best_case(r, inp))
        order, unreachable = [], []
        for r in reqs:
            opts = _station_options(r, tl, inp)
            if not opts or opts[0][0] == INF:
                unreachable.append((r.id, "no safe ground route", "Request air support or shelter-in-place guidance"))
                continue
            s = opts[0][1]
            order.append((r, s, *tl.commit(s, r)))
        return _finalise(self.name, inp, order, unreachable)


class LookaheadPolicy:
    """Default heuristic. Differences from B1:
    1. requests nobody can reach in time even with an immediate dispatch are
       escalated instead of consuming a unit that could save someone else;
    2. among savable requests, picks the station that saves it with the most
       slack *after* accounting for each station's backlog (cross-station
       reassignment under load);
    3. a swap pass reorders adjacent requests in a station queue when that
       saves more weighted people."""

    name = "lookahead"

    def plan(self, inp: PlanInput) -> Plan:
        reqs = sorted(inp.requests, key=lambda r: (_best_case(r, inp), -r.weight))
        hopeless = [r for r in reqs if _best_case(r, inp) < 0]
        savable = [r for r in reqs if _best_case(r, inp) >= 0]
        unreachable = [
            (r.id,
             "no safe ground route" if min(r.travel_s.values(), default=INF) == INF
             else f"fire arrives {fmt_min(-_best_case(r, inp))} before the fastest possible ground rescue",
             "Request air support / alternate resource; push shelter-in-place guidance")
            for r in hopeless
        ]

        tl = _Timeline(inp)
        chosen: dict[int, list[RequestState]] = {s: [] for s in inp.stations}
        late: list[RequestState] = []
        for r in savable:
            opts = _station_options(r, tl, inp)
            saving = [(a, s) for a, s in opts if _saved(r, a, inp.margin_s)]
            if saving:
                # most slack left wins; tie -> the station with less backlog
                s = min(saving, key=lambda x: (x[0], len(chosen[x[1]])))[1]
            elif opts and opts[0][0] < INF:
                late.append(r)
                continue
            else:
                unreachable.append((r.id, "no safe ground route", "Request air support or shelter-in-place guidance"))
                continue
            tl.commit(s, r)
            chosen[s].append(r)
        # Late-but-reachable requests still get queued (best effort, last).
        for r in late:
            opts = _station_options(r, tl, inp)
            s = opts[0][1]
            tl.commit(s, r)
            chosen[s].append(r)

        for s in chosen:
            chosen[s] = self._improve(inp, s, chosen[s])

        # Re-simulate final order to get consistent ETAs and dispatches.
        tl = _Timeline(inp)
        order = []
        for s, queue in chosen.items():
            for r in queue:
                order.append((r, s, *tl.commit(s, r)))
        order.sort(key=lambda x: (x[1], x[2]))
        return _finalise(self.name, inp, order, unreachable)

    def _improve(self, inp: PlanInput, s: int, queue: list[RequestState]) -> list[RequestState]:
        def score(q: list[RequestState]) -> float:
            sub = PlanInput(inp.now_s, q, [u for u in inp.units if u.station_id == s], {s: inp.stations[s]}, inp.margin_s)
            tl = _Timeline(sub)
            total = 0.0
            for r in q:
                arrive, _, _ = tl.commit(s, r)
                total += r.weight if _saved(r, arrive, inp.margin_s) else 0.0
            return total

        best = score(queue)
        improved = True
        while improved:
            improved = False
            for i in range(len(queue) - 1):
                cand = queue[:i] + [queue[i + 1], queue[i]] + queue[i + 2:]
                sc = score(cand)
                if sc > best + 1e-9:
                    queue, best, improved = cand, sc, True
        return queue


class LearnedPolicy:
    """Wraps a trained model from the RL workstream.

    Contract for the model (TorchScript at RL_POLICY_PATH): given a feature
    tensor per (request, station) pair, return a score; higher = serve sooner
    from that station. Features are built by `features()` below so the Gym
    env and the live agent agree. Until a model exists this delegates to
    LookaheadPolicy and says so in `name`."""

    def __init__(self, path: str | None = None):
        self.fallback = LookaheadPolicy()
        self.model = None
        self.name = "lookahead(fallback)"
        path = path or os.environ.get("RL_POLICY_PATH", "")
        if not path:
            return
        try:
            import torch  # noqa: PLC0415 - optional dependency

            self.model = torch.jit.load(path)
            self.model.eval()
            self.name = f"learned:{os.path.basename(path)}"
        except Exception as e:  # noqa: BLE001
            log.warning("could not load RL policy %s (%s); using lookahead", path, e)

    @staticmethod
    def features(inp: PlanInput, r: RequestState, station: int, tl: _Timeline) -> list[float]:
        arrive, depart, _ = tl.arrival(station, r)
        return [
            min(r.fire_eta_s - inp.now_s, 6 * 3600) / 3600,
            min(r.travel_s.get(station, INF), 7200) / 3600,
            min(depart - inp.now_s, 7200) / 3600 if depart < INF else 2.0,
            _slack(r, arrive, inp.margin_s) / 3600 if arrive < INF else -2.0,
            r.extract_s / 3600,
            r.weight / 10,
            1.0 if r.current_station == station else 0.0,
            1.0 if r.pinned_station == station else 0.0,
        ]

    def plan(self, inp: PlanInput) -> Plan:
        if self.model is None:
            return self.fallback.plan(inp)
        import torch  # noqa: PLC0415

        tl = _Timeline(inp)
        pending = list(inp.requests)
        order, unreachable = [], []
        while pending:
            cands = [(r, s) for r in pending for s in inp.stations
                     if r.travel_s.get(s, INF) < INF and (not r.pinned_station or s == r.pinned_station)]
            if not cands:
                unreachable += [(r.id, "no safe ground route", "Request air support") for r in pending]
                break
            with torch.no_grad():
                x = torch.tensor([self.features(inp, r, s, tl) for r, s in cands], dtype=torch.float32)
                scores = self.model(x).flatten().tolist()
            (r, s), _ = max(zip(cands, scores), key=lambda z: z[1])
            order.append((r, s, *tl.commit(s, r)))
            pending.remove(r)
        return _finalise(self.name, inp, order, unreachable)


POLICIES: dict[str, type] = {
    "nearest": NearestStationPolicy,
    "greedy": GreedyUrgencyPolicy,
    "lookahead": LookaheadPolicy,
    "learned": LearnedPolicy,
}


# ─── Evaluation (shared with the RL scoreboard) ─────────────────────────────

@dataclass
class PlanScore:
    policy: str
    people_in_time: int
    weighted_in_time: float
    late: int
    unreachable: int
    mean_slack_min: float


def evaluate(inp: PlanInput, plan: Plan) -> PlanScore:
    """Static projection of a plan: who is reached before the fire (p10)."""
    by_id = {r.id: r for r in inp.requests}
    people = 0
    weighted = 0.0
    late = 0
    slacks = []
    for e in plan.entries:
        r = by_id[e.request_id]
        s = _slack(r, e.eta_s, inp.margin_s)
        slacks.append(s)
        if s >= 0:
            people += r.headcount
            weighted += r.weight
        else:
            late += 1
    return PlanScore(plan.policy, people, weighted, late, len(plan.unreachable),
                     (sum(slacks) / len(slacks) / 60) if slacks else 0.0)
