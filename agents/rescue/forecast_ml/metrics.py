"""Forecast metrics on observed geographic cells, without training or fitting.

Masks are south-up [row,col]; cell_size_m is projected meters per pixel.
Primary growth IoU/Dice use the same observed-growth-positive pairs for all
methods. Descriptive both-empty cases are undefined and counted separately.
Incident means precede macro averages and bootstrap units are entire incidents.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Iterable

import numpy as np

THRESHOLD = 0.5
BOOTSTRAP_RESAMPLES = 2000
BOOTSTRAP_SEED = 20261024
METRIC_KEYS = (
    "new_growth_iou",
    "new_growth_dice",
    "footprint_iou",
    "footprint_dice",
    "new_growth_iou_all_defined",
    "new_growth_dice_all_defined",
    "accuracy",
    "balanced_accuracy",
    "precision",
    "recall",
    "f1",
    "roc_auc",
    "average_precision",
    "brier",
    "log_loss",
    "calibration_ece",
    "new_growth_precision",
    "new_growth_recall",
    "new_growth_brier",
    "affected_area_error_m2",
    "false_positive_growth_area_m2",
    "false_negative_growth_area_m2",
    "boundary_mean_distance_m",
    "boundary_hausdorff95_m",
    "prevalence",
    "resident_topk_recall",
)


def _ratio(numerator: float, denominator: float) -> float | None:
    return float(numerator / denominator) if denominator else None


def calibration_bins(y: np.ndarray, p: np.ndarray, bins: int = 10) -> list[dict[str, Any]]:
    """Uniform probability bins; endpoints0 and1 are included exactly once."""
    result = []
    indices = np.minimum((p * bins).astype(int), bins - 1)
    for index in range(bins):
        selected = indices == index
        count = int(selected.sum())
        result.append(
            {
                "lower": index / bins,
                "upper": (index + 1) / bins,
                "count": count,
                "mean_probability": float(p[selected].mean()) if count else None,
                "observed_fraction": float(y[selected].mean()) if count else None,
                "probability_sum": float(p[selected].sum()),
                "positive_count": int(y[selected].sum()),
            }
        )
    return result


def forecast_metrics(
    current: np.ndarray,
    target: np.ndarray,
    probability: np.ndarray,
    valid: np.ndarray | None = None,
    *,
    cell_size_m: float = 1.0,
    threshold: float = THRESHOLD,
) -> dict[str, Any]:
    """Score raw later observations; regression cells are not silently removed.

    New-growth metrics restrict truth and predictions to cells outside current.
    ROC/AP use probabilities and are undefined for one observed class. Boundary
    distances are symmetric on eight-neighbor mask boundaries, in projected m.
    """
    from scipy.ndimage import binary_erosion, distance_transform_edt
    from sklearn.metrics import average_precision_score, roc_auc_score

    current, target, probability = map(np.asarray, (current, target, probability))
    if current.shape != target.shape or target.shape != probability.shape or current.ndim != 2:
        raise ValueError("current/target/probability must have identical2D geographic shape")
    if not np.isfinite(cell_size_m) or cell_size_m <= 0 or not 0 < threshold < 1:
        raise ValueError("positive finite meters per pixel and probability threshold required")
    mask = np.ones(target.shape, bool) if valid is None else np.asarray(valid, bool)
    if mask.shape != target.shape:
        raise ValueError("valid mask must match the geographic grid")
    known = mask & np.isfinite(probability) & np.isfinite(target) & np.isfinite(current)
    if not np.isin(target[known], [0, 1]).all() or not np.isin(current[known], [0, 1]).all():
        raise ValueError("observed masks must be binary")
    p = probability[known].astype(float)
    if np.any((p < 0) | (p > 1)):
        raise ValueError("known forecast probabilities must lie in[0,1]")
    out = {key: None for key in METRIC_KEYS}
    n = int(known.sum())
    out.update(
        n=n,
        unknown_cells=int(mask.sum() - n),
        valid_domain_cells=int(mask.sum()),
        threshold=threshold,
        cell_size_m=cell_size_m,
    )
    if not n:
        out.update(
            undefined_reason="no known observed/predicted cells",
            confusion={"tn": 0, "fp": 0, "fn": 0, "tp": 0},
            calibration=[],
        )
        return out
    y = target[known].astype(bool)
    pred = p >= threshold
    tp, fp = int((pred & y).sum()), int((pred & ~y).sum())
    fn, tn = int((~pred & y).sum()), int((~pred & ~y).sum())
    bins = calibration_bins(y, p)
    classes = np.unique(y).size
    clipped = np.clip(p, 1e-7, 1 - 1e-7)
    out.update(
        accuracy=(tp + tn) / n,
        balanced_accuracy=(tp / (tp + fn) + tn / (tn + fp)) / 2 if classes == 2 else None,
        precision=_ratio(tp, tp + fp),
        recall=_ratio(tp, tp + fn),
        f1=_ratio(2 * tp, 2 * tp + fp + fn),
        footprint_iou=_ratio(tp, tp + fp + fn),
        footprint_dice=_ratio(2 * tp, 2 * tp + fp + fn),
        roc_auc=float(roc_auc_score(y, p)) if classes == 2 else None,
        average_precision=float(average_precision_score(y, p)) if classes == 2 else None,
        brier=float(np.mean((p - y) ** 2)),
        log_loss=float(-np.mean(y * np.log(clipped) + (~y) * np.log1p(-clipped))),
        calibration_ece=sum(
            b["count"] * abs(b["mean_probability"] - b["observed_fraction"]) for b in bins if b["count"]
        )
        / n,
        calibration=bins,
        confusion={"tn": tn, "fp": fp, "fn": fn, "tp": tp},
        prevalence=float(y.mean()),
        observed_positive_cells=int(y.sum()),
        predicted_positive_cells=int(pred.sum()),
        affected_area_error_m2=(int(pred.sum()) - int(y.sum())) * cell_size_m**2,
        raw_regression_cells=int((current.astype(bool) & ~target.astype(bool) & known).sum()),
        single_class=classes == 1,
    )
    growth_domain = known & ~current.astype(bool)
    growth_y = target[growth_domain].astype(bool)
    growth_p = probability[growth_domain]
    growth_pred = growth_p >= threshold
    gtp, gfp = int((growth_y & growth_pred).sum()), int((~growth_y & growth_pred).sum())
    gfn = int((growth_y & ~growth_pred).sum())
    out.update(
        new_growth_iou=_ratio(gtp, gtp + gfp + gfn),
        new_growth_dice=_ratio(2 * gtp, 2 * gtp + gfp + gfn),
        new_growth_iou_all_defined=_ratio(gtp, gtp + gfp + gfn),
        new_growth_dice_all_defined=_ratio(2 * gtp, 2 * gtp + gfp + gfn),
        new_growth_precision=_ratio(gtp, gtp + gfp),
        new_growth_recall=_ratio(gtp, gtp + gfn),
        new_growth_brier=float(np.mean((growth_p - growth_y) ** 2)) if growth_y.size else None,
        actual_growth_cells=int(growth_y.sum()),
        predicted_growth_cells=int(growth_pred.sum()),
        growth_both_empty=gtp + gfp + gfn == 0,
        growth_confusion={"tp": gtp, "fp": gfp, "fn": gfn, "tn": int((~growth_y & ~growth_pred).sum())},
        false_positive_growth_area_m2=gfp * cell_size_m**2,
        false_negative_growth_area_m2=gfn * cell_size_m**2,
        overgrowth_fraction=gfp / max(1, int(growth_domain.sum())),
    )
    observed_mask = target.astype(bool) & known
    predicted_mask = (probability >= threshold) & known
    boundary_y = observed_mask & ~binary_erosion(observed_mask, structure=np.ones((3, 3)), border_value=0)
    boundary_p = predicted_mask & ~binary_erosion(predicted_mask, structure=np.ones((3, 3)), border_value=0)
    if boundary_y.any() and boundary_p.any():
        distances = (
            np.r_[
                distance_transform_edt(~boundary_y)[boundary_p],
                distance_transform_edt(~boundary_p)[boundary_y],
            ]
            * cell_size_m
        )
        out["boundary_mean_distance_m"] = float(distances.mean())
        out["boundary_hausdorff95_m"] = float(np.quantile(distances, 0.95))
    return out


def per_incident(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    groups = defaultdict(list)
    for row in rows:
        groups[(row["model"], row["group_id"])].append(row)
    result = []
    for (model, group), values in sorted(groups.items()):
        record = {
            "model": model,
            "group_id": group,
            "pairs": len(values),
            "growth_both_empty_pairs": sum(v.get("growth_both_empty", False) for v in values),
        }
        for key in METRIC_KEYS:
            numbers = [
                v[key]
                for v in values
                if v.get(key) is not None
                and np.isfinite(v[key])
                and (key not in {"new_growth_iou", "new_growth_dice"} or v.get("actual_growth_cells", 0) > 0)
            ]
            record[key] = float(np.mean(numbers)) if numbers else None
            record[key + "_defined_pairs"] = len(numbers)
        result.append(record)
    return result


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    grouped = per_incident(rows)
    result = {}
    for model in sorted({r["model"] for r in rows}):
        incidents = [r for r in grouped if r["model"] == model]
        model_rows = [r for r in rows if r["model"] == model]
        summary = {
            "incident_groups": len(incidents),
            "forecast_pairs": len(model_rows),
            "growth_both_empty_pairs": sum(r.get("growth_both_empty", False) for r in model_rows),
            "primary_actual_growth_positive_pairs": sum(
                r.get("actual_growth_cells", 0) > 0 for r in model_rows
            ),
            "primary_population": "common observed-growth-positive pairs for all methods",
        }
        no_growth = [r for r in model_rows if r.get("actual_growth_cells") == 0]
        summary["no_actual_growth_pairs"] = len(no_growth)
        for key in ("false_positive_growth_area_m2", "new_growth_brier", "overgrowth_fraction"):
            numbers = [r[key] for r in no_growth if r.get(key) is not None]
            summary["no_actual_growth_" + key + "_pooled_pair_mean"] = (
                float(np.mean(numbers)) if numbers else None
            )
        for key in METRIC_KEYS:
            numbers = [r[key] for r in incidents if r[key] is not None]
            summary[key + "_macro"] = float(np.mean(numbers)) if numbers else None
            summary[key + "_median"] = float(np.median(numbers)) if numbers else None
            summary[key + "_defined_groups"] = len(numbers)
        result[model] = summary
    return result


def paired_bootstrap(
    rows: list[dict[str, Any]],
    model: str,
    baseline: str,
    *,
    metric="new_growth_iou",
    resamples=BOOTSTRAP_RESAMPLES,
    seed=BOOTSTRAP_SEED,
) -> dict[str, Any]:
    """Paired whole-incident bootstrap; defined paired groups only, disclosed."""
    left = {r["group_id"]: r for r in per_incident(rows) if r["model"] == model}
    right = {r["group_id"]: r for r in per_incident(rows) if r["model"] == baseline}
    if left.keys() != right.keys():
        raise ValueError("paired bootstrap requires identical incident membership")
    keys = {(r["group_id"], r["pair_id"]) for r in rows if r["model"] == model}
    if keys != {(r["group_id"], r["pair_id"]) for r in rows if r["model"] == baseline}:
        raise ValueError("paired bootstrap requires identical forecast-pair membership")
    groups = sorted(g for g in left if left[g].get(metric) is not None and right[g].get(metric) is not None)
    result = {
        "metric": metric,
        "model": model,
        "baseline": baseline,
        "bootstrap_unit": "incident_group",
        "resamples": resamples,
        "seed": seed,
        "paired_defined_groups": len(groups),
        "admitted_groups": len(left),
        "difference": None,
        "ci95": None,
    }
    if not groups:
        return result
    difference = np.asarray([left[g][metric] - right[g][metric] for g in groups])
    rng = np.random.default_rng(seed)
    means = difference[rng.integers(0, len(groups), size=(resamples, len(groups)))].mean(axis=1)
    result.update(
        difference=float(difference.mean()),
        ci95=[float(x) for x in np.quantile(means, [0.025, 0.975])],
        limitation="one incident; engineering interval only" if len(groups) == 1 else None,
    )
    return result


def resident_topk(probabilities, observed_threatened, *, k=5) -> dict[str, Any]:
    """Fictional resident exposure only; deterministic ID tie breaks disclosed."""
    p, y = np.asarray(probabilities), np.asarray(observed_threatened, dtype=bool)
    if p.ndim != 1 or p.shape != y.shape or not np.isfinite(p).all() or not 1 <= k <= p.size:
        raise ValueError("known probability vector and matching resident labels required")
    order = np.argsort(-p, kind="stable")
    chosen = order[:k]
    hits = int(y[chosen].sum())
    return {
        "topk": k,
        "topk_precision": hits / k,
        "topk_recall": _ratio(hits, int(y.sum())),
        "missed_threatened": int(y.sum()) - hits,
        "cutoff_tie": bool(k < len(p) and p[order[k - 1]] == p[order[k]]),
        "order": order.tolist(),
    }


def interval_ranking_agreement(probability, intervals):
    """Compare only nonoverlapping observed intervals; no false total order."""
    correct = comparable = ties = 0
    for a in range(len(intervals)):
        for b in range(a + 1, len(intervals)):
            la, ua = intervals[a]
            lb, ub = intervals[b]
            if ua is not None and lb is not None and ua < lb:
                earlier, later = a, b
            elif ub is not None and la is not None and ub < la:
                earlier, later = b, a
            else:
                continue
            comparable += 1
            if probability[earlier] == probability[later]:
                ties += 1
            else:
                correct += probability[earlier] > probability[later]
    return {
        "comparable_pairs": comparable,
        "predicted_ties": ties,
        "agreement": correct / comparable if comparable else None,
    }
