"""Reports engine: the commander's reading of residents' field reports.

The intake agent writes one report_assessment per request (claims extracted from text, voice, photos, video).
This engine weighs them against the hazard model and each other (core/reports.weigh) and hands the result to
the danger engine (fire ETA hints, access penalties, effective headcount / needs) and the planner (policy
features, plan reasons, Situation counts). Responders always see the raw reports and the assessment in
their console; there is no review queue, only the automatic queue order this engine feeds.

It also decides which new requests to HOLD out of the queue while the intake agent reads their reports, for
at most INTAKE_GRACE_S: a ping is analyzed before it is placed, but a slow or missing analyzer never blocks
a rescue."""
from __future__ import annotations

import time
from typing import TYPE_CHECKING

from ..config import settings
from ..core.danger import local_hazard
from ..core.geo import Grid
from ..core.reports import Claims, Weighed, corroboration, spot_radius_m, summarize, weigh

if TYPE_CHECKING:
    from ..agents.commander import CommanderAgent

ACTIVE = ("pending", "queued", "assigned", "en_route", "on_scene")


class ReportsEngine:
    def __init__(self, agent: "CommanderAgent") -> None:
        self.agent = agent
        self.weighed: dict[int, Weighed] = {}

    def _requests(self) -> list[dict]:
        return [r for r in self.agent.db.table("ops_request") if r["status"] in ACTIVE and not r["location_purged"]]

    def weigh_all(self) -> dict[int, Weighed]:
        """Re-weigh every active request that has an assessment. Cheap (one lookup per request)."""
        db = self.agent.db
        g_row, clock = db.table("grid").one(), db.table("sim_clock").one()
        reqs = {r["id"]: r for r in self._requests()}
        rows = [a for a in db.table("ops_assessment") if a["request_id"] in reqs]
        if not g_row or not clock or not rows:
            self.weighed = {}
            return self.weighed
        grid, now = Grid.from_row(g_row), clock["sim_s"]
        forecast = {r["cell_id"]: r["arrival_early_s"] for r in db.table("forecast_cell")}
        burning = {r["cell_id"] for r in db.table("fire_cell")}
        claims = [Claims.from_row(a, reqs[a["request_id"]]["lat"], reqs[a["request_id"]]["lon"]) for a in rows]
        corr = corroboration(claims)
        sit = self.agent.planner.latest
        head = sit.fire_head_kmh if sit and sit.fire_head_kmh > 0 else None
        spot = spot_radius_m(sit.wind_speed_mps) if sit else spot_radius_m(0.0)
        out = {}
        for c in claims:
            r = reqs[c.request_id]
            hz = local_hazard(grid, now, c.lat, c.lon, forecast, burning, spot) if grid.valid else None
            if hz is None:
                continue
            out[c.request_id] = weigh(c, r["headcount"], r["needs"], hz, corroborators=corr.get(c.request_id, 0), head_kmh=head)
        self.weighed = out
        return out

    def hold(self) -> tuple[set[int], float]:
        """Requests to keep out of the queue while their reports are read, and seconds until the next one
        is released (0 = none held)."""
        if settings.intake_grace_s <= 0:
            return set(), 0.0
        assessed = {a["request_id"] for a in self.agent.db.table("ops_assessment")}
        now, held, wait = time.time(), set(), 0.0
        for r in self._requests():
            age = now - r["created_at"] / 1e6
            if r["status"] == "pending" and r["id"] not in assessed and age < settings.intake_grace_s:
                held.add(r["id"])
                left = settings.intake_grace_s - age
                wait = left if not wait else min(wait, left)
        return held, wait

    def summary(self) -> dict:
        return summarize(list(self.weighed.values()))
