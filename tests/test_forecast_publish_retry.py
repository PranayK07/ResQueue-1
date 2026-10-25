"""A rejected first physical forecast must recover without another fire/weather event."""
import asyncio
import logging
from types import SimpleNamespace

import numpy as np


def test_forecast_recomputes_after_stale_publish(monkeypatch):
    from rescue.hazard import forecast
    from rescue.stdb import ReducerError, Table

    monkeypatch.setattr(forecast, "PUBLISH_RETRY_S", 0.01)
    monkeypatch.setattr(forecast, "settings", SimpleNamespace(fire_source="sim",
        fire_forecast_backend="simulation", fire_forecast_checkpoint="", fire_forecast_metadata=""))
    monkeypatch.setattr(forecast, "ensemble_arrival", lambda *args, **kwargs: (np.full((2, 2), 100.0), np.full((2, 2), 200.0)))

    async def run():
        succeeded = asyncio.Event()

        class Database:
            def __init__(self):
                self.rows = {
                    "grid": [dict(origin_lat=39.7, origin_lon=-121.6, cell_size_m=100, rows=2, cols=2)],
                    "weather": [dict(wind_speed_mps=0, wind_from_deg=0)],
                    "fire_cell": [dict(cell_id=0, ignited_s=0)],
                    "world_version": [dict(weather=1, fire=1)],
                }
                self.published = []

            def table(self, name):
                table = Table(name, [])
                table.rows = dict(enumerate(self.rows[name]))
                return table

            def on_update(self, *args):
                pass

            async def call(self, reducer, weather, fire, *args, **kwargs):
                assert reducer == "publish_forecast"
                self.published.append((weather, fire))
                if len(self.published) == 1:
                    self.rows["world_version"] = [dict(weather=2, fire=2)]
                    raise ReducerError(reducer, 400, "stale physical forecast snapshot")

        db = Database()

        def health(part, status, detail):
            if part == "forecast" and status == "online":
                succeeded.set()

        host = SimpleNamespace(db=db, log=logging.getLogger("retry-test"), sim_now=lambda: 0.0, set_part=health)
        engine = forecast.ForecastEngine(host)
        async def no_risk_status(*args):
            pass
        engine._publish_risk_status = no_risk_status
        await engine.on_ready(None)
        await asyncio.wait_for(succeeded.wait(), timeout=3)
        assert db.published == [(1, 1), (2, 2)]
        assert engine._retry is None
        if engine._debounce._task:
            await engine._debounce._task

    asyncio.run(run())
