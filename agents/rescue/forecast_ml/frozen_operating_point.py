"""Frozen operating-point diagnostics from saved probabilities only.

No model runtime, checkpoint, dataset loader, training or inference is imported.
The single issue-time 1km front is declared in protocol.json before any front
calculation. Original evaluation scores and all source bytes remain unchanged.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy.ndimage import distance_transform_edt
from sklearn.metrics import average_precision_score, roc_auc_score

from .provenance import atomic_json, sha256

MODELS = ("persistence", "existing_physical", "growth_extrapolation", "unet")
THRESHOLDS = (0.05, 0.5)
DOMAINS = ("growth", "front_1000m")
METRICS = (
    "precision",
    "recall",
    "f1",
    "roc_auc",
    "average_precision",
    "brier",
    "calibration_ece",
    "prevalence",
    "iou_all_defined",
    "iou_positive_target",
)
RESAMPLES = 2000
BOOTSTRAP_SEED = 20261024
FRONT_METERS = 1000.0
COUNT_KEYS = (
    "eligible_cells",
    "excluded_known_cells",
    "outside_region_cells",
    "observed_positive_cells",
    "predicted_positive_cells",
    "tp",
    "fp",
    "fn",
    "tn",
)


def front_mask(current, valid, cell_size_m):
    """Current ISSUE footprint anchor; center distance, no target argument.

    Empty known fire gives an empty front, rather than EDT's implicit outside
    image reference. A grid coarser than1km may have no susceptible front cells.
    """
    current, valid = np.asarray(current, bool), np.asarray(valid, bool)
    if current.ndim != 2 or current.shape != valid.shape or not np.isfinite(cell_size_m) or cell_size_m <= 0:
        raise ValueError("matching 2D masks and positive finite meters per pixel required")
    affected = current & valid
    if not affected.any():
        return np.zeros_like(valid)
    distance = distance_transform_edt(~affected, sampling=(cell_size_m, cell_size_m))
    return valid & ~current & (distance <= FRONT_METERS)


def _ratio(a, b):
    return float(a / b) if b else None


def _bins(y, probability):
    index = np.minimum((probability * 10).astype(int), 9)
    counts = np.bincount(index, minlength=10)
    positives = np.bincount(index, weights=y, minlength=10)
    sums = np.bincount(index, weights=probability, minlength=10)
    return [
        {
            "lower": i / 10,
            "upper": (i + 1) / 10,
            "count": int(counts[i]),
            "positive_count": int(positives[i]),
            "probability_sum": float(sums[i]),
            "mean_probability": _ratio(sums[i], counts[i]),
            "observed_fraction": _ratio(positives[i], counts[i]),
        }
        for i in range(10)
    ]


def _probability_metrics(y, probability):
    n = len(y)
    bins = _bins(y, probability)
    two_classes = n > 0 and bool(y.any()) and not bool(y.all())
    return {
        "roc_auc": float(roc_auc_score(y, probability)) if two_classes else None,
        "average_precision": float(average_precision_score(y, probability)) if two_classes else None,
        "brier": float(np.square(probability - y).mean()) if n else None,
        "calibration_ece": float(sum(abs(b["probability_sum"] - b["positive_count"]) for b in bins) / n)
        if n
        else None,
        "prevalence": float(y.mean()) if n else None,
        "calibration_bins": bins,
        "squared_error_sum": float(np.square(probability - y).sum()),
    }


def score_region(current, target, probability, valid, region, thresholds=THRESHOLDS):
    """Full raw new-growth labels in a target-independent spatial region."""
    current, target, valid, region = (np.asarray(x, bool) for x in (current, target, valid, region))
    probability = np.asarray(probability, float)
    if not (current.shape == target.shape == probability.shape == valid.shape == region.shape):
        raise ValueError("all saved geographic arrays must share shape")
    domain = valid & ~current & region
    p, y = probability[domain], target[domain]
    if not np.isfinite(p).all() or np.any((p < 0) | (p > 1)):
        raise ValueError("every admitted saved probability must be finite and in [0,1]")
    base = _probability_metrics(y, p)
    rows = []
    for threshold in thresholds:
        prediction = p >= threshold
        tp, fp = int((prediction & y).sum()), int((prediction & ~y).sum())
        fn, tn = int((~prediction & y).sum()), int((~prediction & ~y).sum())
        positive = int(y.sum())
        rows.append(
            {
                **base,
                "threshold": threshold,
                "precision": _ratio(tp, tp + fp),
                "recall": _ratio(tp, tp + fn),
                "f1": _ratio(2 * tp, 2 * tp + fp + fn),
                "iou_all_defined": _ratio(tp, tp + fp + fn),
                "iou_positive_target": _ratio(tp, tp + fp + fn) if positive else None,
                "counts": {
                    "eligible_cells": len(y),
                    "excluded_known_cells": int((valid & current).sum()),
                    "outside_region_cells": int((valid & ~current & ~region).sum()),
                    "observed_positive_cells": positive,
                    "predicted_positive_cells": int(prediction.sum()),
                    "tp": tp,
                    "fp": fp,
                    "fn": fn,
                    "tn": tn,
                },
                "empty_domain": len(y) == 0,
                "no_observed_growth": len(y) > 0 and positive == 0,
                "both_empty": len(y) > 0 and tp + fp + fn == 0,
                "one_observed_class": len(y) > 0 and not (y.any() and not y.all()),
            }
        )
    return rows, y, p


def _bootstrap(values, *, seed=BOOTSTRAP_SEED, resamples=RESAMPLES):
    values = np.asarray(values, float)
    if not len(values):
        return None
    rng = np.random.default_rng(seed)
    means = values[rng.integers(0, len(values), size=(resamples, len(values)))].mean(axis=1)
    return np.quantile(means, [0.025, 0.975]).tolist()


def summarize(rows, pooled_arrays, *, resamples=RESAMPLES, seed=BOOTSTRAP_SEED):
    """Pair means within groups, then macro; pooled cells are descriptive only."""
    by_group = defaultdict(list)
    for row in rows:
        by_group[(row["model"], row["group_id"])].append(row)
    incidents = []
    for (model, group), group_rows in sorted(by_group.items()):
        incident = {"model": model, "group_id": group, "pairs": len(group_rows)}
        for metric in METRICS:
            defined = [r[metric] for r in group_rows if r[metric] is not None]
            incident[metric] = float(np.mean(defined)) if defined else None
            incident[metric + "_defined_pairs"] = len(defined)
        incidents.append(incident)
    models = {}
    for model in MODELS:
        pair_rows = [r for r in rows if r["model"] == model]
        group_rows = [r for r in incidents if r["model"] == model]
        macro = {}
        for metric in METRICS:
            values = [r[metric] for r in group_rows if r[metric] is not None]
            defined_pairs = sum(r[metric] is not None for r in pair_rows)
            macro[metric] = {
                "estimate": float(np.mean(values)) if values else None,
                "ci95": _bootstrap(values, seed=seed, resamples=resamples),
                "defined_groups": len(values),
                "undefined_groups": len(group_rows) - len(values),
                "defined_pairs": defined_pairs,
                "undefined_pairs": len(pair_rows) - defined_pairs,
            }
        counts = {key: sum(r["counts"][key] for r in pair_rows) for key in COUNT_KEYS}
        for flag in ("empty_domain", "no_observed_growth", "both_empty", "one_observed_class"):
            counts[flag + "_pairs"] = sum(r[flag] for r in pair_rows)
        counts["pairs"] = len(pair_rows)
        counts["groups"] = len(group_rows)
        y, p = pooled_arrays[model]
        pooled_probability = _probability_metrics(y, p)
        tp, fp, fn = (counts[k] for k in ("tp", "fp", "fn"))
        conditional = [r for r in pair_rows if r["counts"]["observed_positive_cells"] > 0]
        ctp, cfp, cfn = (sum(r["counts"][k] for r in conditional) for k in ("tp", "fp", "fn"))
        pooled = {
            **{
                k: pooled_probability[k]
                for k in ("roc_auc", "average_precision", "brier", "calibration_ece", "prevalence")
            },
            "precision": _ratio(tp, tp + fp),
            "recall": _ratio(tp, tp + fn),
            "f1": _ratio(2 * tp, 2 * tp + fp + fn),
            "iou_all_defined": _ratio(tp, tp + fp + fn),
            "iou_positive_target": _ratio(ctp, ctp + cfp + cfn),
            "positive_target_pairs": len(conditional),
            "positive_target_groups": len({r["group_id"] for r in conditional}),
            "calibration_bins": pooled_probability["calibration_bins"],
            "cell_forecasts": len(y),
            "interpretation": "pooled repeated cell forecasts, unequal pixel areas; descriptive, not independent fires; CIs apply to incident macro estimates",
        }
        models[model] = {"macro": macro, "pooled": pooled, "raw_counts": counts}
    paired = []
    left = {(r["group_id"], r["pair_id"]): r for r in rows if r["model"] == "unet"}
    admitted_groups = len({group for group, _ in left})
    for baseline in MODELS[:-1]:
        right = {(r["group_id"], r["pair_id"]): r for r in rows if r["model"] == baseline}
        if set(left) != set(right):
            raise ValueError("paired diagnostics require identical model/case membership")
        for metric in METRICS:
            common = sorted(
                case for case in left if left[case][metric] is not None and right[case][metric] is not None
            )
            pair_differences = defaultdict(list)
            for case in common:
                pair_differences[case[0]].append(left[case][metric] - right[case][metric])
            differences = [float(np.mean(pair_differences[group])) for group in sorted(pair_differences)]
            paired.append(
                {
                    "model": "unet",
                    "baseline": baseline,
                    "metric": metric,
                    "difference": float(np.mean(differences)) if differences else None,
                    "ci95": _bootstrap(differences, seed=seed, resamples=resamples),
                    "paired_defined_groups": len(differences),
                    "paired_defined_pairs": len(common),
                    "excluded_metric_undefined_pairs": len(left) - len(common),
                    "undefined_or_unpaired_groups": admitted_groups - len(differences),
                    "admitted_groups": admitted_groups,
                    "population": "metric-specific common-defined PAIR intersection before group averaging; may differ from each model's all-defined macro population",
                    "direction": "lower is better"
                    if metric in ("brier", "calibration_ece")
                    else "descriptive, no superiority direction"
                    if metric == "prevalence"
                    else "higher is better",
                }
            )
    return {"models": models, "paired_differences": paired}, incidents


def _freeze_protocol(report_dir, output):
    paths = {
        "saved_predictions": report_dir / "forecast_predictions.parquet",
        "original_metrics": report_dir / "metrics.json",
        "original_protocol": report_dir / "protocol.json",
        "evaluation_pairs": report_dir / "evaluation_pairs.json",
        "training_receipt": report_dir / "training_runs.json",
        "freeze_receipt": output / "freeze_receipt.json",
    }
    hashes = {key: sha256(path) for key, path in paths.items()}
    freeze = json.loads(paths["freeze_receipt"].read_text())
    if (
        freeze.get("selected_threshold") != 0.05
        or freeze.get("diagnostic_threshold") != 0.5
        or freeze.get("selected_seed") != 202
        or freeze.get("selected_epoch") != 4
    ):
        raise ValueError("the frozen selected operating point has changed")
    if freeze["saved_prediction_sha256"] != hashes["saved_predictions"]:
        raise ValueError("saved predictions differ from frozen operating point")
    training = json.loads(paths["training_receipt"].read_text())
    if (
        training["checkpoint_sha256"] != freeze["selected_checkpoint_sha256"]
        or training["model_identity"] != str(training.get("selected_parameter_hash", ""))[:16]
    ):
        raise ValueError("frozen training/checkpoint provenance differs")
    if (training["selected_seed"], training["selected_epoch"], training["threshold"]) != (202, 4, 0.05):
        raise ValueError("saved predictions do not bind the frozen selected model")
    original = json.loads(paths["original_protocol"].read_text())
    pairs = json.loads(paths["evaluation_pairs"].read_text())
    protocol = {
        "schema_version": "frozen-growth-operating-point-protocol-v1",
        "models": list(MODELS),
        "operating_point": {
            "selected_seed": 202,
            "selected_epoch": 4,
            "selected_threshold": 0.05,
            "checkpoint_sha256": freeze["selected_checkpoint_sha256"],
        },
        "thresholds": {
            "0.05": "frozen validation-selected main operating point, applied to all methods",
            "0.5": "fixed diagnostic comparator, applied to all methods",
        },
        "no_threshold_search": True,
        "front": {
            "name": "front_1000m",
            "definition": "valid & ~current & center_distance_to_current_affected<=1000m",
            "anchor": "current footprint available at each forecast ISSUE; not sequence index0",
            "affected_anchor": "current & valid",
            "distance": "scipy EDT center-to-nearest-affected-cell-center in projected meters",
            "radius_m": FRONT_METERS,
            "inclusive_upper_bound": True,
            "no_affected_anchor": "empty front, distance unknown",
            "coarse_pixels": "no forced inclusion; front can be empty when neighboring center exceeds1000m",
            "future_targets_in_front_definition": False,
            "regions_searched": 1,
        },
        "growth_domain": "valid & ~current",
        "macro": "mean defined pair metrics within group, then mean defined group metrics; defined/undefined counts retained",
        "conditional_iou": "only pairs with positive observed growth in the declared domain",
        "all_defined_iou": "TP/(TP+FP+FN) on every pair with nonempty actual or predicted growth; false alarms on no-growth pairs count as0; both-empty undefined",
        "undefined": "zero denominator, empty domain, and single-observed-class ROC-AUC/AP remain null",
        "calibration": {
            "bins": 10,
            "edges": np.linspace(0, 1, 11).tolist(),
            "assignment": "left closed, right open except final bin includes1; fixed equal-width bins",
            "pooled_sufficient_statistics": ["count", "positive_count", "probability_sum"],
        },
        "bootstrap": {
            "unit": "whole incident group; all pair means move together",
            "resamples": RESAMPLES,
            "seed": BOOTSTRAP_SEED,
            "interval": "percentile2.5–97.5% for incident macro means and paired U-Net-minus-baseline group differences",
            "missing": "per-model defined groups; paired intervals first intersect metric-specific defined PAIRS, then average within groups; all admitted/excluded counts saved",
        },
        "pooled": "exact repeated-cell-forecast-weighted metrics; descriptive, separately named, not independent fires",
        "grid_shape": original["grid_shape"],
        "expected_pairs_per_model": len(pairs),
        "expected_groups_per_model": len({p["group_id"] for p in pairs}),
        "test_panel_status": "held out from fitting, previously inspected, reused diagnostic evidence",
        "source_hashes": hashes,
        "protocol_clarification": "Before any front calculation, INITIAL was clarified to current issue-time footprint. No sequence-first front metrics were computed.",
        "model_loading": False,
        "new_inference": False,
        "training": False,
    }
    path = output / "protocol.json"
    if path.exists():
        previous = json.loads(path.read_text())
        previous.pop("frozen_utc", None)
        if previous != protocol:
            raise ValueError("existing diagnostic protocol differs; no post-score change allowed")
    else:
        atomic_json(path, {**protocol, "frozen_utc": datetime.now(timezone.utc).isoformat()})
    return protocol, paths, pairs


def diagnose(report_dir):
    import pyarrow.parquet as pq

    report_dir = Path(report_dir).resolve()
    output = report_dir / "frozen_operating_point"
    output.mkdir(parents=True, exist_ok=True)
    protocol, sources, expected_pairs = _freeze_protocol(report_dir, output)
    # Protocol is now durably saved. Only now may a front or metric be computed.
    shape = tuple(protocol["grid_shape"])
    expected = {(p["group_id"], p["pair_id"]) for p in expected_pairs}
    expected_records = {(p["group_id"], p["pair_id"]): p for p in expected_pairs}
    if len(expected) != len(expected_pairs):
        raise ValueError("duplicate frozen evaluation case")
    rows_by_region = {domain: {threshold: [] for threshold in THRESHOLDS} for domain in DOMAINS}
    pooled_parts = {domain: {model: {"y": [], "p": []} for model in MODELS} for domain in DOMAINS}
    seen, label_hashes = set(), {}
    parquet = pq.ParquetFile(sources["saved_predictions"])
    columns = [
        "model",
        "group_id",
        "pair_id",
        "sequence_id",
        "cell_id",
        "current",
        "target",
        "valid",
        "probability",
        "issue_s",
        "horizon_s",
        "cell_size_m",
    ]
    for number in range(parquet.num_row_groups):
        table = parquet.read_row_group(number, columns=columns)
        values = {name: table[name].to_numpy(zero_copy_only=False) for name in columns}
        size = int(np.prod(shape))
        order = np.argsort(values["cell_id"], kind="stable")
        values = {name: array[order] for name, array in values.items()}
        if len(table) != size or not np.array_equal(values["cell_id"], np.arange(size)):
            raise ValueError("saved model/pair row group must contain one ordered complete grid")
        for name in ("model", "group_id", "pair_id", "sequence_id", "issue_s", "horizon_s", "cell_size_m"):
            if not np.all(values[name] == values[name][0]):
                raise ValueError("row group mixes saved case metadata")
        model, pair, group, sequence = (
            str(values[name][0]) for name in ("model", "pair_id", "group_id", "sequence_id")
        )
        if model not in MODELS or (group, pair) not in expected or (model, pair) in seen:
            raise ValueError("saved predictions differ from frozen model/case membership")
        seen.add((model, pair))
        declared_pair = expected_records[(group, pair)]
        if sequence != declared_pair["sequence_id"] or any(
            abs(float(values[key][0]) - float(declared_pair[key])) > 1e-6 for key in ("issue_s", "horizon_s")
        ):
            raise ValueError("saved sequence/issue/horizon differs from frozen pair manifest")
        current, target, valid = (
            values[name].reshape(shape).astype(bool) for name in ("current", "target", "valid")
        )
        probability = values["probability"].reshape(shape).astype(float)
        mpp = float(values["cell_size_m"][0])
        digest = hashlib.sha256(
            current.tobytes()
            + target.tobytes()
            + valid.tobytes()
            + json.dumps(
                [group, sequence, float(values["issue_s"][0]), float(values["horizon_s"][0]), mpp]
            ).encode()
        ).hexdigest()
        if pair in label_hashes and digest != label_hashes[pair]:
            raise ValueError("methods have different actual labels, known footprints or case grids")
        label_hashes[pair] = digest
        regions = {"growth": valid & ~current, "front_1000m": front_mask(current, valid, mpp)}
        for domain, region in regions.items():
            scores, y, p = score_region(current, target, probability, valid, region)
            pooled_parts[domain][model]["y"].append(y)
            pooled_parts[domain][model]["p"].append(p)
            for threshold, score in zip(THRESHOLDS, scores):
                rows_by_region[domain][threshold].append(
                    {
                        "model": model,
                        "pair_id": pair,
                        "group_id": group,
                        "sequence_id": sequence,
                        "domain": domain,
                        "cell_size_m": mpp,
                        **score,
                    }
                )
    expected_membership = {(model, pair) for model in MODELS for _, pair in expected}
    if seen != expected_membership:
        raise ValueError("a method or frozen forecast case is missing")
    pooled = {
        domain: {
            model: (np.concatenate(parts["y"]), np.concatenate(parts["p"])) for model, parts in models.items()
        }
        for domain, models in pooled_parts.items()
    }
    thresholds, all_rows, all_incidents = {}, [], []
    for threshold in THRESHOLDS:
        regions = {}
        for domain in DOMAINS:
            rows = rows_by_region[domain][threshold]
            regions[domain], incidents = summarize(rows, pooled[domain])
            all_rows.extend({k: v for k, v in r.items() if k != "calibration_bins"} for r in rows)
            all_incidents.extend({"threshold": threshold, "domain": domain, **r} for r in incidents)
        thresholds[format(threshold, ".12g")] = {
            "role": protocol["thresholds"][format(threshold, ".12g")],
            "domains": regions,
        }
    for name, path in sources.items():
        if sha256(path) != protocol["source_hashes"][name]:
            raise ValueError(f"immutable diagnostic source changed: {name}")
    atomic_json(output / "pair_metrics.json", all_rows)
    atomic_json(output / "per_incident_metrics.json", all_incidents)
    result = {
        "schema_version": "frozen-growth-operating-point-results-v1",
        "protocol_sha256": sha256(output / "protocol.json"),
        "source_hashes": protocol["source_hashes"],
        "operating_point": protocol["operating_point"],
        "thresholds": thresholds,
        "pairs_per_model": len(expected),
        "groups_per_model": len({g for g, _ in expected}),
        "membership_verified": True,
        "label_and_grid_equality_verified": True,
        "original_metrics_unchanged": True,
        "new_training": False,
        "new_inference": False,
        "source_model_loaded": False,
        "raw_pair_metrics_sha256": sha256(output / "pair_metrics.json"),
        "per_incident_metrics_sha256": sha256(output / "per_incident_metrics.json"),
        "limitations": [
            "The existing held-out panel was already inspected; these are frozen diagnostic results, not a pristine confirmation experiment.",
            "Issue-time current footprint defines the single front before viewing target growth; EDT uses raster centers, not exact polygon boundary distance.",
            "Fixed initial model grids can clip later growth; valid exterior negatives mean component-footprint membership, not surveyed fire absence.",
            "Metric-specific undefined pair/group counts differ, especially persistence precision and one-class ROC-AUC/AP. No undefined score is replaced by1 or0.",
            "Macro bootstrap resamples entire incident groups; pooled metrics describe repeated cell forecasts and do not treat them as independent fires.",
            "No threshold or region search, model loading, inference, calibration fitting, training or split modification occurred.",
        ],
    }
    atomic_json(output / "metrics.json", result)
    _write_markdown(output, result)
    return result


def _write_markdown(output, result):
    def number(value):
        return "undefined" if value is None else f"{value:.4f}"

    def interval(record):
        ci = record["ci95"]
        return number(record["estimate"]) + (f" [{ci[0]:.4f}, {ci[1]:.4f}]" if ci else "")

    lines = [
        "# Frozen supervised operating-point diagnostics",
        "",
        f"Seed 202 / epoch 4 / threshold 0.05 is frozen from validation. Threshold 0.50 is a fixed diagnostic only. Both thresholds apply to every method. The same {result['pairs_per_model']} pairs / {result['groups_per_model']} incident groups and saved probability maps are reused; no model was loaded or rerun. This panel was previously inspected and is diagnostic evidence.",
        "",
        "Growth means valid cells outside the CURRENT issue-time affected footprint. The single predefined front additionally requires center-to-current-affected-center EDT distance≤1000m. Empty fronts remain empty; large cells are never forced into the band. No target selects the region.",
        "",
        "Values below are incident macros with 95% percentile CIs from 2,000 whole-group bootstrap draws. Pair means precede group means. Undefined metrics stay null and have explicit counts in JSON. Pooled metrics/calibration bins and raw pair/group sufficient statistics are saved separately in this folder.",
        "",
        "Paired differences first intersect metric-specific common-defined PAIRS, then average within incidents. They need not equal subtraction of the displayed per-model all-defined macros. For example, persistence's both-empty no-growth pairs have undefined IoU/F1, so their exclusion narrows the paired population while each model's own all-defined macro still counts its no-growth false alarms. Defined pair and group counts accompany every comparison.",
    ]
    for key, threshold in result["thresholds"].items():
        for domain, region in threshold["domains"].items():
            lines.extend(
                [
                    "",
                    f"## Threshold {float(key):.2f}: {domain}",
                    "",
                    "| Method | Precision | Recall | F1 | ROC-AUC | AP | Brier | ECE | Growth prevalence | IoU all defined | IoU positive-target |",
                    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
                ]
            )
            for model in MODELS:
                macro = region["models"][model]["macro"]
                lines.append("| " + model + " | " + " | ".join(interval(macro[k]) for k in METRICS) + " |")
            lines.extend(
                [
                    "",
                    "| Method | Pooled prevalence | Pooled Brier | Pooled ECE | Cells | Positive cells | TP / FP / FN / TN | Empty / no-growth / both-empty pairs |",
                    "|---|---:|---:|---:|---:|---:|---|---|",
                ]
            )
            for model in MODELS:
                entry = region["models"][model]
                pooled, counts = entry["pooled"], entry["raw_counts"]
                lines.append(
                    f"| {model} | {number(pooled['prevalence'])} | {number(pooled['brier'])} | {number(pooled['calibration_ece'])} | {counts['eligible_cells']} | {counts['observed_positive_cells']} | {counts['tp']} / {counts['fp']} / {counts['fn']} / {counts['tn']} | {counts['empty_domain_pairs']} / {counts['no_observed_growth_pairs']} / {counts['both_empty_pairs']} |"
                )
            lines.extend(
                [
                    "",
                    "| U-Net minus baseline | Metric | Paired macro difference [95% CI] | Defined groups / pairs |",
                    "|---|---|---:|---:|",
                ]
            )
            for difference in region["paired_differences"]:
                ci = difference["ci95"]
                shown = number(difference["difference"]) + (f" [{ci[0]:.4f}, {ci[1]:.4f}]" if ci else "")
                lines.append(
                    f"| {difference['baseline']} | {difference['metric']} | {shown} | {difference['paired_defined_groups']} of {difference['admitted_groups']} groups; {difference['paired_defined_pairs']} of {result['pairs_per_model']} pairs |"
                )
    lines.extend(
        [
            "",
            "All-defined IoU/F1 include no-observed-growth false positives as 0. Both-empty pairs are undefined. Positive-target IoU uses only pairs with actual growth in that declared domain, preserving traceability to the original conditional metric. A positive difference favors U-Net for overlap/discrimination metrics; negative favors it for Brier/ECE. Prevalence is descriptive and should match methods.",
            "",
            "The neural head retains current cells, so full-footprint classification is deliberately absent here. No baseline or neural output was retrained, recalibrated or selected using these results. These diagnostics do not establish rescue outcomes or precise arrival times.",
            "",
            "Inspect `protocol.json`, `metrics.json`, `pair_metrics.json`, and `per_incident_metrics.json` for hashes, populations, undefined counts, pooled calibration statistics and all paired intervals.",
            "",
        ]
    )
    (output / "metrics.md").write_text("\n".join(lines))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-dir", required=True)
    args = parser.parse_args()
    result = diagnose(args.report_dir)
    print(
        json.dumps(
            {
                "pairs_per_model": result["pairs_per_model"],
                "groups_per_model": result["groups_per_model"],
                "operating_point": result["operating_point"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
