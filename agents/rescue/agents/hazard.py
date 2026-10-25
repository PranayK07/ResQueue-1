"""Hazard agent: one agent that owns everything environmental.

  fire engine      perimeter: simulated spread, optionally NASA FIRMS detections
  weather engine   wind: live NWS observations (commander can override)
  forecast engine  ensemble fire-arrival time per grid cell

It answers the commander's FireReportRequest / WeatherReportRequest directly
over uAgents messages. Add a separate agent only when it brings a separate
data source (e.g. a news / evacuation-order scraper).
"""
from __future__ import annotations

from uagents import Context

from ..config import settings
from ..hazard.fire import FireEngine
from ..hazard.forecast import ForecastEngine
from ..hazard.weather import WeatherEngine
from ..messages import (FireReport, FireReportRequest, HazardReport, HazardReportRequest,
                        WeatherReport, WeatherReportRequest)
from .base import MeshAgent


class HazardAgent(MeshAgent):
    queries = [
        "SELECT * FROM sim_clock",
        "SELECT * FROM grid",
        "SELECT * FROM weather",
        "SELECT * FROM fire_cell",
        "SELECT * FROM station",
        "SELECT * FROM forecast_cell",
        "SELECT * FROM world_version",
        "SELECT * FROM risk_pipeline",
        "SELECT * FROM fire_risk_meta",
    ]

    def __init__(self) -> None:
        super().__init__("hazard")
        self.recorded = None
        self.recorded_error = ""
        if settings.fire_source == "recorded":
            try:
                from ..forecast_ml.recorded import RecordedIncident
                self.recorded = RecordedIncident.load(settings.recorded_incident_path)
            except (OSError, ValueError, KeyError, TypeError, EOFError, ImportError) as exc:
                self.recorded_error = f"{type(exc).__name__}: {exc}"
        self.fire = FireEngine(self)
        self.weather = WeatherEngine(self)
        self.forecast = ForecastEngine(self)

        @self.agent.on_message(FireReportRequest, replies=FireReport)
        async def _fire_report(ctx: Context, sender: str, _msg: FireReportRequest):
            if await self.when_ready(ctx):
                await ctx.send(sender, self.fire.report())

        @self.agent.on_message(WeatherReportRequest, replies=WeatherReport)
        async def _weather_report(ctx: Context, sender: str, _msg: WeatherReportRequest):
            if await self.when_ready(ctx):
                await ctx.send(sender, self.weather.report())

        @self.agent.on_message(HazardReportRequest, replies=HazardReport)
        async def _hazard_report(ctx: Context, sender: str, _msg: HazardReportRequest):
            if await self.when_ready(ctx):
                await ctx.send(sender, HazardReport(fire=self.fire.report(), weather=self.weather.report()))

        @self.agent.on_interval(period=1.0)
        async def _fire_tick(_ctx: Context):
            await self.fire.tick()
            if settings.fire_source == "recorded":
                await self.forecast.recorded_tick()

        @self.agent.on_interval(period=settings.weather_poll_s)
        async def _weather_poll(ctx: Context):
            await self.weather.poll(ctx)

        @self.agent.on_event("shutdown")
        async def _close(_ctx: Context):
            await self.weather.close()

    async def on_ready(self, ctx: Context) -> None:
        await self.fire.on_ready(ctx)
        await self.forecast.on_ready(ctx)
        self.ready.set()  # world loaded; the first NWS poll below is a network call and must not delay answers
        await self.weather.on_ready(ctx)


if __name__ == "__main__":
    HazardAgent().run()
