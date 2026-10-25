"""Forecast engine: ensemble fire-arrival forecast per grid cell.

SpacetimeDB change (wind / fire) -> debounce -> ensemble -> one reducer call,
so a wind-slider drag re-forecasts within ~0.5 s and every downstream agent
(the commander: danger -> plan) reacts to the new forecast rows.
"""
from __future__ import annotations

import asyncio
import math
import hashlib
import json
from dataclasses import replace

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
        self._risk_busy = False
        self._risk_sig = None
        self._risk_status = None
        self._risk_error = ""
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
        if (settings.fire_source == "recorded" or upd.touched("grid", "weather")
                or loop.time() - self._last_fire_run >= FIRE_REFORECAST_S):
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
            self.log.warning("forecast publish failed (%s: %s); retrying", type(e).__name__, getattr(e, "message", e))
            if isinstance(e, ReducerError) and self._debounce:
                self._debounce.trigger()  # a stale snapshot lost a race with a world change: recompute now, don't wait for the next one
            return
        self.host.set_part("forecast", "online", f"{len(cells)} cells at risk within {HORIZON_S / 3600:.0f} h")
        if settings.fire_source != "recorded":
            await self._publish_risk_status("disabled" if settings.fire_forecast_backend == "simulation" else "fallback",
                                            "Known recorded observation history is not configured")
        self.log.info("published forecast: %d cells, wind %.1f m/s from %.0f°", len(cells), wind.speed_mps, wind.from_deg)

    async def _publish_risk_status(self, status, reason):
        clock = self.db.table("sim_clock").one()
        if not clock:
            return
        signature = (clock["scenario"], status, reason)
        self.host.set_part("historical_risk", "online" if status == "disabled" else "degraded", reason)
        state = self.db.table("risk_pipeline").one()
        if (signature == self._risk_status and state and state["scenario"] == clock["scenario"]
                and state["status"] == status and state["reason"] == reason[:1000]):
            return
        if await self.db.try_call("publish_risk_pipeline_status", clock["scenario"],
                                  self.host.recorded.source_id if self.host.recorded else "unconfigured",
                                  status, "simulation", reason):
            self._risk_status = signature

    async def recorded_tick(self):
        """Retry until a complete known-observation forecast is committed; never acknowledge a failed transfer."""
        if self._risk_busy:
            return
        self._risk_busy = True
        try:
            source = self.host.recorded
            if source is None:
                await self._publish_risk_status("error", self.host.recorded_error or "recorded input missing")
                return
            clock = self.db.table("sim_clock").one()
            g = self.db.table("grid").one()
            if not clock or not g:
                return
            if clock["scenario"] != source.scenario or not source.matches_grid(Grid.from_row(g)):
                await self._publish_risk_status("error", "Recorded source scenario/grid differs from loaded world")
                return
            horizons = [float(h) for h in settings.fire_forecast_horizons_s.split(",")]
            request, observation = source.request(clock["sim_s"], horizons)
            if self.host.fire._recorded_observation != observation:
                return  # the fire engine has not committed this acquisition yet
            expected = {c["cell_id"] for c in source.fire_cells(clock["sim_s"])}
            if expected != {c["cell_id"] for c in self.db.table("fire_cell")}:
                return  # wait for the WebSocket replica to apply that same transaction
            versions = dict(self.db.table("world_version").one())
            signature = (source.scenario, observation, versions["weather"], versions["fire"], tuple(horizons))
            meta = self.db.table("fire_risk_meta").one()
            if signature == self._risk_sig and meta and meta.get("observation_id") == observation:
                return
            result = await asyncio.to_thread(self.learned.forecast, request)
            if result.product is None:
                await self._publish_risk_status("fallback", result.reason)
                return
            product = replace(result.product, issue_s=result.product.issue_s - source.start_utc_s,
                              quality_flags=[*result.product.quality_flags, f"recorded source {source.source_id}"])
            from ..forecast_ml.bridge import recorded_risk_arguments
            forecast_id = hashlib.sha256(json.dumps([signature, product.model_id]).encode()).hexdigest()[:24]
            args = recorded_risk_arguments(product, source.grid_record, versions, clock["sim_s"],
                                           forecast_id, observation, source.scenario, request.issue_s)
            await self.db.call("publish_recorded_fire_risk", *args, timeout=PUBLISH_TIMEOUT_S)
            self._risk_sig = signature
            self._risk_status = None
            self._risk_error = ""
            self.host.set_part("historical_risk", "online", f"forecast {forecast_id}, observation {observation}")
            self.log.info("risk transfer committed forecast=%s observation=%s model=%s cells=%d",
                          forecast_id, observation, product.model_id, product.grid.size)
        except (OSError, ValueError, KeyError, ImportError, RuntimeError, httpx.HTTPError) as exc:
            message = f"{type(exc).__name__}: {exc}"
            if message != self._risk_error:
                self.log.exception("recorded forecast failed; will retry")
                self._risk_error = message
            await self._publish_risk_status("error", message)
        finally:
            self._risk_busy = False

    async def publish_supplementary(self, product, grid_record, *, versions, clock_s,
                                    time_basis="historical_utc") -> None:
        """Explicit replay/inference integration; no conversion to forecast_cell ETAs."""
        from ..forecast_ml.bridge import risk_arguments
        # Caller captures these BEFORE inference. Reading fresh versions here
        # would falsely label an old prediction as current after a wind change.
        await self.db.call("publish_fire_risk", *risk_arguments(product, grid_record, versions,
                           clock_s, time_basis=time_basis), timeout=PUBLISH_TIMEOUT_S)
