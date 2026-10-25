"""Fictional resident analysis reads frozen arrays only; no model is loaded."""

import json

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from rescue.core.geo import Grid
from rescue.forecast_ml import resident_eval


def test_resident_probability_scoring_uses_saved_probabilities_and_empty_is_undefined():
    score = resident_eval.resident_probability_metrics([0.2, 0.8], [0, 1])
    assert score["resident_brier"] == pytest.approx(0.04)
    assert score["resident_calibration_ece"] == pytest.approx(0.2)
    assert score["resident_prevalence"] == 0.5 and score["resident_count"] == 2
    assert sum(b["count"] for b in score["resident_calibration"]) == 2
    empty = resident_eval.resident_probability_metrics([], [])
    assert empty["resident_brier"] is None and empty["resident_calibration_ece"] is None
    one_class = resident_eval.resident_probability_metrics([0.1, 0.1], [0, 0])
    assert one_class["resident_brier"] == pytest.approx(0.01)
    with pytest.raises(ValueError, match="probability"):
        resident_eval.resident_probability_metrics([1.2], [0])


def test_resident_intervals_bootstrap_whole_incidents_and_preserve_macro_weight():
    rows = []
    for model in ["unet", "persistence"]:
        for group, count, value in [("a", 3, 1.0), ("b", 1, 0.0), ("undefined", 1, None)]:
            for pair in range(count):
                rows.append(
                    {
                        "model": model,
                        "group_id": group,
                        "pair_id": f"{group}-{pair}",
                        "metrics": {
                            "topk_recall": value,
                            "topk_precision": value,
                            "known_order_agreement": value,
                        },
                    }
                )
    result = resident_eval.summarize_residents(rows)
    score = result["summary"]["unet"]
    assert score["topk_recall_macro"] == 0.5  # group means, not pooled pair mean .75
    assert score["topk_recall_ci95"] == [0.0, 1.0]
    assert score["admitted_incident_groups"] == 3 and score["topk_recall_defined_groups"] == 2
    assert result["bootstrap"]["resamples"] == 2000 and result["bootstrap"]["unit"] == "whole incident group"
    difference = next(row for row in result["paired_confidence_intervals"] if row["metric"] == "topk_recall")
    assert difference["difference"] == 0 and difference["ci95"] == [0.0, 0.0]
    assert result == resident_eval.summarize_residents(rows)
    with pytest.raises(ValueError, match="identical"):
        resident_eval.summarize_residents(rows[:-1])


def test_first_observed_membership_intervals_and_right_censoring():
    masks = np.zeros((3, 2, 2), bool)
    masks[1:, 0, 0] = True
    masks[2, 0, 1] = True
    seq = {"masks": masks, "times_s": np.array([100.0, 200.0, 400.0])}
    residents = [{"cell_id": 0}, {"cell_id": 1}, {"cell_id": 3}]
    assert resident_eval.observed_intervals(seq, 0, residents) == [
        (0.0, 100.0),
        (100.0, 300.0),
        (300.0, None),
    ]


def test_fixed_ensemble_bootstrap_stability_and_tie_disclosure():
    bits = np.array([65535, 0, 0], np.uint16)
    one = resident_eval.ranking_stability(bits, [1.0, 0.0, 0.0], seed=23, k=1)
    assert one == resident_eval.ranking_stability(bits, [1.0, 0.0, 0.0], seed=23, k=1)
    assert one["mean_topk_jaccard"] == 1
    assert one["selection_frequency"] == [1.0, 0.0, 0.0] and not one["cutoff_tie"]
    ties = resident_eval.ranking_stability(np.zeros(3, np.uint16), [0.0, 0.0, 0.0], seed=23, k=1)
    assert ties["mean_topk_jaccard"] == 1 and ties["cutoff_tie"]
    assert resident_eval.ranking_stability([], [], seed=23)["mean_topk_jaccard"] is None
    with pytest.raises(ValueError, match="positive"):
        resident_eval.ranking_stability(bits, [1.0, 0.0, 0.0], seed=23, k=0)


def test_previously_affected_revision_has_unknown_first_arrival():
    masks = np.zeros((3, 2, 2), bool)
    masks[0, 0, 0] = True
    masks[2, 0, 0] = True
    seq = {"masks": masks, "times_s": np.array([100.0, 200.0, 400.0])}
    assert resident_eval.observed_intervals(seq, 1, [{"cell_id": 0}, {"cell_id": 3}]) == [
        (None, None),
        (200.0, None),
    ]


def test_resident_evaluation_uses_saved_members_and_is_reproducible(tmp_path, monkeypatch):
    grid = Grid(39.0, -121.0, 300.0, 4, 4)
    masks = np.zeros((3, 4, 4), bool)
    masks[:, 1, 1] = True
    masks[1:, 2, 2] = True
    masks[2, 0, 3] = True
    seq = {
        "masks": masks,
        "times_s": np.array([100.0, 86500.0, 172900.0]),
        "grid": {},
        "valid": np.ones((4, 4), bool),
    }
    record = {"sequence_id": "seq", "group_id": "g", "component_id": "component", "split": "test"}
    dataset = {"sequences": [record]}
    pair = {
        "pair_id": "fixture-pair",
        "sequence_id": "seq",
        "group_id": "g",
        "component_id": "component",
        "from_index": 0,
        "to_index": 1,
        "issue_s": 100.0,
        "target_s": 86500.0,
        "horizon_s": 86400.0,
    }
    monkeypatch.setattr(resident_eval, "load_dataset", lambda _: dataset)
    monkeypatch.setattr(resident_eval, "load_sequence", lambda _: seq)
    monkeypatch.setattr(resident_eval, "grid_from_record", lambda _: grid)
    (tmp_path / "evaluation_pairs.json").write_text(json.dumps([pair]))
    writer = None
    for model in ["persistence", "existing_physical", "growth_extrapolation", "unet"]:
        p = masks[0].astype(float)
        if model != "persistence":
            p[2, 2] = 0.75
        bits = np.zeros((4, 4), np.uint16)
        bits[p == 1] = 65535
        bits[p == 0.75] = 4095
        n = grid.size
        table = pa.table(
            {
                "model": [model] * n,
                "pair_id": [pair["pair_id"]] * n,
                "cell_id": np.arange(n),
                "current": masks[0].ravel(),
                "target": masks[1].ravel(),
                "valid": np.ones(n, bool),
                "probability": p.ravel(),
                "member_affect_bits": bits.ravel(),
            }
        )
        if writer is None:
            writer = pq.ParquetWriter(tmp_path / "forecast_predictions.parquet", table.schema)
        writer.write_table(table)
    writer.close()
    result = resident_eval.evaluate_residents("not-read", tmp_path, count=10, k=3)
    assert result == resident_eval.evaluate_residents("not-read", tmp_path, count=10, k=3)
    assert result["completed_handoffs"] is None
    assert len(result["rows"]) == 4 and set(result["summary"]) == {
        "persistence",
        "existing_physical",
        "growth_extrapolation",
        "unet",
    }
    placements = [{r["request_id"]: r["cell_id"] for r in row["residents"]} for row in result["rows"]]
    assert all(cells == placements[0] for cells in placements)
    for row in result["rows"]:
        assert row["synthetic"] and row["stability"]["mean_topk_jaccard"] is not None
        assert all(r["uncertainty_status"] == "commander_review" for r in row["residents"])
        assert row["metrics"]["resident_count"] == 10
        assert row["metrics"]["resident_brier"] is not None
        assert row["metrics"]["resident_calibration_ece"] is not None
    assert result["bootstrap"]["resamples"] == 2000
    assert result["summary"]["unet"]["resident_brier_ci95"] is not None
    # An optional probability head must never acquire fake member uncertainty.
    unet_table = table.set_column(table.schema.get_field_index("model"), "model", pa.array(["unet"] * n))
    unet_table = unet_table.set_column(
        unet_table.schema.get_field_index("member_affect_bits"),
        "member_affect_bits",
        pa.array([None] * n, type=pa.uint16()),
    )
    pq.write_table(unet_table, tmp_path / "forecast_predictions.parquet")
    unet_result = resident_eval.evaluate_residents("not-read", tmp_path, count=10, k=3)
    assert unet_result["rows"][0]["metrics"]["ensemble_topk_jaccard"] is None
    # Malformed persisted grids and labels must fail before resident assessment.
    bad_ids = np.arange(n)
    bad_ids[1] = 0
    malformed = table.set_column(table.schema.get_field_index("cell_id"), "cell_id", pa.array(bad_ids))
    pq.write_table(malformed, tmp_path / "forecast_predictions.parquet")
    with pytest.raises(ValueError, match="duplicate or missing"):
        resident_eval.evaluate_residents("not-read", tmp_path, count=10, k=3)
    wrong_target = masks[1].ravel().copy()
    wrong_target[0] = True
    malformed = table.set_column(table.schema.get_field_index("target"), "target", pa.array(wrong_target))
    pq.write_table(malformed, tmp_path / "forecast_predictions.parquet")
    with pytest.raises(ValueError, match="labels differ"):
        resident_eval.evaluate_residents("not-read", tmp_path, count=10, k=3)
    malformed = table.append_column("issue_s", pa.array(np.full(n, 9999.0)))
    pq.write_table(malformed, tmp_path / "forecast_predictions.parquet")
    with pytest.raises(ValueError, match="clock differs"):
        resident_eval.evaluate_residents("not-read", tmp_path, count=10, k=3)
