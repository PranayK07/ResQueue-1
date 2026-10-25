"""Meter bands and saved validation diagnostics use no model or optimizer."""

import json

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from rescue.forecast_ml.boundary_diagnostics import boundary_bands, diagnose_boundary, growth_areas
from rescue.forecast_ml.reports import MODELS


def test_distance_bands_use_projected_meters_and_partition_outside_cells():
    current = np.zeros((3, 3), bool)
    current[1, 1] = True
    bands, distance, counts = boundary_bands(current, np.ones_like(current), 1000.0)
    assert distance[1, 0] == 1000.0 and distance[0, 0] == pytest.approx(np.sqrt(2) * 1000)
    assert bands["0–300m"].sum() == 0
    assert bands["300–1000m"].sum() == 4 and bands["1000–3000m"].sum() == 4
    assert np.all(sum(mask.astype(int) for mask in bands.values()) == ~current)
    assert counts["eligible_outside_cells"] == 8 and counts["unknown_boundary_distance_cells"] == 0


def test_missing_initial_boundary_is_unknown_and_zero_growth_ratios_undefined():
    empty = np.zeros((3, 3), bool)
    valid = ~empty
    bands, _, counts = boundary_bands(empty, valid, 100.0)
    assert counts["unknown_boundary_distance_cells"] == 9 and not any(mask.any() for mask in bands.values())
    areas = growth_areas(empty, empty, np.ones((3, 3)), valid, 100.0)
    assert areas["false_positive_growth_area_m2"] == 90000.0
    assert areas["fp_to_target_growth_area_ratio"] is None
    target = empty.copy()
    target[0, 0] = True
    areas = growth_areas(empty, target, np.ones((3, 3)), valid, 100.0)
    assert areas["fp_to_target_growth_area_ratio"] == 8
    assert areas["predicted_to_target_growth_area_ratio"] == 9


def test_saved_validation_boundary_outputs_and_source_bytes_preserved(tmp_path):
    source = tmp_path / "validation"
    source.mkdir()
    metrics = b'{"evaluation_split":"validation","split_manifest_sha256":"fixture"}'
    (source / "metrics.json").write_bytes(metrics)
    (source / "protocol.json").write_text(json.dumps({"grid_shape": [3, 3]}))
    (source / "evaluation_pairs.json").write_text(json.dumps([{"pair_id": "p1"}]))
    current = np.zeros((3, 3), bool)
    current[1, 1] = True
    target = current.copy()
    target[1, 2] = True
    writer = None
    for model in MODELS:
        probability = (
            current.astype(float) if model == "persistence" else np.ones((3, 3)) * 0.75 + current * 0.25
        )
        n = current.size
        table = pa.table(
            {
                "model": [model] * n,
                "group_id": ["g"] * n,
                "pair_id": ["p1"] * n,
                "cell_id": np.arange(n),
                "current": current.ravel(),
                "target": target.ravel(),
                "valid": np.ones(n, bool),
                "probability": probability.ravel(),
                "cell_size_m": np.full(n, 1000.0),
                "issue_s": np.zeros(n),
                "target_s": np.full(n, 86400.0),
                "horizon_s": np.full(n, 86400.0),
            }
        )
        if writer is None:
            writer = pq.ParquetWriter(source / "forecast_predictions.parquet", table.schema)
        writer.write_table(table)
    writer.close()
    result = diagnose_boundary(source, tmp_path / "diagnostics")
    assert len(result["examples"]) == 1
    raw = json.loads((tmp_path / "diagnostics/boundary_metrics.json").read_text())
    assert raw["by_band"]["0–300m"]["summary"]["unet"]["brier_macro"] is None
    assert raw["whole_growth_domain_areas"]["summary"]["unet"]["fp_to_target_growth_area_ratio_macro"] == 7
    assert (
        raw["whole_growth_domain_areas"]["summary"]["unet"]["pooled_predicted_to_target_growth_area_ratio"]
        == 8
    )
    assert (
        raw["whole_growth_domain_areas"]["summary"]["unet"][
            "pairwise_predicted_to_target_growth_area_ratio_median"
        ]
        == 8
    )
    assert (source / "metrics.json").read_bytes() == metrics
    assert (tmp_path / "diagnostics/boundary_comparison.png").exists()
    assert (tmp_path / "diagnostics/boundary_audit.md").exists()


def test_final_test_is_not_reused_as_boundary_debug_population(tmp_path):
    (tmp_path / "metrics.json").write_text('{"evaluation_split":"test"}')
    with pytest.raises(ValueError, match="validation"):
        diagnose_boundary(tmp_path, tmp_path / "out")
