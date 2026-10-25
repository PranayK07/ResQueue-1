"""Saved-output secondary diagnostics; no fitting, inference or primary edits."""

import json

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from rescue.forecast_ml.growth_diagnostics import (
    aggregate_growth_classification,
    diagnose_growth,
    growth_classification,
)
from rescue.forecast_ml.metrics import forecast_metrics


def fixture_arrays():
    current = np.array([[1, 1, 1], [1, 0, 0]], bool)
    target = current.copy()
    target[1, 1] = True
    p = np.array([[1.0, 1.0, 1.0], [1.0, 0.1, 0.9]])
    return current, target, p, np.ones_like(current)


def test_growth_probability_scores_exclude_known_retention():
    current, target, p, valid = fixture_arrays()
    full = forecast_metrics(current, target, p, valid)
    growth = growth_classification(current, target, p, valid)
    assert full["average_precision"] > 0.9
    assert growth["average_precision"] == 0.5 and growth["roc_auc"] == 0
    assert growth["brier"] == pytest.approx(0.81)
    assert growth["n"] == 2 and growth["excluded_known_footprint_cells"] == 4
    assert growth["confusion"] == {"tn": 0, "fp": 1, "fn": 1, "tp": 0}


def test_single_class_and_empty_growth_domain_stay_undefined():
    current, _, _, valid = fixture_arrays()
    score = growth_classification(current, current, current.astype(float), valid)
    assert score["roc_auc"] is None and score["average_precision"] is None
    assert score["brier"] == 0 and score["precision"] is None
    empty = growth_classification(valid, valid, valid.astype(float), valid)
    assert empty["n"] == 0 and empty["accuracy"] is None and empty["brier"] is None


def test_secondary_group_bootstrap_weights_incidents_and_pairs_identically():
    score = growth_classification(*fixture_arrays())
    rows = []
    for model in ["unet", "persistence"]:
        for group, pairs, brier in [("a", 3, 0.0), ("b", 1, 1.0)]:
            for index in range(pairs):
                rows.append(
                    {
                        **score,
                        "model": model,
                        "group_id": group,
                        "pair_id": f"{group}-{index}",
                        "brier": brier,
                    }
                )
    result = aggregate_growth_classification(rows)
    assert result["summary"]["unet"]["brier_macro"] == 0.5
    assert result["summary"]["unet"]["brier_ci95"] == [0.0, 1.0]
    difference = next(r for r in result["paired_confidence_intervals"] if r["metric"] == "brier")
    assert difference["difference"] == 0 and difference["ci95"] == [0.0, 0.0]
    assert result == aggregate_growth_classification(rows)
    with pytest.raises(ValueError, match="identical"):
        aggregate_growth_classification(rows[:-1])


def test_saved_diagnostic_preserves_primary_file_bytes(tmp_path):
    current, target, p, valid = fixture_arrays()
    (tmp_path / "protocol.json").write_text(json.dumps({"grid_shape": [2, 3]}))
    primary = b'{"primary":"frozen, do not modify"}\n'
    (tmp_path / "metrics.json").write_bytes(primary)
    writer = None
    for model, probability in [("unet", p), ("persistence", current.astype(float))]:
        n = current.size
        table = pa.table(
            {
                "model": [model] * n,
                "group_id": ["g"] * n,
                "pair_id": ["pair"] * n,
                "cell_id": np.arange(n),
                "current": current.ravel(),
                "target": target.ravel(),
                "valid": valid.ravel(),
                "probability": probability.ravel(),
                "cell_size_m": np.ones(n),
            }
        )
        if writer is None:
            writer = pq.ParquetWriter(tmp_path / "forecast_predictions.parquet", table.schema)
        writer.write_table(table)
    writer.close()
    result = diagnose_growth(tmp_path)
    assert result["primary_contract_unchanged"] and result["bootstrap_resamples"] == 2000
    assert result["summary"]["unet"]["average_precision_macro"] == 0.5
    assert (tmp_path / "metrics.json").read_bytes() == primary
    assert (tmp_path / "growth_classification_metrics.json").exists()
