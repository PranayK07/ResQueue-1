"""Danger engine: slack + danger level for every active request, and request-to-station travel times.

On any change to the forecast, requests, field-report assessments, road closures, units or the clock it
recomputes (debounced: a growing fire or a ticking clock triggers at most one run every few seconds), using
core.danger.assess_requests with what the reports engine accepted from residents (effective headcount /
needs, an earlier fire ETA for a credible sighting, extra on-scene time for a blocked road), and publishes
only the requests whose result moved by a meaningful amount (publish_danger).

    slack = fire_eta(p10 forecast, or a credible report's, whichever is sooner) - (now + travel + extract) - margin
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from ..core.danger import assess_requests, routing_forecast_current
from ..core.geo import Grid
from ..core.risk import compose_risks, news_context, risk_snapshot
from ..stdb import Debouncer
from ..planning import risk_to_reducer_args

if TYPE_CHECKING:
    from ..agents.commander import CommanderAgent

ACTIVE = ("pending", "queued", "assigned", "en_route", "on_scene")
RECOMPUTE_MIN_S = 5.0
CHUNK = 100
WATCH = ["forecast_cell", "ops_request", "ops_assessment", "road_closure", "unit", "sim_clock", "grid", "fire_risk_meta", "fire_risk_cell", "risk_pipeline"]


class DangerEngine:
    def __init__(self, agent: "CommanderAgent") -> None:
        self.agent = agent
        self._published: dict[int, str] = {}  # request_id -> signature of the last published assessment
        self._debounce: Debouncer | None = None

    def on_ready(self) -> None:
        self._debounce = Debouncer(self.assess, delay=0.3, min_interval=RECOMPUTE_MIN_S)
        self.agent.db.on_update(WATCH, self._changed)
        self._debounce.trigger()

    def _changed(self, upd) -> None:
        if upd.resync or upd.touched("grid"):
            self._published.clear()  # new scenario
        if self._debounce:
            self._debounce.trigger()

    async def assess(self) -> None:
        a, db = self.agent, self.agent.db
        if not a.ready.is_set():
            return
        g_row, clock = db.table("grid").one(), db.table("sim_clock").one()
        if not g_row or not clock:
            return
        grid = Grid.from_row(g_row)
        stations = [(s["id"], s["lat"], s["lon"]) for s in db.table("station")]
        reqs = [r for r in db.table("ops_request") if r["status"] in ACTIVE and not r["location_purged"]]
        if not grid.valid or not stations:
            return
        self._published = {k: v for k, v in self._published.items() if k in {r["id"] for r in reqs}}
        if not reqs:
            a.set_part("danger", "online", "no active requests")
            return

        versions = dict(db.table("world_version").one())
        fm = db.table("forecast_meta").one()
        if not fm or fm["weather_version"] != versions["weather"] or fm["fire_version"] != versions["fire"]:
            a.set_part("danger", "degraded", "waiting for physical forecast matching current fire/weather")
            return
        if not routing_forecast_current(fm, clock["sim_s"]):
            a.set_part("danger", "degraded", "routing forecast expired; awaiting a new observation or forecast")
            return
        units = list(db.table("unit"))
        meta, pipeline = db.table("fire_risk_meta").one(), db.table("risk_pipeline").one()
        snapshot = risk_snapshot(clock["sim_s"], clock["scenario"], versions, units, meta, pipeline)
        weighed = a.reports.weigh_all()
        forecast = {r["cell_id"]: r["arrival_early_s"] for r in db.table("forecast_cell")}
        burning = {r["cell_id"] for r in db.table("fire_cell")}
        closures = [(c["lat1"], c["lon1"], c["lat2"], c["lon2"]) for c in db.table("road_closure") if c["active"]]
        points = []
        for r in reqs:
            w = weighed.get(r["id"])
            points.append((r["id"], r["lat"], r["lon"], w.headcount if w else r["headcount"], w.needs if w else r["needs"]))
        adjust = {rid: (w.fire_eta_hint_s, w.access_penalty_s) for rid, w in weighed.items()}
        assessments, travel = await asyncio.to_thread(
            assess_requests, grid, clock["sim_s"], points, stations, forecast, burning, closures, adjust=adjust)

        risks = await asyncio.to_thread(compose_risks, snapshot, reqs, assessments, travel, units, weighed,
                                        meta=meta, cells=list(db.table("fire_risk_cell")), pipeline=pipeline,
                                        context=news_context(a.planner.latest))
        sigs = {r["request_id"]: r["assessment_id"] for r in risks}
        changed = [r for r in risks if self._published.get(r["request_id"]) != sigs[r["request_id"]]]
        for i in range(0, len(changed), CHUNK):
            part = changed[i:i + CHUNK]
            ids = {r["request_id"] for r in part}
            if await db.try_call("publish_risk_assessments", *risk_to_reducer_args(
                    snapshot, part, [t for t in travel if t["request_id"] in ids])):
                self._published.update({rid: sigs[rid] for rid in ids})
                a.log.info("risk transfer committed scenario=%s requests=%d forecast=%s",
                           snapshot["scenario"], len(ids), part[0]["forecast_id"])
            elif self._debounce:
                self._debounce.trigger()  # reconnects and racing updates must not lose an assessment
        levels = [d["level"] for d in assessments]
        a.set_part("danger", "online", f"{len(assessments)} requests assessed: " + ", ".join(
            f"{n} {k}" for k in ("unreachable", "critical", "high", "moderate") if (n := levels.count(k)))
            + (f"; {len(weighed)} with field reports" if weighed else ""))
