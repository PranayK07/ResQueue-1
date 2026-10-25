"""Weather engine: owns wind (`weather` row) from live NWS observations.

WEATHER_SOURCE=nws       poll the nearest reporting NWS station every
                         WEATHER_POLL_S; the database ignores these writes while
                         the commander holds manual wind (the demo slider)
WEATHER_SOURCE=scenario  never write; just report what the DB holds
"""
from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from uagents import Context

from ..config import settings
from ..core.geo import Grid, compass
from ..data.nws import NWSClient, Observation
from ..messages import WeatherReport

if TYPE_CHECKING:
    from ..agents.hazard import HazardAgent


def angle_diff(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


class WeatherEngine:
    def __init__(self, host: "HazardAgent") -> None:
        self.host = host
        self.db = host.db
        self.nws = NWSClient(settings.nws_user_agent)
        self.last_obs: Observation | None = None
        self.history: deque[tuple[float, float]] = deque(maxlen=12)  # (speed, from_deg) as held in the DB

    async def on_ready(self, ctx: Context) -> None:
        self.db.on_update(["weather"], self._track)
        self._track(None)  # baseline, so the first change reports a trend
        ctx.logger.info(f"weather source={settings.weather_source}, poll every {settings.weather_poll_s:.0f}s")
        await self.poll(ctx)

    def _track(self, _upd) -> None:
        w = self.db.table("weather").one()
        if w and (not self.history or self.history[-1] != (w["wind_speed_mps"], w["wind_from_deg"])):
            self.history.append((w["wind_speed_mps"], w["wind_from_deg"]))

    async def poll(self, ctx: Context) -> None:
        if settings.weather_source != "nws" or not self.db.identity:
            return
        g_row = self.db.table("grid").one()
        grid = Grid.from_row(g_row) if g_row else None
        if not grid or not grid.valid:
            return
        west, south, east, north = grid.bbox()
        try:
            obs = await self.nws.latest((south + north) / 2, (west + east) / 2)
        except Exception as e:  # noqa: BLE001 - keep last good value, report degraded
            self.host.set_part("weather", "degraded", f"NWS error: {e}"[:120])
            ctx.logger.warning(f"NWS poll failed: {e}")
            return
        if obs is None:
            self.host.set_part("weather", "degraded", "no NWS station with a fresh wind reading")
            return
        fresh = self.last_obs is None or (self.last_obs.observed_at, self.last_obs.station) != (obs.observed_at, obs.station)
        self.last_obs = obs
        gust = obs.gust_mps if obs.gust_mps is not None else obs.wind_speed_mps
        if fresh:  # NWS updates ~hourly; rewriting the same reading would re-trigger fire + forecast
            await self.db.try_call("set_weather", obs.wind_speed_mps, obs.wind_from_deg, gust, "nws")
        locked = (self.db.table("weather").one() or {}).get("locked", False)
        self.host.set_part("weather", "online", f"{obs.station} {obs.wind_speed_mps:.1f} m/s from {obs.wind_from_deg:.0f}°"
                           + (" (DB on manual wind)" if locked else ""))
        if fresh:
            ctx.logger.info(f"NWS {obs.station}: {obs.wind_speed_mps:.1f} m/s from {obs.wind_from_deg:.0f}°, "
                            f"RH {obs.humidity_pct if obs.humidity_pct is not None else -1:.0f}%"
                            + (" — ignored, commander has manual wind" if locked else ""))

    @staticmethod
    def _age(epoch_s: float) -> str:
        m = max(0.0, (datetime.now(timezone.utc).timestamp() - epoch_s) / 60)
        return f"{m:.0f} min" if m < 120 else f"{m / 60:.1f} h"

    @classmethod
    def _obs_time(cls, iso: str) -> str:
        try:
            t = datetime.fromisoformat(iso)
        except ValueError:
            return iso or "at an unknown time"
        return f"{t.astimezone(timezone.utc):%Y-%m-%d %H:%M} UTC ({cls._age(t.timestamp())} ago)"

    def report(self) -> WeatherReport:
        w = self.db.table("weather").one() or {}
        speed, frm = w.get("wind_speed_mps", 0.0), w.get("wind_from_deg", 0.0)
        gust = w.get("gust_mps", speed)
        o = self.last_obs
        rh = o.humidity_pct if o and o.humidity_pct is not None else -1.0

        trend = "steady"
        if len(self.history) >= 2:
            (s0, d0), (s1, d1) = self.history[-2], self.history[-1]
            if angle_diff(d0, d1) >= 20:
                trend = f"shifted {compass(d0)} → {compass(d1)}"
            elif s1 - s0 >= 2:
                trend = "strengthening"
            elif s0 - s1 >= 2:
                trend = "easing"

        reasons = []
        if speed >= 11 or gust >= 15:
            reasons.append("strong wind")
        if 0 <= rh <= 15:
            reasons.append("very low humidity")
        red_flag = bool(reasons) and (len(reasons) == 2 or speed >= 13 or gust >= 20)

        line = f"Wind {speed:.0f} m/s ({speed * 3.6:.0f} km/h) from {compass(frm)} ({frm:.0f}°), gusts {gust:.0f} m/s, {trend}"
        if w.get("locked"):
            line += " [manual override]"
        if w.get("updated_at"):
            line += f" (wind set {self._age(w['updated_at'] / 1e6)} ago)"
        if o:
            line += f"; live NWS {o.station}: {o.wind_speed_mps:.0f} m/s from {compass(o.wind_from_deg)}" + (f", RH {rh:.0f}%" if rh >= 0 else "")
            line += f", observed {self._obs_time(o.observed_at)}"
        if red_flag:
            line += f" — RED FLAG conditions ({', '.join(reasons)})"
        return WeatherReport(
            source=w.get("source", "none"),
            station=o.station if o else "",
            observed_at=o.observed_at if o else "",
            wind_speed_mps=round(speed, 2),
            wind_from_deg=round(frm, 0),
            gust_mps=round(gust, 2),
            humidity_pct=round(rh, 1),
            temperature_c=round(o.temperature_c, 1) if o and o.temperature_c is not None else -999.0,
            locked=bool(w.get("locked", False)),
            trend=trend,
            red_flag=red_flag,
            summary=line,
        )

    async def close(self) -> None:
        await self.nws.close()
