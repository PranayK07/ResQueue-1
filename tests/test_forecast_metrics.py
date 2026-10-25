"""Synthetic metric contracts; no optimizer/model fitting is performed."""

import numpy as np
import pytest

from rescue.forecast_ml.baselines import growth_extrapolation, persistence
from rescue.forecast_ml.metrics import aggregate, forecast_metrics, paired_bootstrap


def test_raw_regression_cells_are_scored_and_growth_separate():
    current = np.array([[1, 0], [0, 0]], bool)
    target = np.array([[0, 1], [0, 0]], bool)
    result = forecast_metrics(current, target, np.array([[1.0, 0.9], [0.2, 0.1]]), cell_size_m=10)
    assert result["raw_regression_cells"] == 1
    assert result["confusion"] == {"tp": 1, "fp": 1, "fn": 0, "tn": 2}
    assert result["footprint_iou"] == 0.5
    assert result["new_growth_iou"] == 1
    assert result["affected_area_error_m2"] == 100


def test_auc_uses_scores_and_single_class_is_undefined():
    current = np.zeros((2, 2), bool)
    target = np.array([[1, 1], [0, 0]], bool)
    result = forecast_metrics(current, target, np.array([[0.4, 0.3], [0.2, 0.1]]))
    assert result["roc_auc"] == 1
    assert result["average_precision"] == 1
    assert result["recall"] == 0
    empty = forecast_metrics(current, current, np.zeros((2, 2)))
    assert empty["roc_auc"] is None and empty["balanced_accuracy"] is None
    assert empty["new_growth_iou"] is None and empty["growth_both_empty"]


def test_unknown_domain_excluded_counted_and_probabilities_validated():
    result = forecast_metrics(
        np.zeros((2, 2)),
        np.zeros((2, 2)),
        np.array([[0.0, np.nan], [0.0, 0.0]]),
        np.array([[1, 1], [0, 0]], bool),
    )
    assert result["n"] == 1 and result["unknown_cells"] == 1
    with pytest.raises(ValueError):
        forecast_metrics(np.zeros((2, 2)), np.zeros((2, 2)), np.ones((2, 2)) * 2)


def test_primary_population_is_observed_growth_positive_for_every_method():
    rows = []
    for model in ["unet", "persistence"]:
        for pair, actual, score in [("growth", 2, 0.0), ("empty", 0, 1.0)]:
            rows.append(
                {
                    "model": model,
                    "group_id": "g",
                    "pair_id": pair,
                    "actual_growth_cells": actual,
                    "new_growth_iou": score,
                }
            )
    result = aggregate(rows)
    assert result["unet"]["new_growth_iou_macro"] == 0
    assert result["persistence"]["new_growth_iou_macro"] == 0
    assert result["unet"]["primary_actual_growth_positive_pairs"] == 1
    ci = paired_bootstrap(rows, "unet", "persistence", resamples=100)
    assert ci["difference"] == 0 and ci["ci95"] == [0, 0]
    with pytest.raises(ValueError):
        paired_bootstrap(rows[:-1], "unet", "persistence")


def test_growth_baseline_only_uses_available_observations_and_scales_physically():
    prior = np.zeros((9, 9), bool)
    prior[4, 4] = 1
    current = prior.copy()
    current[3:6, 3:6] = 1
    prediction, metadata = growth_extrapolation(current, prior, 24 * 3600, 24 * 3600, 100)
    assert np.all(prediction[current] == 1) and prediction.sum() > current.sum()
    assert metadata["radial_rate_mps"] > 0
    fallback, metadata = growth_extrapolation(current, None, 86400, None, 100)
    assert np.array_equal(fallback, persistence(current)) and metadata["fallback"]
