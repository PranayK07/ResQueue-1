"""Forecast engine: ensemble fire-arrival forecast per grid cell.

SpacetimeDB change (wind / fire) -> debounce -> ensemble -> one reducer call,
so a wind-slider drag re-forecasts within ~0.5 s and every downstream agent
(danger -> delegation) reacts to the new forecast rows.
"""
from __future__ import annotations

import asyncio
import math

import httpx
from typing import TYPE_CHECKING

import numpy as np
from uagents import Context

from ..core.fire import FUEL_SEED, Ensemble, FuelMap, Wind, ensemble_arrival
from ..core.geo import Grid
from ..stdb import Debouncer, ReducerError, Update
from ..config import settings
from ..forecast_ml.live import LearnedForecastBackend

if TYPE_CHECKING:
    from ..agents.hazard import HazardAgent

HORIZON_S = 3 * 3600.0
MEMBERS = 16
# Wind changes re-forecast immediately; fire growth alone at most this often,
# since each forecast rewrites thousands of rows (and fans out to every subscriber).
FIRE_REFORECAST_S = 45.0
# Arrival times are quantised so tiny shifts don't rewrite thousands of unchanged rows.
QUANTUM_S = 30.0
PUBLISH_TIMEOUT_S = 90.0


class ForecastEngine:
    def __init__(self, host: "HazardAgent") -> None:
        self.host = host
        self.db = host.db
        self.log = host.log
        self._fuel: FuelMap | None = None
        self._grid: Grid | None = None
        self._last_fire_run = 0.0
        self._debounce: Debouncer | None = None
        self.learned = LearnedForecastBackend(settings.fire_forecast_backend,
            settings.fire_forecast_checkpoint, settings.fire_forecast_metadata)

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
            early = math.floor(float(p10[r, c]) / QUANTUM_S) * QUANTUM_S  # floor = earlier = conservative
            cells.append({"cell_id": cid, "arrival_early_s": early, "arrival_median_s": round(median / QUANTUM_S) * QUANTUM_S})

        try:
            await self.db.call("publish_forecast", versions["weather"], versions["fire"], now, HORIZON_S, MEMBERS, cells,
                               timeout=PUBLISH_TIMEOUT_S)
        except (httpx.TimeoutException, httpx.TransportError, ReducerError) as e:
            # The write is an idempotent upsert, so a timeout is safe to retry on the next trigger.
            self.host.set_part("forecast", "degraded", f"publish failed: {type(e).__name__}")
            self.log.warning("forecast publish failed (%s); will retry on the next fire/wind change", type(e).__name__)
            return
        self.host.set_part("forecast", "online", f"{len(cells)} cells at risk within {HORIZON_S / 3600:.0f} h")
        # Main's simulation does not possess timestamped NIROPS observation
        # history. Report an explicit fallback instead of guessing daily inputs
        # from minute-level fire ticks or loading a random policy into danger.
        supplementary = self.learned.forecast(None)
        self.host.set_part("historical_risk", "degraded" if supplementary.requested != "simulation" else "online",
                           supplementary.reason)
        self.log.info("published forecast: %d cells, wind %.1f m/s from %.0f°", len(cells), wind.speed_mps, wind.from_deg)

    async def publish_supplementary(self, product, grid_record, *, versions, clock_s,
                                    time_basis="historical_utc") -> None:
        """Explicit replay/inference integration; no conversion to forecast_cell ETAs."""
        from ..forecast_ml.bridge import risk_arguments
        # Caller captures these BEFORE inference. Reading fresh versions here
        # would falsely label an old prediction as current after a wind change.
        await self.db.call("publish_fire_risk", *risk_arguments(product, grid_record, versions,
                           clock_s, time_basis=time_basis), timeout=PUBLISH_TIMEOUT_S)
