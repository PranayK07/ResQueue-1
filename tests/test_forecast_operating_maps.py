"""Frozen maps use saved arrays and the shared issue-front definition only."""

import numpy as np
import pytest

from rescue.forecast_ml.operating_point_maps import (
    growth_masks,
    issue_front,
    named_sequence_choice,
    supplemental_target_example,
)


def test_threshold_maps_exclude_current_and_conserve_observed_growth():
    current = np.zeros((3, 3), bool)
    current[1, 1] = True
    target = current.copy()
    target[1, 2] = True
    valid = np.ones_like(current)
    valid[2, 2] = False
    probability = np.zeros((3, 3))
    probability[1, 1] = 1.0
    probability[1, 2] = 0.06
    probability[0, 1] = 0.6
    probability[2, 2] = np.nan
    selected = growth_masks(current, target, probability, valid, 0.05)
    diagnostic = growth_masks(current, target, probability, valid, 0.5)
    assert (
        selected["predicted"].sum() == 2
        and selected["false_positive"].sum() == 1
        and not selected["missed"].any()
    )
    assert (
        diagnostic["predicted"].sum() == 1
        and diagnostic["false_positive"].sum() == 1
        and diagnostic["missed"].sum() == 1
    )
    for masks in (selected, diagnostic):
        assert not (masks["predicted"] & current).any()
        assert np.array_equal(masks["observed"], (masks["observed"] & masks["predicted"]) | masks["missed"])
        assert np.array_equal(
            masks["predicted"], (masks["observed"] & masks["predicted"]) | masks["false_positive"]
        )
    probability[0, 0] = np.nan
    with pytest.raises(ValueError, match="probability"):
        growth_masks(current, target, probability, valid, 0.05)


def test_front_uses_issue_mask_native_meter_scale_and_empty_is_empty():
    current = np.zeros((3, 3), bool)
    current[1, 1] = True
    valid = np.ones_like(current)
    front = issue_front(current, valid, 1000.0)
    assert front.sum() == 4 and not front[1, 1]
    assert not issue_front(np.zeros_like(current), valid, 1000.0).any()
    assert not issue_front(valid, valid, 1000.0).any()


def test_supplemental_case_uses_only_observed_growth_and_stable_id_tie_break():
    rows = [
        {"model": "unet", "pair_id": key, "actual_growth_cells": count, "new_growth_iou": quality}
        for key, count, quality in [("a", 0, 1.0), ("b", 2, 1.0), ("c", 4, 0.0), ("d", 8, 1.0)]
    ]
    selected = supplemental_target_example(rows)
    assert selected["pair_id"] == "c" and selected["observed_growth_cells"] == 4
    rows[2]["new_growth_iou"] = 1.0
    assert supplemental_target_example(rows) == selected


def test_named_fire_choice_uses_target_size_and_never_prediction_quality():
    rows = [
        {"model": "unet", "sequence_id": sequence, "actual_growth_cells": count, "new_growth_iou": 0.0}
        for sequence, counts in [("a", [10, 10, 10]), ("b", [20, 20, 20]), ("c", [30, 30, 30])]
        for count in counts
    ]
    rows += [
        {"model": "unet", "sequence_id": "excluded", "actual_growth_cells": count}
        for count in [1, 1000, 1000]
    ]
    selected = named_sequence_choice(rows)
    assert selected["sequence_id"] == "b"
    assert selected["eligible_sequences"] == 3 and selected["observed_growth_cell_sum"] == 60
    for row in rows:
        row["new_growth_iou"] = 1.0
    assert named_sequence_choice(rows) == selected
