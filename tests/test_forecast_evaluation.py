"""Supervised evaluation/report contracts; no gradient updates or real data."""

import json

import numpy as np
import pyarrow.parquet as pq
import pytest

from rescue.core.fire import FUEL_SEED, FuelMap, Wind, arrival_times
from rescue.core.geo import Grid
from rescue.forecast_ml import evaluation, unet
from rescue.forecast_ml.physical import predict_members
from rescue.forecast_ml.provenance import canonical_dataset_hash, sha256
from rescue.forecast_ml.reports import build_reports


@pytest.mark.parametrize("wind", [Wind(0.0, 0.0), Wind(3.0, 70.0)])
def test_physical_nominal_member_matches_unmodified_core(wind):
    grid = Grid(39.0, -121.0, 80.0, 5, 6)
    current = np.zeros((5, 6), bool)
    current[2, 2] = True
    predicted = predict_members(grid, current, 40000.0, seeds=[17001], wind=wind)[0]
    reference = arrival_times(
        grid, FuelMap.uniform(grid, seed=FUEL_SEED), {grid.cell_id(2, 2): 0.0}, wind, t_max=40000.0
    )
    np.testing.assert_allclose(predicted, reference, rtol=1e-12, atol=1e-9)


def test_test_panel_reuse_requires_explicit_acknowledgement(tmp_path):
    with pytest.raises(ValueError, match="previously inspected"):
        evaluation.evaluate_forecast("unused", None, tmp_path, split="test")


def test_supervised_evaluation_uses_one_forward_and_saves_secondary_threshold(tmp_path, monkeypatch):
    current = np.zeros((128, 128), bool)
    current[64, 64] = True
    target = current.copy()
    target[64, 65] = True
    arrays = tmp_path / "masks.npz"
    np.savez(
        arrays,
        masks=np.stack([current, target, target]),
        valid=np.ones_like(current),
        times_s=np.array([0.0, 86400.0, 172800.0]),
    )
    split = tmp_path / "split.json"
    split.write_text(json.dumps({"groups": [{"group_id": "g", "split": "validation"}]}))
    record = {
        "sequence_id": "s",
        "component_id": "c",
        "group_id": "g",
        "split": "validation",
        "source_row_ids": ["a", "b", "c"],
        "times_s": [0.0, 86400.0, 172800.0],
        "acquisition_s": [0.0, 86400.0, 172800.0],
        "masks_path": str(arrays),
        "masks_sha256": sha256(arrays),
        "grid": {
            "origin_lat": 39.0,
            "origin_lon": -121.0,
            "rows": 128,
            "cols": 128,
            "cell_size_m": 100.0,
            "crs": "EPSG:32610",
            "x_min": 500000.0,
            "y_min": 4300000.0,
        },
        "coverage_fraction": [1.0, 0.5, 0.4],
        "out_of_domain_area_m2": [0.0, 100.0, 200.0],
    }
    pair = {
        "pair_id": "p",
        "sequence_id": "s",
        "group_id": "g",
        "component_id": "c",
        "from_index": 0,
        "to_index": 1,
        "issue_s": 0.0,
        "target_s": 86400.0,
        "horizon_s": 86400.0,
    }
    data = {
        "schema_version": "fire-rl-dataset-v1",
        "archive_sha256": "fixture",
        "split_manifest_path": str(split),
        "split_manifest_sha256": sha256(split),
        "rasterization": "fixture",
        "domain_algorithm": "fixture",
        "sequences": [record],
        "validation_pairs": [pair],
    }
    data["dataset_sha256"] = canonical_dataset_hash(data)
    path = tmp_path / "dataset.json"
    path.write_text(json.dumps(data))
    checkpoint = tmp_path / "best.pt"
    checkpoint.write_bytes(b"synthetic saved model fixture, never loaded")
    training = {
        "trained": True,
        "actual_updates": 1,
        "input_integrity_verified": True,
        "validation": {"complete": True},
        "threshold": 0.2,
        "selected_checkpoint": str(checkpoint),
        "checkpoint_sha256": sha256(checkpoint),
        "dataset_canonical_sha256": data["dataset_sha256"],
        "split_manifest_sha256": data["split_manifest_sha256"],
        "selection_metric": "validation_fixture",
    }
    calls = []

    class FrozenHead:
        threshold = 0.2

        def __init__(self, *args):
            pass

        def predict(self, *args):
            calls.append(1)
            return {
                "probability": current.astype(float) + np.where(target & ~current, 0.3, 0.0),
                "model_version": "fixture",
            }

    monkeypatch.setattr(unet, "UNetPredictor", FrozenHead)
    monkeypatch.setattr(
        evaluation,
        "forecast_baselines",
        lambda *args: {
            name: {"probability": current.astype(float), "latency_ms": 1.0} for name in evaluation.BASELINES
        },
    )
    result = evaluation.evaluate_forecast(path, checkpoint, tmp_path / "report", training_metadata=training)
    assert len(calls) == 1 and result["model_family"] == "time_conditioned_unet"
    assert result["unet"]["new_growth_iou_macro"] == 0
    assert result["secondary_validation_threshold"]["new_growth_iou_macro"] == 1
    assert result["primary_threshold"] == 0.5 and result["validation_selected_threshold"] == 0.2
    table = pq.read_table(tmp_path / "report/forecast_predictions.parquet", filters=[("model", "=", "unet")])
    assert table.column("member_affect_bits").null_count == 16384
    assert result["coverage"]["clipped_pairs"] == 1
    report_dir = tmp_path / "report"
    (report_dir / "training_budget.json").write_text(
        json.dumps(
            {
                "supervised_seconds": 70.0,
                "prior_consumed_seconds": 30.0,
                "combined_seconds": 100.0,
                "cap_seconds": 4500.0,
                "cap_respected": True,
                "training_finished": True,
                "new_training_planned": False,
                "seeds": [],
            }
        )
    )
    (report_dir / "cleanup_migration.json").write_text(
        json.dumps({"removed_owned_paths": ["retired owned code"]})
    )
    (report_dir / "data_immutability_comparison.json").write_text(
        json.dumps(
            {
                "status": "passed",
                "before_file_count": 4,
                "after_file_count": 4,
                "npz_files": 1,
                "clean_geoparquet_files": 1,
            }
        )
    )
    (report_dir / "export_receipt.json").write_text(
        json.dumps(
            {
                "model_family": "time_conditioned_unet",
                "calibration_gate": {"passed": False, "reason": "synthetic failed gate fixture"},
            }
        )
    )
    report = build_reports(report_dir)
    assert (tmp_path / "report/index.html").exists() and report["figures"]
    assert "data:image/png;base64," in (tmp_path / "report/index.html").read_text()
    card = (report_dir / "model_card.md").read_text()
    assert "Combined: 100.000 s" in card and '"passed": false' in card
    assert "PPO" not in card and "retired owned paths" in card
    arrays.write_bytes(arrays.read_bytes() + b"changed NPZ")
    with pytest.raises(ValueError, match="sequence bytes differ"):
        evaluation.evaluate_forecast(path, checkpoint, tmp_path / "changed", training_metadata=training)
    assert len(calls) == 1
