"""Supervised feature/model/loss/native contracts; no optimizer or fitting in CI."""

import copy
import json
import sys
import time

import numpy as np
import pytest
import torch

from rescue.forecast_ml.unet import (
    ARCHITECTURE,
    FEATURE_SCHEMA,
    FEATURE_NAMES,
    ForecastPairDataset,
    NativePredictor,
    TimeConditionedUNet,
    _parameter_hash,
    _save_native,
    cumulative_probability,
    known_features,
    normalization_for_records,
    segmentation_loss,
    training_class_counts,
)
from rescue.forecast_ml.train_supervised import _config, validate


def sequence(split="train", group="fixture-group"):
    masks = np.zeros((3, 128, 128), bool)
    masks[0, 60:65, 60:65] = True
    masks[1, 59:66, 59:66] = True
    masks[2, 58:67, 58:67] = True
    return {
        "masks": masks,
        "valid": np.ones((128, 128), bool),
        "times_s": np.array([0, 86400, 172800.0]),
        "acquisition_s": [0.0, 86400.0, 172800.0],
        "grid": {"cell_size_m": 250.0, "rows": 128, "cols": 128},
        "group_id": group,
        "sequence_id": "fixture",
        "component_id": "fixture-component",
        "split": split,
    }


def metadata(model, norm, pos_weight=2.0):
    identity = _parameter_hash(model)
    return {
        "feature_schema": FEATURE_SCHEMA,
        "feature_names": FEATURE_NAMES,
        "architecture": ARCHITECTURE,
        "normalization": norm,
        "calibration": {"pos_weight": pos_weight},
        "trained": False,
        "model_identity": identity[:16],
        "parameter_hash_after": identity,
        "threshold": 0.2,
    }


def test_target_isolation_explicit_history_and_train_only_normalization():
    record = sequence()
    norm = normalization_for_records([record])
    row = ForecastPairDataset([record], norm)[0]
    changed = copy.deepcopy(record)
    changed["masks"][1:] = ~changed["masks"][1:]
    later = ForecastPairDataset([changed], norm)[0]
    assert row["inputs"].shape == (8, 128, 128)
    assert row["target"].shape == (1, 128, 128)
    assert torch.equal(row["inputs"], later["inputs"])
    assert not torch.equal(row["target"], later["target"])
    assert not row["inputs"][1].any() and not row["inputs"][2].any() and not row["inputs"][7].any()
    assert ForecastPairDataset([record], norm)[1]["inputs"][7].all()
    assert norm["fit_pairs"] == 2 and not norm["uses_target_pixels"]
    with pytest.raises(ValueError, match="training records"):
        normalization_for_records([sequence("test")])


def test_forward_shapes_skip_network_and_prior_corrected_probability_no_updates():
    torch.set_num_threads(1)
    record = sequence()
    norm = normalization_for_records([record])
    row = ForecastPairDataset([record], norm)[0]
    model = TimeConditionedUNet()
    before = _parameter_hash(model)
    logits = model(row["inputs"][None])
    assert logits.shape == (1, 1, 128, 128)
    probability = cumulative_probability(logits, row["current"][None], 10.0)
    assert torch.isfinite(probability).all()
    assert ((probability >= 0) & (probability <= 1)).all()
    assert (probability[row["current"][None]] == 1).all()
    zeros = torch.zeros((1, 1, 2, 2))
    corrected = cumulative_probability(zeros, torch.zeros_like(zeros).bool(), 10)
    assert corrected.mean().item() == pytest.approx(1 / 11)
    assert _parameter_hash(model) == before
    with pytest.raises(ValueError, match="predeclared architecture"):
        TimeConditionedUNet(8, 2)


def test_loss_never_trains_regression_or_invalid_cells_and_raw_labels_unchanged():
    logits = torch.zeros((1, 1, 2, 2), requires_grad=True)
    current = torch.tensor([[[[True, False], [False, False]]]])
    valid = torch.tensor([[[[True, True], [False, True]]]])
    target = torch.tensor([[[[0.0, 1.0], [1.0, 0.0]]]])
    original = target.clone()
    loss, parts = segmentation_loss(logits, current, target, valid, pos_weight=3)
    gradient = torch.autograd.grad(loss, logits)[0]
    assert parts["growth_domain_cells"].item() == 2
    assert parts["bce"].item() == pytest.approx(2 * np.log(2))
    assert gradient[0, 0, 0, 0].item() == 0 and gradient[0, 0, 1, 0].item() == 0
    assert gradient[0, 0, 0, 1].item() < 0 and gradient[0, 0, 1, 1].item() > 0
    assert torch.equal(target, original)
    assert loss.item() == pytest.approx(parts["bce"].item() + 0.2 * (1 - parts["growth_soft_dice"].item()))


def test_train_only_class_counts_actual_domain_and_clamp():
    record = sequence()
    data = ForecastPairDataset([record], normalization_for_records([record]))
    counts = training_class_counts(data)
    assert counts["positive_cells"] == (49 - 25) + (81 - 49)
    assert counts["negative_cells"] == 2 * 128 * 128 - 49 - 81
    assert counts["pos_weight"] == 50
    assert counts["partition"] == "train"
    other = ForecastPairDataset([sequence("validation")], data.normalization)
    with pytest.raises(ValueError, match="training records"):
        training_class_counts(other)


def test_native_reload_exact_feature_parity_and_monotone_forecast(tmp_path):
    torch.set_num_threads(1)
    record = sequence()
    norm = normalization_for_records([record])
    model = TimeConditionedUNet()
    meta = metadata(model, norm)
    checkpoint = tmp_path / "untrained-shape-fixture.pt"
    _save_native(checkpoint, model, None, meta)
    predictor = NativePredictor(checkpoint)
    pair = {"from_index": 0, "to_index": 1, "horizon_s": 86400.0}
    result = predictor.predict(record, pair)
    row = ForecastPairDataset([record], norm)[0]
    with torch.inference_mode():
        expected = cumulative_probability(model(row["inputs"][None]), row["current"][None], 2)[0, 0].numpy()
    np.testing.assert_array_equal(result["probability"], expected)
    changed = copy.deepcopy(record)
    changed["masks"][1:] = ~changed["masks"][1:]
    np.testing.assert_array_equal(predictor.predict(changed, pair)["probability"], expected)
    forecast = predictor.forecast(
        record["masks"][:1], record["times_s"][:1], record["grid"], [21600, 86400, 259200], record["valid"]
    )
    assert np.all(np.diff(forecast["probabilities"], axis=0) >= 0)
    assert forecast["ensemble_size"] is None and "members" not in forecast and "arrival" not in forecast
    assert result["threshold"] == 0.2
    with pytest.raises(ValueError, match="normalization differs"):
        NativePredictor(checkpoint, {**meta, "normalization": {**norm, "scale": [1, 1, 1]}})
    with pytest.raises(ValueError, match="checksum"):
        NativePredictor(checkpoint, {**meta, "checkpoint_sha256": "wrong"})
    _save_native(checkpoint, model, None, {**meta, "model_identity": "wrong"})
    with pytest.raises(ValueError, match="identity"):
        NativePredictor(checkpoint)


def test_validation_macro_threshold_grid_without_fitting(tmp_path):
    torch.set_num_threads(1)
    train = sequence()
    validation = sequence("validation")
    norm = normalization_for_records([train])
    data = ForecastPairDataset([validation], norm)
    model = TimeConditionedUNet()
    before = _parameter_hash(model)
    score, rows = validate(
        model,
        data,
        pos_weight=10,
        thresholds=[0.05, 0.1, 0.2, 0.3, 0.4, 0.5],
        batch_size=2,
        deadline=time.monotonic() + 30,
    )
    assert score["complete"] and score["pairs"] == 2 and score["groups"] == 1
    assert len(score["threshold_grid_scores"]) == 6
    assert len(rows) == 2 and all(r["actual_growth_cells"] > 0 for r in rows)
    assert np.isfinite(score["macro_brier"])
    assert _parameter_hash(model) == before
    json.dumps(score, allow_nan=False)


def test_explicit_training_config_and_no_rl_imports():
    cfg = _config({})
    assert cfg["epochs"] == 20 and cfg["patience"] == 5 and cfg["growth_dice_weight"] == 0.2
    assert cfg["batch_size"] == 16 and cfg["num_workers"] == 0
    with pytest.raises(ValueError, match="fixed"):
        _config({"epochs": 1})
    assert not any(
        name.startswith("stable_baselines3") or name.startswith("gymnasium") for name in sys.modules
    )


def test_physical_feature_guards_and_horizon():
    record = sequence()
    norm = normalization_for_records([record])
    with pytest.raises(ValueError, match="physical"):
        known_features(record["masks"][0], record["masks"][0], record["valid"], 86400, -1, 250, norm)
    with pytest.raises(ValueError, match="physical"):
        known_features(record["masks"][0], record["masks"][0], record["valid"], 100, 0, 250, norm)
