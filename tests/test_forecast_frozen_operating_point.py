"""Saved-output diagnostics only; no checkpoint, model import, or fitting."""

import json

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from rescue.forecast_ml import frozen_operating_point as frozen
from rescue.forecast_ml.provenance import sha256


def test_single_issue_front_center_distance_no_future_labels_and_coarse_pixels():
    current = np.zeros((5, 5), bool)
    current[2, 2] = True
    valid = np.ones_like(current)
    front = frozen.front_mask(current, valid, 500)
    assert front.sum() == 12 and not front[2, 2]
    assert front[0, 2] and not front[0, 0]  # inclusive1000m centers, not a pixel-count band
    assert not frozen.front_mask(current, valid, 1500).any()
    assert not frozen.front_mask(np.zeros_like(current), valid, 500).any()
    assert not frozen.front_mask(current, current, 500).any()  # known-only domain
    outside_target = current.copy()
    outside_target[0, 0] = True
    scores, _, _ = frozen.score_region(current, outside_target, np.zeros_like(current, float), valid, front)
    assert scores[0]["counts"]["observed_positive_cells"] == 0
    np.testing.assert_array_equal(front, frozen.front_mask(current, valid, 500))
    with pytest.raises(ValueError, match="meters"):
        frozen.front_mask(current, valid, 0)


def test_growth_only_no_growth_false_positives_both_empty_and_single_class():
    current = np.array([[1, 0], [0, 0]], bool)
    target = current.copy()
    target[0, 1] = True
    probability = np.array([[1, 0.1], [0, 0.08]])
    valid = np.ones_like(current)
    low, high = frozen.score_region(current, target, probability, valid, valid)[0]
    assert low["precision"] == 0.5 and low["recall"] == 1
    assert low["f1"] == pytest.approx(2 / 3) and low["iou_all_defined"] == 0.5
    assert low["counts"]["eligible_cells"] == 3 and low["counts"]["excluded_known_cells"] == 1
    assert high["precision"] is None and high["recall"] == 0 and high["f1"] == 0
    no_growth_low, no_growth_high = frozen.score_region(current, current, probability, valid, valid)[0]
    assert no_growth_low["f1"] == 0 and no_growth_low["iou_all_defined"] == 0
    assert no_growth_low["iou_positive_target"] is None and no_growth_low["recall"] is None
    assert no_growth_high["both_empty"] and no_growth_high["f1"] is None
    assert no_growth_low["roc_auc"] is None and no_growth_low["average_precision"] is None
    assert no_growth_low["prevalence"] == 0 and no_growth_low["brier"] > 0
    empty = frozen.score_region(current, target, probability, valid, current)[0][0]
    assert empty["empty_domain"] and all(empty[key] is None for key in frozen.METRICS)


def test_fixed_equal_width_calibration_bins_include_zero_and_one():
    y = np.array([0, 1, 0, 1], bool)
    p = np.array([0, 0.1, 0.99, 1.0])
    bins = frozen._bins(y, p)
    assert len(bins) == 10
    assert bins[0]["count"] == 1 and bins[1]["count"] == 1 and bins[9]["count"] == 2
    assert sum(b["count"] for b in bins) == 4
    assert sum(b["positive_count"] for b in bins) == 2
    assert sum(b["probability_sum"] for b in bins) == pytest.approx(p.sum())


def test_paired_rates_use_common_defined_pairs_before_group_means():
    current = np.array([[0, 0]], bool)
    target = np.array([[1, 0]], bool)
    valid = np.ones_like(current)
    rows = []
    arrays = {}
    for model in frozen.MODELS:
        probabilities = [np.array([[1, 0.0]]), np.array([[0.0, 0.0]]), np.array([[1, 1.0]])]
        if model == "unet":
            probabilities = [np.array([[1, 1.0]]), np.array([[1, 0.0]]), np.array([[0.0, 0.0]])]
        arrays[model] = (np.tile(target.ravel(), 3), np.concatenate([p.ravel() for p in probabilities]))
        for pair, probability in enumerate(probabilities):
            score = frozen.score_region(current, target, probability, valid, valid)[0][0]
            rows.append({"model": model, "group_id": "g", "pair_id": str(pair), **score})
    result, _ = frozen.summarize(rows, arrays, resamples=20)
    comparison = next(
        r
        for r in result["paired_differences"]
        if r["baseline"] == "persistence" and r["metric"] == "precision"
    )
    # Only pair0 has precision defined for both methods: U-Net0.5 minus baseline1.
    assert comparison["paired_defined_pairs"] == 1
    assert comparison["difference"] == -0.5 and comparison["ci95"] == [-0.5, -0.5]
    assert comparison["excluded_metric_undefined_pairs"] == 2


def saved_fixture(tmp_path, *, mutate_label=False):
    root = tmp_path
    output = root / "frozen_operating_point"
    output.mkdir()
    shape = (3, 3)
    current = np.zeros(shape, bool)
    current[1, 1] = True
    pairs = [
        {
            "pair_id": f"p{i}",
            "group_id": "g",
            "sequence_id": "s",
            "issue_s": float(i * 86400),
            "horizon_s": 86400.0,
        }
        for i in range(2)
    ]
    tables = []
    for model in frozen.MODELS:
        for index, pair in enumerate(pairs):
            target = current.copy()
            if index == 0:
                target[1, 2] = True
            if mutate_label and model == "unet" and index == 0:
                target[0, 0] = True
            probability = current.astype(float)
            if model != "persistence":
                probability[1, 2] = 0.1 if model == "unet" else 0.0625
                probability[0, 2] = 0.08
            order = np.array([8, 0, 5, 2, 6, 1, 3, 7, 4])
            table = pa.table(
                {
                    "model": [model] * 9,
                    "group_id": [pair["group_id"]] * 9,
                    "pair_id": [pair["pair_id"]] * 9,
                    "sequence_id": ["s"] * 9,
                    "cell_id": np.arange(9, dtype=np.int32)[order],
                    "current": current.ravel()[order],
                    "target": target.ravel()[order],
                    "valid": np.ones(9, bool),
                    "probability": probability.ravel()[order],
                    "issue_s": [pair["issue_s"]] * 9,
                    "horizon_s": [86400.0] * 9,
                    "cell_size_m": [500.0] * 9,
                }
            )
            tables.append(table)
    parquet = root / "forecast_predictions.parquet"
    with pq.ParquetWriter(parquet, tables[0].schema) as writer:
        for table in tables:
            writer.write_table(table)
    (root / "metrics.json").write_text('{"original_metric": 0.5}\n')
    (root / "protocol.json").write_text(json.dumps({"grid_shape": list(shape)}))
    (root / "evaluation_pairs.json").write_text(json.dumps(pairs))
    checkpoint_hash = "a" * 64
    training = {
        "selected_seed": 202,
        "selected_epoch": 4,
        "threshold": 0.05,
        "checkpoint_sha256": checkpoint_hash,
        "model_identity": "b" * 16,
        "selected_parameter_hash": "b" * 64,
    }
    (root / "training_runs.json").write_text(json.dumps(training))
    (output / "freeze_receipt.json").write_text(
        json.dumps(
            {
                "selected_seed": 202,
                "selected_epoch": 4,
                "selected_threshold": 0.05,
                "diagnostic_threshold": 0.5,
                "selected_checkpoint_sha256": checkpoint_hash,
                "saved_prediction_sha256": sha256(parquet),
            }
        )
    )
    return root


def test_saved_outputs_protocol_precedes_front_and_original_sources_unchanged(tmp_path, monkeypatch):
    root = saved_fixture(tmp_path)
    original = (root / "metrics.json").read_bytes()
    original_front = frozen.front_mask
    calls = []

    def declared_front(*args):
        protocol = json.loads((root / "frozen_operating_point/protocol.json").read_text())
        assert protocol["front"]["future_targets_in_front_definition"] is False
        assert protocol["front"]["regions_searched"] == 1
        calls.append(1)
        return original_front(*args)

    monkeypatch.setattr(frozen, "front_mask", declared_front)
    result = frozen.diagnose(root)
    assert calls and result["pairs_per_model"] == 2 and result["groups_per_model"] == 1
    assert result["original_metrics_unchanged"] and (root / "metrics.json").read_bytes() == original
    low = result["thresholds"]["0.05"]["domains"]["growth"]["models"]["unet"]
    assert low["macro"]["iou_all_defined"]["estimate"] == 0.25
    assert low["macro"]["iou_positive_target"]["estimate"] == 0.5
    assert low["pooled"]["cell_forecasts"] == 16
    assert sum(b["count"] for b in low["pooled"]["calibration_bins"]) == 16
    assert low["raw_counts"]["no_observed_growth_pairs"] == 1
    assert (root / "frozen_operating_point/metrics.md").is_file()
    assert "need not equal subtraction" in (root / "frozen_operating_point/metrics.md").read_text()
    before_protocol = (root / "frozen_operating_point/protocol.json").read_bytes()
    frozen.diagnose(root)
    assert (root / "frozen_operating_point/protocol.json").read_bytes() == before_protocol
    protocol = json.loads(before_protocol)
    protocol["front"]["radius_m"] = 2000
    (root / "frozen_operating_point/protocol.json").write_text(json.dumps(protocol))
    with pytest.raises(ValueError, match="protocol differs"):
        frozen.diagnose(root)


def test_cross_method_label_leakage_or_mismatch_rejected(tmp_path):
    root = saved_fixture(tmp_path, mutate_label=True)
    with pytest.raises(ValueError, match="different actual labels"):
        frozen.diagnose(root)
