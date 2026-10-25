import asyncio
import math
from types import SimpleNamespace

import numpy as np

from rescue.core.danger import UNREACHABLE_S, assess_requests
from rescue.core.fire import Ensemble, FuelMap, Wind, ensemble_arrival
from rescue.core.geo import Grid


def test_old_perimeter_does_not_replay_a_day_of_fire_under_current_wind():
    grid = Grid(35.6, -112.7, 300, 5, 5)
    now = 86400.0
    p10, _ = ensemble_arrival(grid, FuelMap.uniform(grid), {12: 0.0}, Wind(0, 0),
                              now_s=now, horizon_s=10800, ens=Ensemble(members=4))
    assert p10[2, 2] == now  # actually observed fire remains dangerous
    assert p10[2, 3] > now  # unobserved neighbours have a future deadline
    assert np.nanmin(p10) >= now


def test_clock_translation_preserves_forecast_and_reachability():
    grid = Grid(35.6, -112.7, 100, 5, 5)
    burning = {12: 0.0}
    results = []
    for now in (0.0, 86400.0):
        p10, _ = ensemble_arrival(grid, FuelMap.uniform(grid), burning, Wind(0, 0),
                                  now_s=now, horizon_s=10800, ens=Ensemble(members=4))
        forecast = {cid: float(p10.flat[cid]) for cid in range(grid.size) if math.isfinite(p10.flat[cid]) and cid not in burning}
        lat, lon = grid.center(4)
        slat, slon = grid.center(0)
        danger, travel = assess_requests(grid, now, [(1, lat, lon, 1, '')], [(1, slat, slon)], forecast, set(burning), [])
        results.append((danger[0]['level'], danger[0]['slack_s'], travel[0]['reachable'], travel[0]['travel_s']))
    assert results[0] == results[1]
    assert results[0][2] is True


def test_blocked_route_is_explicit_without_sentinel_arithmetic():
    grid = Grid(35.6, -112.7, 100, 3, 3)
    lat, lon = grid.center(8)
    slat, slon = grid.center(0)
    danger, travel = assess_requests(grid, 86400, [(1, lat, lon, 2, '')], [(1, slat, slon)], {}, {8}, [])
    assert danger[0]['level'] == 'unreachable'
    assert travel[0]['reachable'] is False and travel[0]['travel_s'] == UNREACHABLE_S
    assert danger[0]['slack_s'] == 0  # ignored finite wire value; DB publishes null


def test_station_availability_is_not_a_road_closure():
    grid = Grid(35.6, -112.7, 100, 3, 3)
    lat, lon = grid.center(8)
    slat, slon = grid.center(0)
    danger, travel = assess_requests(grid, 1000, [(1, lat, lon, 1, '')], [(1, slat, slon)], {}, set(), [])
    assert danger[0]['level'] == 'low' and travel[0]['reachable'] is True


def test_forecast_refreshes_as_replay_clock_advances_without_new_observations():
    from rescue.hazard.forecast import FORECAST_REFRESH_SIM_S, ForecastEngine
    from rescue.stdb import TableDelta, Update

    async def run():
        calls = []
        engine = object.__new__(ForecastEngine)
        engine.host = SimpleNamespace(sim_now=lambda: now[0])
        engine._debounce = SimpleNamespace(trigger=lambda: calls.append(now[0]))
        engine._clock_trigger_s = 0.0
        now = [FORECAST_REFRESH_SIM_S - 1]
        update = Update(tables={'sim_clock': TableDelta()})
        engine._changed(update)
        assert not calls
        now[0] += 1
        engine._changed(update)
        engine._changed(update)
        assert calls == [FORECAST_REFRESH_SIM_S]
    asyncio.run(run())
