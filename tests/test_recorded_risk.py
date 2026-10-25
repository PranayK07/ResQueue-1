"""Recorded observation -> combined risk -> policy contracts. No fitting or external services."""

from dataclasses import asdict
import json
import asyncio
from types import SimpleNamespace

import numpy as np
import pytest

from rescue.core.geo import Grid
from rescue.core.reports import Weighed
from rescue.core.risk import compose_risks, risk_snapshot
from rescue.forecast_ml.bridge import risk_arguments, recorded_risk_arguments
from rescue.forecast_ml.recorded import RecordedIncident
from rescue.forecast_ml.risk import ForecastProduct
from rescue.forecast_ml.spatial import ProjectedGrid, transformer
from rescue.forecast_ml.provenance import sha256
from rescue.planning import build_plan_input, risk_inputs_ready, risk_to_reducer_args


@pytest.fixture
def recorded(tmp_path):
    crs = "EPSG:32610"
    lon, lat = transformer(crs, "EPSG:4326").transform(600000, 4400000)
    grid = ProjectedGrid(lat, lon, 100.0, 128, 128, crs, 600000, 4400000)
    routing = Grid(lat - 0.01, lon - 0.01, 120.0, 150, 150)
    masks = np.zeros((2, 128, 128), bool)
    masks[0, 60, 60] = True
    masks[1, 59:62, 59:62] = True
    arrays = tmp_path / "observations.npz"
    np.savez_compressed(
        arrays, masks=masks, valid=np.ones((128, 128), bool), times_s=[1_600_000_000.0, 1_600_021_600.0]
    )
    manifest = dict(
        schema_version="recorded-fire-v1",
        scenario="recorded-fixture",
        source_id="fixture-sequence",
        arrays=arrays.name,
        arrays_sha256=sha256(arrays),
        grid=asdict(grid),
        routing_grid=asdict(routing),
    )
    path = tmp_path / "incident.json"
    path.write_text(json.dumps(manifest))
    return RecordedIncident.load(path), path


def test_replay_exposes_only_acquired_observations_and_roundtrips_geography(recorded):
    source, _ = recorded
    before, token = source.request(21599.0, [21600, 86400])
    assert len(before.history_masks) == 1 and before.issue_s == source.start_utc_s
    after, next_token = source.request(21600.0, [21600, 86400])
    assert len(after.history_masks) == 2 and next_token != token
    assert len(source.fire_cells(21600.0)) > len(source.fire_cells(0))
    assert all(0 <= c["cell_id"] < source.routing_grid.size for c in source.fire_cells(0))
    with pytest.raises(ValueError, match="nonnegative"):
        source.request(-1, [21600])
    g = source.routing_grid
    assert source.matches_grid(
        Grid(g.origin_lat, np.nextafter(g.origin_lon, 0), g.cell_size_m, g.rows, g.cols)
    )
    assert not source.matches_grid(Grid(g.origin_lat + 0.001, g.origin_lon, g.cell_size_m, g.rows, g.cols))


def test_corrupt_observation_bundle_is_rejected(recorded):
    _, path = recorded
    (path.parent / "observations.npz").write_bytes(b"changed")
    with pytest.raises(ValueError, match="checksum"):
        RecordedIncident.load(path)


def test_health_status_is_republished_after_same_scenario_reset():
    pytest.importorskip("uagents")
    from rescue.hazard.forecast import ForecastEngine

    class Database:
        state = None
        calls = 0

        def table(self, name):
            return SimpleNamespace(one=lambda: {"scenario": "fixture"} if name == "sim_clock" else self.state)

        async def try_call(self, reducer, scenario, source, status, active, reason):
            self.calls += 1
            self.state = dict(scenario=scenario, status=status, reason=reason)
            return True

    engine = object.__new__(ForecastEngine)
    engine.db = Database()
    engine.host = SimpleNamespace(recorded=None, set_part=lambda *args: None)
    engine._risk_status = None

    async def run():
        await engine._publish_risk_status("fallback", "checkpoint absent")
        await engine._publish_risk_status("fallback", "checkpoint absent")
        assert engine.db.calls == 1
        engine.db.state = None
        await engine._publish_risk_status("fallback", "checkpoint absent")
        assert engine.db.calls == 2

    asyncio.run(run())


def inputs(recorded):
    source, _ = recorded
    req, _ = source.request(0, [21600, 86400])
    probabilities = np.full((2, 128, 128), 0.2)
    probabilities[1] = 0.6
    product = ForecastProduct(
        req.grid,
        0.0,
        req.horizons_s,
        probabilities,
        req.valid,
        np.zeros((128, 128), bool),
        "fixture-model",
        "learned",
    )
    lat, lon = req.grid.center(62 * 128 + 62)
    requests = [
        dict(
            id=1,
            lat=lat,
            lon=lon,
            headcount=2,
            needs="",
            status="pending",
            location_purged=False,
            fire_eta_s=3600.0,
            extract_s=600.0,
            pinned_station_id=0,
            created_sim_s=0.0,
        )
    ]
    units = [
        dict(id=1, station_id=1, status="returning", free_at_s=300.0, updated_at=123, callsign="Fixture")
    ]
    versions = dict(weather=1, fire=2, roads=3, requests=4, forecast=5)
    meta = dict(
        issue_s=0.0,
        horizons_s=product.horizons_s,
        model_id="fixture-model",
        source="learned",
        time_basis="simulation",
        scenario=source.scenario,
        weather_version=1,
        fire_version=2,
        updated_at=100,
        forecast_id="forecast-1",
        observation_age_s=0.0,
        quality_flags=[],
        crs=source.grid_record["crs"],
        west_m=source.grid_record["x_min"],
        south_m=source.grid_record["y_min"],
        rows=128,
        cols=128,
        cell_size_m=100.0,
    )
    cells = risk_arguments(product, source.grid_record, versions, 0.0, time_basis="simulation")[-1]
    snapshot = risk_snapshot(0.0, source.scenario, versions, units, meta)
    danger = [dict(request_id=1, level="high", slack_s=2600.0, fire_eta_s=3600.0, extract_s=600.0)]
    travel = [dict(request_id=1, station_id=1, travel_s=100.0, reachable=True)]
    weighed = {
        1: Weighed(
            1, 0.85, 3, "medical", True, True, 1800.0, 600.0, 0.7, "credible fire sighting; road blocked"
        )
    }
    return SimpleNamespace(**locals())


def test_risk_preserves_exposure_routes_wait_slack_and_evidence_without_double_counting(recorded):
    f = inputs(recorded)
    rows = compose_risks(
        f.snapshot, f.requests, f.danger, f.travel, f.units, f.weighed, meta=f.meta, cells=f.cells
    )
    r = rows[0]
    assert r["probabilities"] == [0.2, 0.6] and r["forecast_id"] == "forecast-1"
    assert r["wait_s"] == 300 and r["scheduled_slack_s"] == 2300
    assert r["fire_eta_s"] == 3600 and r["extract_s"] == 600  # danger already applied evidence
    assert r["credibility"] == 0.85 and r["headcount"] == 3 and r["trapped"]
    assert r["exposure_slack_upper_s"] == 21600 - 100 - 300 - 600 - 300
    assert "Accepted evidence" in r["reason"]
    assert rows == compose_risks(
        f.snapshot, f.requests, f.danger, f.travel, f.units, f.weighed, meta=f.meta, cells=f.cells
    )
    json.dumps(rows, allow_nan=False)
    stations = [dict(id=1, name="Fixture")]
    inp = build_plan_input(
        0.0, f.requests, f.travel, f.units, stations, risks=[dict(assessment=r, current=True)]
    )
    assert inp.requests[0].risk == r
    inp = build_plan_input(
        0.0, f.requests, f.travel, f.units, stations, risks=[dict(assessment=r, current=False)]
    )
    assert inp.requests[0].risk is None
    assert not risk_inputs_ready(f.requests, [dict(assessment=r, current=False)])
    assert risk_inputs_ready(f.requests, [dict(assessment=r, current=True)])
    assert risk_inputs_ready(f.requests, [], hold={1})
    assert not risk_inputs_ready(f.requests, [], hold={1}, queue=[dict(request_id=1)])
    _, wire, _ = risk_to_reducer_args(f.snapshot, rows, f.travel)
    assert wire[0]["arrival_lower_s"] == {"some": 0.0}
    assert wire[0]["probabilities"] == rows[0]["probabilities"]


def test_dense_transport_preserves_all_default_maps_within_http_budget(recorded):
    source, _ = recorded
    req, token = source.request(0, [21600.0, 43200.0, 86400.0])
    rng = np.random.default_rng(202)
    p = np.maximum.accumulate(rng.random((3, 128, 128)), axis=0)
    product = ForecastProduct(
        req.grid, 0.0, req.horizons_s, p, req.valid, req.history_masks[-1], "fixture", "learned"
    )
    args = recorded_risk_arguments(
        product,
        source.grid_record,
        dict(weather=1, fire=1),
        0.0,
        "forecast",
        token,
        source.scenario,
        req.issue_s,
    )
    encoded = json.dumps(args)
    assert len(encoded.encode()) < 1_900_000
    decoded = json.loads(encoded)
    ids, values, observed = decoded[17:20]
    np.testing.assert_array_equal(np.asarray(values).reshape(3, -1), p.reshape(3, -1)[:, ids])
    assert observed == np.flatnonzero(req.history_masks[-1]).tolist()


@pytest.mark.parametrize("condition", ["stale", "expired", "fallback", "no_route", "outside"])
def test_unsupported_risk_states_are_explicit_and_json_finite(recorded, condition):
    f = inputs(recorded)
    pipeline = None
    if condition == "stale":
        f.meta["fire_version"] = 99
    elif condition == "expired":
        f.snapshot["assessed_at_s"] = 86401.0
    elif condition == "fallback":
        pipeline = dict(status="fallback", reason="checkpoint absent")
    elif condition == "no_route":
        f.travel[0]["reachable"] = False
    else:
        f.requests[0]["lat"] = 0.0
    r = compose_risks(
        f.snapshot,
        f.requests,
        f.danger,
        f.travel,
        f.units,
        f.weighed,
        meta=f.meta,
        cells=f.cells,
        pipeline=pipeline,
    )[0]
    if condition == "no_route":
        assert r["travel_s"] is None and r["scheduled_slack_s"] is None and not r["reachable"]
    else:
        assert r["probabilities"] == [] and r["forecast_state"] != "interval"
    if condition == "fallback":
        assert "checkpoint absent" in r["quality_flags"]
    json.dumps(r, allow_nan=False)


def _risk(f, **kw):
    return compose_risks(
        f.snapshot, f.requests, f.danger, f.travel, f.units, kw.pop("weighed", f.weighed),
        meta=f.meta, cells=f.cells, **kw,
    )[0]


def test_news_hints_flag_risk_without_changing_numbers(recorded):
    from rescue.core.risk import news_context

    f = inputs(recorded)
    base = _risk(f)
    ctx = news_context(SimpleNamespace(news_ok=True, news_evacuation=True, news_closures=2))
    r = _risk(f, context=ctx)
    assert any("evacuation reported" in x for x in r["quality_flags"])
    assert any("2 road-closure" in x for x in r["quality_flags"])
    assert "Other agents:" in r["reason"]
    for k in ("level", "slack_s", "fire_eta_s", "travel_s", "wait_s", "scheduled_slack_s", "probabilities"):
        assert r[k] == base[k]  # news is a hint: it never moves danger, routes or exposure
    assert r["assessment_id"] != base["assessment_id"]  # but the change is a new, traceable assessment
    assert news_context(None) is None and news_context(SimpleNamespace(news_ok=False)) is None
    assert _risk(f, context=None) == base
    json.dumps(r, allow_nan=False)


def test_resident_sighting_is_crosschecked_against_learned_exposure(recorded):
    f = inputs(recorded)  # fixture model: 20% at the shortest horizon; the resident reports a credible sighting
    assert any("sighting not reflected" in x for x in _risk(f)["quality_flags"])
    assert not any("sighting" in x for x in _risk(f, weighed={})["quality_flags"])  # no evidence, no cross-check
    f.cells.clear()  # model output unavailable
    r = _risk(f)
    assert r["probabilities"] == [] and any("sighting is trusted" in x for x in r["quality_flags"])
    assert r["fire_eta_s"] == 3600  # the sighting still drives the physical ETA, via the danger engine



def test_committed_truck_uses_its_route_and_has_no_unit_wait(recorded):
    f = inputs(recorded)
    rid = f.requests[0]['id']
    committed = {rid: dict(request_id=rid, station_id=1, travel_s=1200.0, reachable=True)}
    r = _risk(f, committed=committed)
    assert r['travel_s'] == 1200 and r['wait_s'] == 0
    assert r['scheduled_slack_s'] == 3600 - 1200 - 600 - 300
    committed[rid]['reachable'] = False
    r = _risk(f, committed=committed)
    assert not r['reachable'] and r['travel_s'] is None
    assert r['scheduled_slack_s'] is None
