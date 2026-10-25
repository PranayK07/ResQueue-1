"""Danger agent: slack + danger level for every active request, and request-to-station travel times.

On any change to the forecast, requests, road closures, units or the clock it recomputes (debounced: a growing
fire or a ticking clock triggers at most one run every few seconds), using core.danger.assess_requests, and
publishes only the requests whose result moved by a meaningful amount (publish_danger).

    slack = fire_eta(p10 forecast) - (now + travel + extract) - margin
"""
from __future__ import annotations

import asyncio

from uagents import Context

from ..core.danger import assess_requests
from ..core.geo import Grid
from ..stdb import Debouncer
from .base import MeshAgent

ACTIVE = ("pending", "queued", "assigned", "en_route", "on_scene")
RECOMPUTE_MIN_S = 5.0
QUANT_S = 60.0  # slack ticks down every second of sim time; only republish when it moved by about a minute
CHUNK = 100


class DangerAgent(MeshAgent):
    queries = [
        "SELECT * FROM sim_clock", "SELECT * FROM grid", "SELECT * FROM station", "SELECT * FROM unit",
        "SELECT * FROM fire_cell", "SELECT * FROM forecast_cell", "SELECT * FROM road_closure",
        "SELECT * FROM ops_request", "SELECT * FROM world_version",
    ]

    def __init__(self) -> None:
        super().__init__("danger")
        self._published: dict[int, tuple] = {}  # request_id -> signature of the last published assessment
        self._debounce: Debouncer | None = None

    async def on_ready(self, ctx: Context) -> None:
        self._debounce = Debouncer(self.assess, delay=0.3, min_interval=RECOMPUTE_MIN_S)
        self.db.on_update(["forecast_cell", "ops_request", "road_closure", "unit", "sim_clock", "grid"], self._changed)
        self._debounce.trigger()

    def _changed(self, upd) -> None:
        if upd.touched("grid"):
            self._published.clear()  # new scenario
        if self._debounce:
            self._debounce.trigger()

    async def assess(self) -> None:
        if not self.ready.is_set():
            return
        g_row, clock = self.db.table("grid").one(), self.db.table("sim_clock").one()
        if not g_row or not clock:
            return
        grid = Grid.from_row(g_row)
        stations = [(s["id"], s["lat"], s["lon"]) for s in self.db.table("station")]
        reqs = [r for r in self.db.table("ops_request") if r["status"] in ACTIVE and not r["location_purged"]]
        if not grid.valid or not stations:
            return
        self._published = {k: v for k, v in self._published.items() if k in {r["id"] for r in reqs}}
        if not reqs:
            self.set_status("online", "no active requests")
            return

        forecast = {r["cell_id"]: r["arrival_early_s"] for r in self.db.table("forecast_cell")}
        burning = {r["cell_id"] for r in self.db.table("fire_cell")}
        closures = [(c["lat1"], c["lon1"], c["lat2"], c["lon2"]) for c in self.db.table("road_closure") if c["active"]]
        points = [(r["id"], r["lat"], r["lon"], r["headcount"], r["needs"]) for r in reqs]
        assessments, travel = await asyncio.to_thread(
            assess_requests, grid, clock["sim_s"], points, stations, forecast, burning, closures)

        by_req: dict[int, list[dict]] = {}
        for t in travel:
            by_req.setdefault(t["request_id"], []).append(t)
        changed_a, changed_t, sigs = [], [], {}
        for a in assessments:
            ts = by_req.get(a["request_id"], [])
            sig = (a["level"], round(a["slack_s"] / QUANT_S), round(a["fire_eta_s"] / QUANT_S),
                   tuple(-1 if not t["reachable"] else round(t["travel_s"] / QUANT_S) for t in ts))
            if self._published.get(a["request_id"]) != sig:
                changed_a.append(a)
                changed_t += ts
                sigs[a["request_id"]] = sig
        for i in range(0, len(changed_a), CHUNK):
            part = changed_a[i:i + CHUNK]
            ids = {a["request_id"] for a in part}
            if await self.db.try_call("publish_danger", part, [t for t in changed_t if t["request_id"] in ids]):
                self._published.update({rid: sigs[rid] for rid in ids})
        levels = [a["level"] for a in assessments]
        self.set_status("online", f"{len(assessments)} requests assessed: " + ", ".join(
            f"{n} {k}" for k in ("unreachable", "critical", "high", "moderate") if (n := levels.count(k))))


if __name__ == "__main__":
    DangerAgent().run()
