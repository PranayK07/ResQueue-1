"""Threshold summaries use saved metrics only; no model is loaded."""

import json

import numpy as np
import pytest

from rescue.forecast_ml.metrics import forecast_metrics
from rescue.forecast_ml.threshold_diagnostics import compare_saved_thresholds


def test_full_footprint_growth_f1_and_conditional_dice_stay_distinct(tmp_path):
    current = np.array([[1, 0], [0, 0]], bool)
    target = current.copy()
    target[0, 1] = True
    examples = [(target, np.array([[1.0, 0.6], [0.0, 0.0]])), (current, np.array([[1.0, 0.0], [0.0, 0.1]]))]
    views = {}
    for threshold in (0.05, 0.5):
        views[threshold] = [
            {
                "model": "unet",
                "group_id": "g",
                "pair_id": str(i),
                **forecast_metrics(current, y, p, threshold=threshold),
            }
            for i, (y, p) in enumerate(examples)
        ]
    primary = json.dumps(views[0.5]).encode()
    (tmp_path / "pair_metrics.json").write_bytes(primary)
    (tmp_path / "metrics.json").write_text('{"primary_threshold":0.5,"test_set_status":"reused diagnostic"}')
    (tmp_path / "validation_threshold_metrics.json").write_text(
        json.dumps({"threshold": 0.05, "pair_metrics": views[0.05]})
    )
    (tmp_path / "forecast_predictions.parquet").write_bytes(
        b"probability source hash fixture; never parsed or inferred"
    )
    result = compare_saved_thresholds(tmp_path)
    low = result["thresholds"]["0.05"]
    assert low["growth_only"]["f1_all_defined_macro"] == 0.5
    assert low["primary_new_growth"]["new_growth_dice_conditional_macro"] == 1
    assert low["primary_new_growth"]["eligible_pairs"] == 1
    assert low["full_footprint"]["f1"] == pytest.approx(5 / 6)
    assert result["thresholds"]["0.5"]["growth_only"]["f1_all_defined_macro"] == 1
    assert (tmp_path / "pair_metrics.json").read_bytes() == primary
    assert (tmp_path / "threshold_comparison.md").exists()
    views[0.05][0]["actual_growth_cells"] = 99
    (tmp_path / "validation_threshold_metrics.json").write_text(
        json.dumps({"threshold": 0.05, "pair_metrics": views[0.05]})
    )
    with pytest.raises(ValueError, match="identical"):
        compare_saved_thresholds(tmp_path)
