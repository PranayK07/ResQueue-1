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
        "SELECT * FROM fire_risk_meta", "SELECT * FROM fire_risk_cell",
    ]

    def __init__(self) -> None:
        super().__init__("danger")
        self._published: dict[int, tuple] = {}  # request_id -> signature of the last published assessment
        self._debounce: Debouncer | None = None
        self.supplementary_risk: list[dict] = []
        self.supplementary_risk_state = "unavailable"

    async def on_ready(self, ctx: Context) -> None:
        self._debounce = Debouncer(self.assess, delay=0.3, min_interval=RECOMPUTE_MIN_S)
        self.db.on_update(["forecast_cell", "ops_request", "road_closure", "unit", "sim_clock", "grid",
                           "fire_risk_meta", "fire_risk_cell"], self._changed)
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
        self.supplementary_risk = []
        self.supplementary_risk_state = "unavailable"
        risk_meta = self.db.table("fire_risk_meta").one()
        if risk_meta:
            from ..forecast_ml.bridge import product_from_rows
            from ..forecast_ml.risk import assess_residents
            # Coarse UTC historical products may be displayed alongside this
            # simulation, but cannot be subtracted from its scenario clock.
            versions = self.db.table("world_version").one()
            fresh = (versions and risk_meta["weather_version"] == versions["weather"]
                     and risk_meta["fire_version"] == versions["fire"])
            self.supplementary_risk_state = "historical_clock_review" if fresh else "stale_snapshot_review"
            if fresh and risk_meta["time_basis"] == "simulation":
                try:
                    product = product_from_rows(risk_meta, list(self.db.table("fire_risk_cell")))
                    residents = []
                    for r in reqs:
                        cell = product.grid.locate(r["lat"], r["lon"])
                        if cell is not None:
                            a = next((a for a in assessments if a["request_id"] == r["id"]), None)
                            if a is None:
                                continue  # supplemental/routing domains can differ
                            residents.append({"request_id": r["id"], "lat": r["lat"], "lon": r["lon"],
                                              "cell_id": cell, "extract_s": a["extract_s"]})
                    routes = {rid: min(t["travel_s"] for t in ts if t["reachable"])
                              for rid, ts in by_req.items() if any(t["reachable"] for t in ts)}
                    self.supplementary_risk = assess_residents(product, residents, travel_s=routes, now_s=clock["sim_s"])
                    self.supplementary_risk_state = "coarse_risk_supplement"
                except (ValueError, KeyError, ImportError, RuntimeError, OverflowError) as exc:
                    self.supplementary_risk_state = "invalid_forecast_review"
                    self.log.warning("supplementary risk requires review: %s", type(exc).__name__)
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
            f"{n} {k}" for k in ("unreachable", "critical", "high", "moderate") if (n := levels.count(k)))
            + f"; supplementary risk: {self.supplementary_risk_state}")


if __name__ == "__main__":
    DangerAgent().run()
