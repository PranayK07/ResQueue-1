"""Routing feasibility, forecast age and historical replay regression cases."""
import numpy as np
import pytest

from rescue.core.danger import UNREACHABLE_S, assess_requests, routing_forecast_current
from rescue.core.geo import Grid


def assess(grid, *, now=0, forecast=None, burning=None, closures=None, needs=""):
    return assess_requests(grid, now, [(1, *grid.center(7), 1, needs)],
                           [(1, *grid.center(5))], forecast or {}, burning or set(), closures or [])


def test_forecast_deadline_can_exclude_an_unburned_destination_without_a_road_closure():
    grid = Grid(35, -112, 60, 3, 5)
    risks, travel = assess(grid, forecast={7: 300})
    assert not travel[0]["reachable"] and risks[0]["slack_s"] < -UNREACHABLE_S / 2
    assert "outside the observed fire" in risks[0]["route_reason"]
    assert "5 minutes" in risks[0]["route_reason"]
    # Same geometry, with enough forecast clearance: an approach exists.
    assert assess(grid, forecast={7: 1800})[1][0]["reachable"]


def test_observed_fire_and_a_road_closure_are_distinct_from_a_forecast_deadline():
    grid = Grid(35, -112, 60, 3, 5)
    assert "inside the observed fire" in assess(grid, burning={7})[0][0]["route_reason"]
    closure = (*grid.center(2), *grid.center(12))  # barrier through the destination column
    risks, travel = assess(grid, closures=[closure])
    assert not travel[0]["reachable"]
    assert "active road closures" in risks[0]["route_reason"]


def test_negative_rescue_slack_does_not_mean_the_grid_has_no_path():
    grid = Grid(35, -112, 60, 3, 5)
    risks, travel = assess(grid, forecast={7: 1000}, needs="mobility")
    assert travel[0]["reachable"]
    assert -UNREACHABLE_S / 2 < risks[0]["slack_s"] < 0
    assert risks[0]["route_reason"] == ""


@pytest.mark.parametrize("now,expected", [(99, False), (100, True), (109, True), (110, False), (10000, False)])
def test_routing_forecast_has_a_bounded_validity_window(now, expected):
    assert routing_forecast_current({"computed_at_s": 100, "horizon_s": 10}, now) is expected
    assert not routing_forecast_current(None, now)
