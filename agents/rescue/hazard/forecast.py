"""Forecast engine: ensemble fire-arrival forecast per grid cell.

SpacetimeDB change (wind / fire) -> debounce -> ensemble -> one reducer call,
so a wind-slider drag re-forecasts within ~0.5 s and every downstream agent
(danger -> delegation) reacts to the new forecast rows.
"""
from __future__ import annotations

import asyncio
import math
from typing import TYPE_CHECKING

import numpy as np
from uagents import Context

from ..core.fire import FUEL_SEED, Ensemble, FuelMap, Wind, ensemble_arrival
from ..core.geo import Grid
from ..stdb import Debouncer, Update

if TYPE_CHECKING:
    from ..agents.hazard import HazardAgent

HORIZON_S = 3 * 3600.0
MEMBERS = 16
# Wind changes re-forecast immediately; fire growth alone at most this often,
# since each forecast rewrites thousands of rows.
FIRE_REFORECAST_S = 15.0


class ForecastEngine:
    def __init__(self, host: "HazardAgent") -> None:
        self.host = host
        self.db = host.db
        self.log = host.log
        self._fuel: FuelMap | None = None
        self._grid: Grid | None = None
        self._last_fire_run = 0.0
        self._debounce: Debouncer | None = None

    async def on_ready(self, ctx: Context) -> None:
        self._debounce = Debouncer(self.tick)
        self.db.on_update(["weather", "fire_cell", "grid"], self._changed)
        self._debounce.trigger()

    def _changed(self, upd: Update) -> None:
        if self._debounce is None:
            return
        loop = asyncio.get_running_loop()
        if upd.touched("grid"):
            self._fuel = None  # new scenario
        if upd.touched("grid", "weather") or loop.time() - self._last_fire_run >= FIRE_REFORECAST_S:
            self._last_fire_run = loop.time()
            self._debounce.trigger()

    async def tick(self) -> None:
        g_row = self.db.table("grid").one()
        w_row = self.db.table("weather").one()
        if not g_row or not w_row:
            return
        grid = Grid.from_row(g_row)
        burning = {r["cell_id"]: r["ignited_s"] for r in self.db.table("fire_cell")}
        if not grid.valid or not burning:
            self.host.set_part("forecast", "idle", "no fire yet")
            return
        if self._fuel is None or self._grid != grid:
            self._grid, self._fuel = grid, FuelMap.uniform(grid, seed=FUEL_SEED)
        versions = self.db.table("world_version").one()
        now = self.host.sim_now()
        wind = Wind(w_row["wind_speed_mps"], w_row["wind_from_deg"])

        # numpy work off the event loop so the uAgent stays responsive
        p10, p50 = await asyncio.to_thread(
            ensemble_arrival, grid, self._fuel, burning, wind,
            now_s=now, horizon_s=HORIZON_S, ens=Ensemble(members=MEMBERS),
        )
        cells = []
        for r, c in zip(*np.nonzero(np.isfinite(p10))):
            cid = int(r) * grid.cols + int(c)
            if cid in burning:
                continue
            median = float(p50[r, c]) if math.isfinite(p50[r, c]) else now + HORIZON_S
            cells.append({"cell_id": cid, "arrival_early_s": round(float(p10[r, c]), 1), "arrival_median_s": round(median, 1)})

        await self.db.call("publish_forecast", versions["weather"], versions["fire"], now, HORIZON_S, MEMBERS, cells)
        self.host.set_part("forecast", "online", f"{len(cells)} cells at risk within {HORIZON_S / 3600:.0f} h")
        self.log.info("published forecast: %d cells, wind %.1f m/s from %.0f°", len(cells), wind.speed_mps, wind.from_deg)
