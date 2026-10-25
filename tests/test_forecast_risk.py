"""Synthetic forecast/serving contracts; no optimizer or fitting calls."""

import json

import numpy as np
import pytest

from rescue.core.geo import Grid
from rescue.forecast_ml.live import ForecastRequest, LearnedForecastBackend, dispatch_policy_name
from rescue.forecast_ml.risk import ForecastProduct, assess_residents, synthetic_residents


def product():
    grid = Grid(39.0, -121.0, 300.0, 3, 4)
    p = np.zeros((2, 3, 4))
    p[0, 1, 1] = 0.25
    p[1, 1, 1] = 0.75
    return ForecastProduct(
        grid, 0.0, [21600.0, 86400.0], p, np.ones((3, 4), bool), np.zeros((3, 4), bool), "fixture", "learned"
    )


def test_probabilities_windows_unknown_and_expiry():
    p = product()
    assert p.window(5) == {"status": "interval", "lower_s": 0.0, "upper_s": 21600.0}
    assert p.window(0)["status"] == "right_censored"
    p.valid[0, 0] = False
    assert p.window(0)["status"] == "unknown"
    residents = synthetic_residents(p.grid, p.valid, pair_id="fixture", count=8)
    rows = assess_residents(p, residents, travel_s={r["request_id"]: 90.0 for r in residents}, now_s=86401.0)
    assert all(r["uncertainty_status"] == "forecast_expired" for r in rows)


def test_probability_bounds_and_horizon_monotonicity():
    p = product()
    with pytest.raises(ValueError, match="decrease"):
        ForecastProduct(p.grid, 0.0, p.horizons_s, p.probabilities[::-1], p.valid, p.observed, "x", "learned")
    bad = p.probabilities.copy()
    bad[0, 1, 1] = 1.1
    with pytest.raises(ValueError, match=r"\[0,1\]"):
        ForecastProduct(p.grid, 0.0, p.horizons_s, bad, p.valid, p.observed, "x", "learned")


def test_resident_lookup_assistance_slack_and_reason_are_deterministic():
    p = product()
    residents = synthetic_residents(p.grid, p.valid, pair_id="fixture", count=12)
    assert residents == synthetic_residents(p.grid, p.valid, pair_id="fixture", count=12)
    routes = {r["request_id"]: 90.0 for r in residents}
    rows = assess_residents(p, residents, travel_s=routes)
    assert rows == assess_residents(p, residents, travel_s=routes)
    for r in rows:
        assert p.grid.locate(r["lat"], r["lon"]) == r["cell_id"]
        assert "assistance" in r["reason"]
        if r["slack_upper_s"] is not None:
            assert r["slack_upper_s"] == r["arrival_window"]["upper_s"] - 90 - r["extract_s"] - 300


def test_safe_default_missing_checkpoint_and_failed_gates(tmp_path):
    assert LearnedForecastBackend().forecast(None).active == "simulation"
    assert "absent" in LearnedForecastBackend("learned", tmp_path / "missing.pt").forecast(None).reason
    assert "unsupported" in LearnedForecastBackend("hybrid").forecast(None).reason
    assert dispatch_policy_name("learned", "learned") == "learned"
    assert dispatch_policy_name("rl", "learned") == "rl"
    model = tmp_path / "fixture.pt"
    model.write_bytes(b"not weights; gate refuses before model load")
    from rescue.forecast_ml.provenance import sha256

    metadata = tmp_path / "metadata.json"
    metadata.write_text(
        json.dumps(
            {
                "deployment": {
                    "trained": True,
                    "feature_schema": "wildfire-supervised-known-perimeters-v2",
                    "checkpoint_sha256": sha256(model),
                    "validation_passed": False,
                    "inference_checked": False,
                }
            }
        )
    )
    result = LearnedForecastBackend("learned", model, metadata).forecast(None)
    assert result.active == "simulation" and "gate failed" in result.reason


def test_future_observation_never_reaches_model():
    p = product()
    request = ForecastRequest(np.zeros((2, 3, 4), bool), [0.0, 2.0], {}, p.grid, p.valid, 1.0, [21600.0])
    with pytest.raises(ValueError, match="future"):
        request.validate()


@pytest.mark.parametrize("value", [None, [], [1], "metadata", {"deployment": None}, {"deployment": []}])
def test_malformed_metadata_falls_back_before_native_load(tmp_path, value):
    model = tmp_path / "not-loaded.pt"
    model.write_bytes(b"synthetic bytes; native loading must never happen")
    metadata = tmp_path / "metadata.json"
    metadata.write_text(json.dumps(value))
    result = LearnedForecastBackend("learned", model, metadata).forecast(None)
    assert result.active == "simulation" and "JSON object" in result.reason


@pytest.mark.parametrize(
    "bounds",
    [
        None,
        [],
        [1],
        [1, 2, 3],
        [0, 2],
        [2, 2],
        [3, 2],
        [1, float("nan")],
        [1, float("inf")],
        ["1", 2],
        [True, 2],
    ],
)
def test_malformed_supported_bounds_fall_back_before_native_load(tmp_path, bounds):
    from rescue.forecast_ml.provenance import sha256

    model = tmp_path / "not-loaded.pt"
    model.write_bytes(b"synthetic bytes; native loading must never happen")
    metadata = tmp_path / "metadata.json"
    metadata.write_text(
        json.dumps(
            {
                "deployment": {
                    "trained": True,
                    "feature_schema": "wildfire-supervised-known-perimeters-v2",
                    "checkpoint_sha256": sha256(model),
                    "validation_passed": True,
                    "inference_checked": True,
                    "model_family": "time_conditioned_unet",
                    "supported_horizon_s": bounds,
                }
            }
        )
    )
    result = LearnedForecastBackend("learned", model, metadata).forecast(None)
    assert result.active == "simulation" and "bounds" in result.reason


@pytest.mark.parametrize("field", ["history", "valid"])
@pytest.mark.parametrize("invalid", [float("nan"), float("inf"), 0.5, -1, 2])
def test_request_rejects_missing_or_nonbinary_masks_before_geography(field, invalid):
    p = product()
    masks = np.zeros((1, 3, 4), dtype=float)
    valid = np.ones((3, 4), dtype=float)
    (masks if field == "history" else valid).flat[0] = invalid
    request = ForecastRequest(masks, [0.0], {}, p.grid, valid, 0.0, [21600.0])
    with pytest.raises(ValueError, match="finite binary"):
        request.validate()


def test_request_rejects_valid_shape_before_geography():
    p = product()
    request = ForecastRequest(
        np.zeros((1, 3, 4), bool), [0.0], {}, p.grid, np.ones((2, 4), bool), 0.0, [21600.0]
    )
    with pytest.raises(ValueError, match="valid mask"):
        request.validate()


@pytest.mark.parametrize(
    "native_state",
    [
        {"trained": False, "actual_parameter_update": True},
        {"trained": True, "actual_parameter_update": False},
    ],
)
def test_native_trained_state_rejects_before_forecast(tmp_path, monkeypatch, native_state):
    from types import SimpleNamespace
    from rescue.forecast_ml.provenance import sha256
    from rescue.forecast_ml import unet

    model = tmp_path / "native-stub.pt"
    model.write_bytes(b"synthetic stub; model tensors are never instantiated")
    metadata = tmp_path / "metadata.json"
    metadata.write_text(
        json.dumps(
            {
                "deployment": {
                    "trained": True,
                    "feature_schema": "wildfire-supervised-known-perimeters-v2",
                    "checkpoint_sha256": sha256(model),
                    "validation_passed": True,
                    "inference_checked": True,
                    "model_family": "time_conditioned_unet",
                    "supported_horizon_s": [21600, 259200],
                    "grid_shape": [128, 128],
                }
            }
        )
    )

    class NativeStub:
        def __init__(self, *args):
            self.metadata = native_state

        def forecast(self, *args, **kwargs):
            raise AssertionError("untrained state must be rejected before inference")

    monkeypatch.setattr(unet, "NativePredictor", NativeStub)
    request = SimpleNamespace(
        validate=lambda: None,
        history_masks=np.zeros((1, 128, 128), bool),
        horizons_s=[21600],
        grid_record={"crs": "EPSG:32610"},
    )
    result = LearnedForecastBackend("learned", model, metadata).forecast(request)
    assert result.active == "simulation" and "demonstrated supervised training" in result.reason


@pytest.mark.parametrize("field", ["history", "valid"])
def test_native_api_rejects_nonfinite_masks_before_any_model_access(field):
    from rescue.forecast_ml.unet import NativePredictor

    # No checkpoint load, parameter initialization, optimizer, or forward call.
    predictor = object.__new__(NativePredictor)
    masks = np.zeros((1, 128, 128), float)
    valid = np.ones((128, 128), float)
    (masks if field == "history" else valid).flat[0] = np.nan
    with pytest.raises(ValueError, match="finite binary"):
        predictor.forecast(masks, [0.0], {"cell_size_m": 250}, [21600], valid)


def test_shared_feature_binary_guard_preserves_existing_bool_inputs():
    from rescue.forecast_ml.unet import known_features

    current = np.zeros((128, 128), bool)
    current[60:65, 60:65] = True
    previous = np.zeros_like(current)
    valid = np.ones_like(current)
    normalization = {"mean": [24, 12, 100], "scale": [10, 12, 50]}
    features = known_features(current, previous, valid, 86400, 0, 250, normalization, history_available=False)
    expected = np.concatenate(
        (
            np.stack((current, previous, previous, valid)),
            np.broadcast_to(np.array([0, -1, 3], np.float32)[:, None, None], (3, 128, 128)),
            np.zeros((1, 128, 128)),
        )
    ).astype(np.float32)
    np.testing.assert_array_equal(features, expected)
    for field in ("current", "previous", "valid"):
        values = {
            "current": current.copy().astype(float),
            "previous": previous.copy().astype(float),
            "valid": valid.copy().astype(float),
        }
        values[field].flat[0] = np.nan
        with pytest.raises(ValueError, match="finite binary"):
            known_features(
                values["current"],
                values["previous"],
                values["valid"],
                86400,
                0,
                250,
                normalization,
                history_available=False,
            )
