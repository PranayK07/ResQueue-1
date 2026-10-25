import pytest

from rescue.core.assistance import response_options, position_along
from rescue.core.danger import routing_forecast_current
from rescue.core.geo import Grid
from rescue.core.slack import level_for


def unit(uid, grid, cell, **changes):
    lat, lon = grid.center(cell)
    return dict(id=uid, station_id=1, callsign=f'R{uid}', capacity=8, current_request=0,
                status='available', free_at_s=0, lat=lat, lon=lon, **changes)


def test_nearest_available_truck_is_measured_from_its_actual_position():
    grid = Grid(35.6, -112.8, 60, 20, 20)
    request = dict(id=1, headcount=1, lat=grid.center(210)[0], lon=grid.center(210)[1])
    a, b = unit(1, grid, 0), unit(2, grid, 211)
    result = response_options(grid, 0, [request], [a, b], [])[1]
    assert result['unit_id'] == 2 and result['travel_s'] < 10 and result['wait_s'] == 0


def test_assigned_truck_does_not_get_a_false_zero_eta_or_wait_for_its_own_release():
    grid = Grid(35.6, -112.8, 60, 20, 20)
    request = dict(id=1, headcount=1, lat=grid.center(210)[0], lon=grid.center(210)[1])
    u = unit(1, grid, 0); u.update(status='assigned', current_request=1, free_at_s=1)
    route = dict(unit_id=1, request_id=1, status='ready', duration_s=300, depart_s=0, arrive_s=300)
    result = response_options(grid, 9000, [request], [u], [],
                              [dict(request_id=1, eta_s=300)], [route])[1]
    assert result['travel_s'] == 300 and result['wait_s'] == 0
    u['status'] = 'en_route'; route.update(depart_s=9000, arrive_s=9300)
    assert response_options(grid, 9120, [request], [u], [], routes=[route])[1]['travel_s'] == 180


def test_early_forecast_does_not_mean_that_an_unburned_caller_has_been_consumed():
    assert level_for(-60) == 'critical'
    assert not routing_forecast_current({'computed_at_s':0, 'horizon_s':10800}, 18900)


def test_unknown_release_is_not_replaced_with_an_invented_thirty_minute_wait():
    grid = Grid(35.6, -112.8, 60, 20, 20)
    request = dict(id=1, headcount=1, lat=grid.center(210)[0], lon=grid.center(210)[1])
    u = unit(1, grid, 0); u.update(status='en_route', current_request=2, free_at_s=0)
    assert response_options(grid, 900, [request], [u], []) == {1: None}


def test_route_position_follows_turns_instead_of_cutting_across_the_map():
    points = [{'lat':35, 'lon':-112}, {'lat':35.01, 'lon':-112}, {'lat':35.01, 'lon':-111.99}]
    at = position_along(points, 0.25)
    assert at['lon'] == -112 and 35 < at['lat'] < 35.01
