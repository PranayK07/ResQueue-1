"""Fire engine: owns the fire perimeter (`fire_cell`).

Each sim tick it ignites the cells the fire has reached, using a ground-truth
arrival field recomputed whenever the wind changes or new fire is observed.

  FIRE_SOURCE=sim    simulated spread from the scenario's ignition points
  FIRE_SOURCE=firms  NASA FIRMS satellite detections are injected as they
                     "happen" (historical replay via FIRMS_DATE, or latest
                     passes) and the model spreads fire between passes
"""
from __future__ import annotations

import asyncio
import math
import time
from collections import deque
from typing import TYPE_CHECKING

import numpy as np
from uagents import Context

from ..config import settings
from ..core.fire import FUEL_SEED, FireParams, FuelMap, Wind, ignite_due, truth_arrival
from ..core.geo import Grid, compass, haversine_m
from ..data import firms
from ..messages import FireReport, StationThreat
from ..stdb import Update

if TYPE_CHECKING:
    from ..agents.hazard import HazardAgent

TRUTH_HORIZON_S = 12 * 3600.0


class FireEngine:
    def __init__(self, host: "HazardAgent") -> None:
        self.host = host
        self.db = host.db
        self.log = host.log
        self.params = FireParams()
        self.grid: Grid | None = None
        self.fuel: FuelMap | None = None
        self.truth: np.ndarray | None = None
        self.burning: dict[int, float] = {}
        self.dirty = True
        self.history: deque[tuple[float, int]] = deque(maxlen=400)  # (sim_s, burning cells)
        self.detections: list[tuple[float, int, float]] = []  # pending FIRMS injections (sim_s, cell, intensity)
        self.last_detection = ""
        self._busy = False

    async def on_ready(self, ctx: Context) -> None:
        self.db.on_update(["grid", "weather", "fire_cell"], self._changed)
        self._reset()
        if settings.fire_source == "firms":
            await self._load_firms(ctx)
        ctx.logger.info(f"fire source={settings.fire_source}, burning={len(self.burning)}")

    def _changed(self, upd: Update) -> None:
        if upd.resync or upd.touched("grid"):
            self._reset()
            return
        if upd.touched("weather"):
            self.dirty = True
        if upd.touched("fire_cell"):
            delta = upd.tables["fire_cell"]
            if any(r["cell_id"] not in self.burning for r in delta.inserts):
                self.dirty = True  # someone else (seed / commander) added fire
            for r in delta.inserts:
                self.burning[r["cell_id"]] = r["ignited_s"]
            if len(delta.deletes) > len(delta.inserts):  # scenario reset / replace
                self.burning = {r["cell_id"]: r["ignited_s"] for r in self.db.table("fire_cell")}
                self.dirty = True

    def _reset(self) -> None:
        row = self.db.table("grid").one()
        self.grid = Grid.from_row(row) if row else None
        if self.grid and self.grid.valid:
            self.fuel = FuelMap.uniform(self.grid, seed=FUEL_SEED)
        self.burning = {r["cell_id"]: r["ignited_s"] for r in self.db.table("fire_cell")}
        self.truth = None
        self.dirty = True
        self.history.clear()

    async def _load_firms(self, ctx: Context) -> None:
        if not (self.grid and self.grid.valid):
            return
        if not settings.firms_map_key:
            ctx.logger.warning("FIRE_SOURCE=firms but FIRMS_MAP_KEY is empty; using simulated spread only")
            return
        try:
            dets = await firms.fetch(settings.firms_map_key, settings.firms_product, self.grid.bbox(),
                                     settings.firms_days, settings.firms_date)
        except Exception as e:  # noqa: BLE001 - feed failures must not kill the agent
            ctx.logger.error(f"FIRMS fetch failed: {e}")
            self.host.set_part("fire", "degraded", f"FIRMS unavailable: {e}"[:120])
            return
        inside = [(d, self.grid.locate(d.lat, d.lon)) for d in dets]
        inside = [(d, c) for d, c in inside if c is not None]
        if not inside:
            ctx.logger.warning(f"FIRMS returned {len(dets)} detections, none inside the grid")
            return
        t0 = inside[0][0].at
        # Replay: first detection = sim T+0; live: everything is "now".
        self.detections = sorted(
            ((d.at - t0).total_seconds() if settings.firms_date else 0.0, c, min(1.0, d.frp / 50 + 0.3))
            for d, c in inside
        )
        ctx.logger.info(f"FIRMS: {len(self.detections)} detections in grid ({settings.firms_product} {settings.firms_date or 'latest'})")

    async def tick(self) -> None:
        if self._busy or not (self.grid and self.grid.valid and self.fuel) or not self.db.identity:
            return
        clock = self.db.table("sim_clock").one()
        w = self.db.table("weather").one()
        if not clock or not w:
            return
        now = clock["sim_s"]
        self._busy = True
        try:
            new: dict[int, tuple[float, float]] = {}
            source = "sim"
            # 1. satellite detections that have "happened" by now
            while self.detections and self.detections[0][0] <= now:
                t, cid, inten = self.detections.pop(0)
                if cid not in self.burning:
                    new[cid] = (t, inten)
                source = "firms"
                self.last_detection = f"T+{t / 60:.0f} min"
            if new:
                self.burning.update({c: t for c, (t, _) in new.items()})
                self.dirty = True
            # 2. modelled spread (only when there is fire)
            if self.burning:
                if self.dirty or self.truth is None:
                    wind = Wind(w["wind_speed_mps"], w["wind_from_deg"])
                    started = time.perf_counter()
                    self.truth = await asyncio.to_thread(
                        truth_arrival, self.grid, self.fuel, dict(self.burning), wind,
                        now_s=now, t_max=now + TRUTH_HORIZON_S, params=self.params,
                    )
                    self.dirty = False
                    self.log.info("truth field recomputed in %.0f ms (wind %.1f m/s from %.0f°)",
                                  (time.perf_counter() - started) * 1e3, wind.speed_mps, wind.from_deg)
                spread = ignite_due(self.grid, self.truth, self.burning, now)
                for cid, t in spread.items():
                    new.setdefault(cid, (t, 1.0))
                self.burning.update(spread)
            if new:
                cells = [{"cell_id": c, "ignited_s": round(t, 1), "intensity": i} for c, (t, i) in new.items()]
                if not await self.db.try_call("upsert_fire_cells", cells, False, source):  # retry next tick
                    for c in new:
                        self.burning.pop(c, None)
            if not self.history or now - self.history[-1][0] >= 60:
                self.history.append((now, len(self.burning)))
            self.host.set_part("fire", "online", f"{len(self.burning)} cells burning ({self.area_km2():.1f} km²)")
        finally:
            self._busy = False

    # ── reporting ───────────────────────────────────────────────────────────

    def area_km2(self, cells: int | None = None) -> float:
        n = len(self.burning) if cells is None else cells
        return n * (self.grid.cell_size_m ** 2) / 1e6 if self.grid else 0.0

    def report(self) -> FireReport:
        now = self.host.sim_now()
        w = self.db.table("weather").one() or {"wind_speed_mps": 0.0, "wind_from_deg": 0.0}
        heading = (w["wind_from_deg"] + 180.0) % 360.0
        wind = Wind(w["wind_speed_mps"], w["wind_from_deg"])
        head_rate = self.params.base_ros_mps * math.exp(self.params.wind_coeff * wind.speed_mps) * 3.6

        # Growth over the last 30 sim-min, or over however much history this process has (it restarts
        # empty); with less than 5 min of history there is no honest number, so say nothing.
        base = next(((t, n) for t, n in reversed(self.history) if t <= now - 1800), self.history[0] if self.history else None)
        span_min = (now - base[0]) / 60 if base else 0.0
        growth = self.area_km2() - self.area_km2(base[1]) if base and span_min >= 5 else 0.0
        growth_txt = f" (+{growth:.1f} km² in last {min(span_min, 30):.0f} min)" if base and span_min >= 5 else ""

        threats: list[StationThreat] = []
        g = self.grid
        burning_ll = [g.center(c) for c in self.burning] if g else []
        for s in sorted(self.db.table("station"), key=lambda s: s["id"]):
            eta = -1.0
            cid = g.locate(s["lat"], s["lon"]) if g else None
            if cid is not None:
                if cid in self.burning:
                    eta = 0.0
                elif (fc := self.db.table("forecast_cell").get(cid)) is not None:
                    eta = max(0.0, (fc["arrival_early_s"] - now) / 60)
            dist = min((haversine_m(s["lat"], s["lon"], la, lo) for la, lo in burning_ll), default=math.inf) / 1000
            threats.append(StationThreat(station_id=s["id"], station=s["name"], fire_eta_min=round(eta, 1),
                                         distance_km=round(dist, 2) if math.isfinite(dist) else -1.0))

        lines = [f"{self.area_km2():.1f} km² burning{growth_txt}, "
                 f"head moving {compass(heading)} at ~{head_rate:.1f} km/h"]
        close = [t for t in threats if 0 <= t.fire_eta_min <= 180]
        for t in sorted(close, key=lambda t: t.fire_eta_min):
            if t.fire_eta_min == 0 and 0 <= t.distance_km <= 0.3:  # the station's own grid cell is burning
                lines.append(f"{t.station}: FIRE IS AT THE STATION")
            else:
                lines.append(f"{t.station}: fire expected in ~{t.fire_eta_min:.0f} min ({t.distance_km:.1f} km away)")
        if not close and threats:
            nearest = min((t for t in threats if t.distance_km >= 0), key=lambda t: t.distance_km, default=None)
            if nearest:
                lines.append(f"No station threatened within 3 h; nearest is {nearest.station} at {nearest.distance_km:.1f} km")
        return FireReport(
            source="firms+sim" if self.last_detection else "sim",
            sim_min=round(now / 60, 1),
            burning_cells=len(self.burning),
            area_km2=round(self.area_km2(), 2),
            growth_km2_30min=round(growth, 2),
            heading_deg=round(heading, 0),
            head_rate_kmh=round(head_rate, 2),
            stations=threats,
            last_detection=self.last_detection,
            summary="; ".join(lines),
        )
