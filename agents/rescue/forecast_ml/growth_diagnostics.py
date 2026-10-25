"""Secondary growth-only classification from saved forecasts, without inference.

The population is valid cells outside the observed starting footprint. This
prevents known-footprint retention from dominating probability metrics. It is
separate from the frozen primary growth-IoU contract and never modifies it.
Actual later masks and probability scores are read solely from saved parquet.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path

import numpy as np

from .metrics import BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, THRESHOLD, forecast_metrics
from .provenance import atomic_json

CLASSIFICATION_METRICS = (
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
    "prevalence",
)


def growth_classification(current, target, probability, valid, *, cell_size_m=1.0):
    """Use frozen classification formulas on valid & ~current, not known cells.

    All eligible pairs remain in this secondary analysis, including those with
    no observed growth. One-class AUC/AP and zero-denominator rates are null.
    Unlike the primary growth-IoU population, this is not restricted to pairs
    with positive observed growth. Missing predictions are counted explicitly.
    """
    current = np.asarray(current, bool)
    eligible = np.asarray(valid, bool) & ~current
    scored = forecast_metrics(
        np.zeros_like(current), target, probability, eligible, cell_size_m=cell_size_m, threshold=THRESHOLD
    )
    return {
        **{key: scored[key] for key in CLASSIFICATION_METRICS},
        "n": scored["n"],
        "eligible_growth_domain_cells": int(eligible.sum()),
        "excluded_known_footprint_cells": int((np.asarray(valid, bool) & current).sum()),
        "unknown_cells": scored["unknown_cells"],
        "confusion": scored["confusion"],
        "calibration": scored["calibration"],
        "single_class": scored.get("single_class"),
        "undefined_reason": scored.get("undefined_reason"),
    }


def aggregate_growth_classification(rows, *, resamples=BOOTSTRAP_RESAMPLES, seed=BOOTSTRAP_SEED):
    """Mean pairs within each incident, then macro/whole-incident bootstrap."""
    groups = defaultdict(list)
    for row in rows:
        groups[(row["model"], row["group_id"])].append(row)
    incidents = []
    for (model, group), values in sorted(groups.items()):
        record = {"model": model, "group_id": group, "forecast_pairs": len(values)}
        for key in CLASSIFICATION_METRICS:
            numbers = [float(r[key]) for r in values if r.get(key) is not None and np.isfinite(r[key])]
            record[key] = float(np.mean(numbers)) if numbers else None
            record[key + "_defined_pairs"] = len(numbers)
        incidents.append(record)
    summary = {}
    pooled = {}
    for model in sorted({r["model"] for r in rows}):
        members = [r for r in incidents if r["model"] == model]
        record = {"incident_groups": len(members), "forecast_pairs": sum(r["model"] == model for r in rows)}
        for key in CLASSIFICATION_METRICS:
            values = np.asarray([r[key] for r in members if r[key] is not None])
            record[key + "_macro"] = float(values.mean()) if len(values) else None
            record[key + "_median"] = float(np.median(values)) if len(values) else None
            record[key + "_defined_groups"] = len(values)
            record[key + "_ci95"] = None
            if len(values):
                rng = np.random.default_rng(seed)
                means = values[rng.integers(0, len(values), size=(resamples, len(values)))].mean(axis=1)
                record[key + "_ci95"] = np.quantile(means, [0.025, 0.975]).tolist()
        summary[model] = record
        model_rows = [r for r in rows if r["model"] == model]
        count = sum(r["n"] for r in model_rows)
        bins = [{"count": 0, "probability_sum": 0.0, "positive_count": 0} for _ in range(10)]
        for row in model_rows:
            for bucket, observed in zip(bins, row["calibration"]):
                for key in bucket:
                    bucket[key] += observed[key]
        pooled[model] = {
            "confusion": {
                key: sum(r["confusion"][key] for r in model_rows) for key in ("tn", "fp", "fn", "tp")
            },
            "cell_forecasts": count,
            "unknown_cells": sum(r["unknown_cells"] for r in model_rows),
            "excluded_known_footprint_cell_forecasts": sum(
                r["excluded_known_footprint_cells"] for r in model_rows
            ),
            "brier": sum(r["brier"] * r["n"] for r in model_rows if r["brier"] is not None) / count
            if count
            else None,
            "calibration": bins,
            "interpretation": "repeated susceptible-cell forecasts, not independent fires",
        }
    differences = []
    left = {r["group_id"]: r for r in incidents if r["model"] == "unet"}
    for baseline in ("persistence", "existing_physical", "growth_extrapolation"):
        right = {r["group_id"]: r for r in incidents if r["model"] == baseline}
        if not left or not right:
            continue
        lcases = {(r["group_id"], r["pair_id"]) for r in rows if r["model"] == "unet"}
        rcases = {(r["group_id"], r["pair_id"]) for r in rows if r["model"] == baseline}
        if lcases != rcases:
            raise ValueError("paired growth classification requires identical forecast pairs")
        for key in CLASSIFICATION_METRICS:
            valid_groups = sorted(g for g in left if left[g][key] is not None and right[g][key] is not None)
            values = np.asarray([left[g][key] - right[g][key] for g in valid_groups])
            row = {
                "model": "unet",
                "baseline": baseline,
                "metric": key,
                "paired_defined_groups": len(values),
                "admitted_groups": len(left),
                "difference": float(values.mean()) if len(values) else None,
                "ci95": None,
            }
            if len(values):
                rng = np.random.default_rng(seed)
                means = values[rng.integers(0, len(values), size=(resamples, len(values)))].mean(axis=1)
                row["ci95"] = np.quantile(means, [0.025, 0.975]).tolist()
            differences.append(row)
    return {
        "summary": summary,
        "per_incident": incidents,
        "pooled": pooled,
        "paired_confidence_intervals": differences,
    }


def diagnose_growth(report_dir):
    """Read completed saved parquet; write a distinct secondary diagnostic JSON."""
    import pyarrow.parquet as pq

    report_dir = Path(report_dir)
    path = report_dir / "forecast_predictions.parquet"
    source_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    protocol = json.loads((report_dir / "protocol.json").read_text())
    shape = tuple(protocol["grid_shape"])
    parquet = pq.ParquetFile(path)
    rows = []
    seen = set()
    for number in range(parquet.num_row_groups):
        frame = parquet.read_row_group(number).to_pandas().sort_values("cell_id")
        if (
            len(frame) != int(np.prod(shape))
            or frame.model.nunique() != 1
            or frame.pair_id.nunique() != 1
            or frame.group_id.nunique() != 1
            or not np.array_equal(frame.cell_id, np.arange(len(frame)))
        ):
            raise ValueError("growth diagnostic expects complete unique model/pair grid row groups")
        model, pair, group = map(str, (frame.model.iloc[0], frame.pair_id.iloc[0], frame.group_id.iloc[0]))
        if (model, pair) in seen:
            raise ValueError("duplicate model/pair growth diagnostic")
        seen.add((model, pair))
        record = growth_classification(
            frame.current.to_numpy().reshape(shape),
            frame.target.to_numpy().reshape(shape),
            frame.probability.to_numpy().reshape(shape),
            frame.valid.to_numpy().reshape(shape),
            cell_size_m=float(frame.cell_size_m.iloc[0]),
        )
        rows.append({"model": model, "pair_id": pair, "group_id": group, **record})
    result = {
        "schema_version": "growth-only-classification-v1",
        "definition": "valid AND NOT known starting footprint",
        "primary_contract_unchanged": True,
        "threshold": THRESHOLD,
        "bootstrap_resamples": BOOTSTRAP_RESAMPLES,
        "bootstrap_seed": BOOTSTRAP_SEED,
        "bootstrap_unit": "whole incident group",
        "source_forecast_predictions_sha256": source_hash,
        "rows": rows,
        **aggregate_growth_classification(rows),
        "limitations": [
            "secondary diagnostic, not the frozen primary score or a new model-selection rule",
            "all pairs included; one-class AUC/AP and zero-denominator rates remain undefined",
            "full-footprint AP includes already known affected cells and does not alone establish growth skill",
            "fixed-domain clipping and footprint-negative assumptions still apply",
        ],
    }
    if hashlib.sha256(path.read_bytes()).hexdigest() != source_hash:
        raise ValueError("saved forecast source changed during diagnostic computation")
    atomic_json(report_dir / "growth_classification_metrics.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-dir", required=True)
    args = parser.parse_args()
    result = diagnose_growth(args.report_dir)
    print(json.dumps(result["summary"], indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
