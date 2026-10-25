"""Fictional resident impact from saved frozen probabilities, never new fitting.

Uniform residents depend on issue-time geometry only. Future observations are
used solely as interval-censored evaluation labels. All files remain synthetic;
no historical fire observations contain rescue or mortality ground truth.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path

import numpy as np

from .data import grid_from_record, load_dataset, load_sequence
from .metrics import BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, calibration_bins, interval_ranking_agreement
from .provenance import atomic_json
from .risk import ForecastProduct, assess_residents, resident_ranking_metrics, synthetic_residents

RESIDENT_METRICS = (
    "topk_recall",
    "topk_precision",
    "missed_threatened",
    "known_order_agreement",
    "ensemble_topk_jaccard",
    "resident_brier",
    "resident_calibration_ece",
    "resident_prevalence",
)


def resident_probability_metrics(probabilities, observed):
    """Score saved probabilities at identical fictional placements, without fitting.

    ECE uses ten uniform probability bins on the natural uniform-noncurrent
    resident sample. Brier/ECE remain defined for single-class target samples;
    no admitted residents yields null scores rather than zero error.
    """
    p, y = np.asarray(probabilities, float), np.asarray(observed)
    if (
        p.ndim != 1
        or y.shape != p.shape
        or not np.isfinite(p).all()
        or not np.isfinite(y).all()
        or not np.isin(y, [0, 1]).all()
        or np.any((p < 0) | (p > 1))
    ):
        raise ValueError("resident scores require matching known probability/binary-label vectors")
    if not len(p):
        return {
            "resident_count": 0,
            "resident_brier": None,
            "resident_calibration_ece": None,
            "resident_prevalence": None,
            "resident_calibration": [],
            "resident_probability_reason": "no admitted fictional residents",
        }
    bins = calibration_bins(y, p)
    return {
        "resident_count": len(p),
        "resident_brier": float(np.mean((p - y) ** 2)),
        "resident_calibration_ece": float(
            sum(b["count"] * abs(b["mean_probability"] - b["observed_fraction"]) for b in bins if b["count"])
            / len(p)
        ),
        "resident_prevalence": float(y.mean()),
        "resident_calibration": bins,
    }


def summarize_residents(rows, *, resamples=BOOTSTRAP_RESAMPLES, seed=BOOTSTRAP_SEED):
    """Incident means then macro means and whole-incident bootstrap intervals.

    Undefined pairs are omitted within an incident and undefined incidents are
    counted explicitly. A group is the sampling unit: its complete set of pairs
    is represented by its mean, never by independent pixels/residents. Paired
    differences additionally require identical model/baseline case membership.
    These intervals concern this fictional sampling/evaluation protocol, not
    real rescue efficacy or population-level individual risk.
    """
    if resamples <= 0:
        raise ValueError("positive incident bootstrap resample count required")
    grouped = defaultdict(list)
    for row in rows:
        grouped[(row["model"], row["group_id"])].append(row["metrics"])
    per_incident = []
    for (model, group), values in sorted(grouped.items()):
        record = {"model": model, "group_id": group, "pairs": len(values)}
        for key in RESIDENT_METRICS:
            numbers = [float(v[key]) for v in values if v.get(key) is not None and np.isfinite(v[key])]
            record[key] = float(np.mean(numbers)) if numbers else None
            record[key + "_defined_pairs"] = len(numbers)
        per_incident.append(record)
    summary = {}
    for model in sorted({row["model"] for row in rows}):
        incidents = [row for row in per_incident if row["model"] == model]
        record = {"admitted_incident_groups": len(incidents)}
        for key in RESIDENT_METRICS:
            values = np.asarray([row[key] for row in incidents if row[key] is not None])
            record[key + "_macro"] = float(values.mean()) if len(values) else None
            record[key + "_defined_groups"] = len(values)
            if len(values):
                rng = np.random.default_rng(seed)
                means = values[rng.integers(0, len(values), size=(resamples, len(values)))].mean(axis=1)
                record[key + "_ci95"] = np.quantile(means, [0.025, 0.975]).tolist()
            else:
                record[key + "_ci95"] = None
        record["pairs_without_threatened_residents"] = sum(
            r["metrics"].get("threatened") == 0 for r in rows if r["model"] == model
        )
        summary[model] = record
    differences = []
    left = {r["group_id"]: r for r in per_incident if r["model"] == "unet"}
    for baseline in ("persistence", "existing_physical", "growth_extrapolation", "unet"):
        right = {r["group_id"]: r for r in per_incident if r["model"] == baseline}
        if not left or not right:
            continue
        left_cases = {(r["group_id"], r["pair_id"]) for r in rows if r["model"] == "unet"}
        right_cases = {(r["group_id"], r["pair_id"]) for r in rows if r["model"] == baseline}
        if left_cases != right_cases:
            raise ValueError("paired resident uncertainty requires identical forecast-pair membership")
        for key in RESIDENT_METRICS:
            groups = sorted(g for g in left if left[g][key] is not None and right[g][key] is not None)
            values = np.asarray([left[g][key] - right[g][key] for g in groups])
            row = {
                "model": "unet",
                "baseline": baseline,
                "metric": key,
                "difference": float(values.mean()) if len(values) else None,
                "paired_defined_groups": len(groups),
                "admitted_groups": len(left),
                "ci95": None,
            }
            if len(values):
                rng = np.random.default_rng(seed)
                means = values[rng.integers(0, len(values), size=(resamples, len(values)))].mean(axis=1)
                row["ci95"] = np.quantile(means, [0.025, 0.975]).tolist()
            differences.append(row)
    return {
        "summary": summary,
        "per_incident": per_incident,
        "paired_confidence_intervals": differences,
        "bootstrap": {
            "resamples": resamples,
            "seed": seed,
            "confidence_level": 0.95,
            "unit": "whole incident group",
            "undefined": "undefined pairs excluded within group; undefined groups excluded and counted",
            "limitation": "single-group intervals are engineering diagnostics; synthetic placements do not validate real emergency outcomes",
        },
    }


def observed_intervals(sequence, index, residents):
    """First subsequently observed footprint membership, no arbitrary midpoint.

    A polygon's exterior only supplies the benchmark's footprint-negative
    assumption. Raw revision/shrinkage remains documented, not reconciled into
    precise physical front passage. Never-positive residents are right-censored.
    """
    times = sequence["times_s"]
    issue = times[index]
    result = []
    for resident in residents:
        cell = resident["cell_id"]
        if sequence["masks"][: index + 1, ...].reshape(index + 1, -1)[:, cell].any():
            result.append((None, None))  # prior affected/revised footprint: first arrival is unknown
            continue
        first = next((j for j in range(index + 1, len(times)) if sequence["masks"][j].flat[cell]), None)
        result.append(
            (float(times[first - 1] - issue), float(times[first] - issue))
            if first is not None
            else (float(times[-1] - issue), None)
        )
    return result


def ranking_stability(bits, probabilities, *, seed, k=5):
    """Bootstrap fixed simulator members, not independent historical fires.

    Tied top-k rankings use deterministic request IDs, so high stability among
    ties is not evidence of accurate ranking. This is model-ensemble sensitivity,
    not a calibrated confidence interval on rescue outcomes.
    """
    member_labels = ((np.asarray(bits, np.uint16)[:, None] >> np.arange(16)) & 1).astype(float)
    n = len(probabilities)
    if k <= 0:
        raise ValueError("top-k must be positive")
    if not n:
        return {"mean_topk_jaccard": None, "selection_frequency": []}
    k = min(k, n)
    base = set(np.argsort(-np.asarray(probabilities), kind="stable")[:k])
    rng = np.random.default_rng(seed)
    selected = np.zeros(n)
    overlap = []
    for _ in range(100):
        p = member_labels[:, rng.integers(0, 16, 16)].mean(axis=1)
        order = set(np.argsort(-p, kind="stable")[:k])
        for i in order:
            selected[i] += 1
        overlap.append(len(base & order) / len(base | order))
    sorted_p = sorted(probabilities, reverse=True)
    return {
        "mean_topk_jaccard": float(np.mean(overlap)),
        "selection_frequency": (selected / 100).tolist(),
        "cutoff_tie": bool(k < n and sorted_p[k - 1] == sorted_p[k]),
        "definition": "100 fixed-member bootstrap top-k Jaccards; tie IDs deterministic; not historical confidence",
    }


def evaluate_residents(dataset_path, report_dir, *, count=24, k=5):
    """Read each persisted model/pair row group; never invoke a model or optimizer."""
    import pyarrow.parquet as pq

    report_dir = Path(report_dir)
    dataset = load_dataset(dataset_path)
    pairs = {p["pair_id"]: p for p in json.loads((report_dir / "evaluation_pairs.json").read_text())}
    records = {r["sequence_id"]: r for r in dataset["sequences"]}
    parquet = pq.ParquetFile(report_dir / "forecast_predictions.parquet")
    results = []
    cache = {}
    examples = set(sorted(pairs)[:3])
    for rg in range(parquet.num_row_groups):
        frame = parquet.read_row_group(rg).to_pandas().sort_values("cell_id")
        pair_id, model = str(frame.pair_id.iloc[0]), str(frame.model.iloc[0])
        pair = pairs[pair_id]
        seq_id = pair["sequence_id"]
        if seq_id not in cache:
            cache[seq_id] = load_sequence(records[seq_id])
        seq = cache[seq_id]
        grid = grid_from_record(seq["grid"])
        if len(frame) != grid.size or frame.pair_id.nunique() != 1 or frame.model.nunique() != 1:
            raise ValueError("resident evaluator expects one complete model/pair grid per Parquet row group")
        if not np.array_equal(frame.cell_id.to_numpy(), np.arange(grid.size)):
            raise ValueError("saved resident grid contains duplicate or missing cell IDs")
        current = frame.current.to_numpy().reshape(grid.rows, grid.cols)
        target = frame.target.to_numpy().reshape(grid.rows, grid.cols)
        valid = frame.valid.to_numpy().reshape(grid.rows, grid.cols)
        probability = frame.probability.to_numpy().reshape(grid.rows, grid.cols)
        if not np.array_equal(current, seq["masks"][pair["from_index"]]) or not np.array_equal(
            target, seq["masks"][pair["to_index"]]
        ):
            raise ValueError("saved resident labels differ from frozen observation pair")
        for name in ("issue_s", "target_s", "horizon_s"):
            if name in frame and not np.allclose(frame[name], pair[name], atol=1e-6, rtol=0):
                raise ValueError("saved resident clock differs from frozen pair")
        residents = synthetic_residents(grid, valid, pair_id=pair_id, count=count, observed=current)
        product = ForecastProduct(
            grid,
            pair["issue_s"],
            [pair["horizon_s"]],
            probability[None],
            valid,
            current,
            model,
            model,
            quality_flags=["synthetic residents", "raw footprint labels", "unknown information release"],
        )
        assessed = assess_residents(product, residents)
        metrics = resident_ranking_metrics(assessed, target, k=k)
        scores = [float(probability.flat[r["cell_id"]]) for r in residents]
        labels = [bool(target.flat[r["cell_id"]]) for r in residents]
        metrics.update(resident_probability_metrics(scores, labels))
        intervals = observed_intervals(seq, pair["from_index"], residents)
        revision_ids = {
            r["request_id"] for r, interval in zip(residents, intervals) if interval == (None, None)
        }
        for row in assessed:
            if row["request_id"] in revision_ids:
                row["arrival_window"] = {
                    "status": "historical_revision_unknown",
                    "lower_s": None,
                    "upper_s": None,
                }
                row["slack_lower_s"] = row["slack_upper_s"] = None
                row["uncertainty_status"] = "commander_review"
                row["quality_flags"] = [
                    *row["quality_flags"],
                    "previously affected in known history; raw perimeter revision",
                ]
                row["reason"] += " Prior observed footprint means first arrival is unknown."
        order = interval_ranking_agreement(scores, intervals)
        metrics["known_order_agreement"] = order["agreement"]
        metrics["comparable_interval_pairs"] = order["comparable_pairs"]
        metrics["predicted_order_ties"] = order["predicted_ties"]
        metrics["order_reason"] = (
            "only nonoverlapping first-observed-membership brackets; no exact front times"
        )
        stability = {"mean_topk_jaccard": None, "reason": "member realizations not saved"}
        if "member_affect_bits" in frame and frame.member_affect_bits.notna().all():
            bits = frame.member_affect_bits.to_numpy()[[r["cell_id"] for r in residents]]
            seed = int.from_bytes(hashlib.sha256(pair_id.encode()).digest()[:4], "big") + 27001
            stability = ranking_stability(bits, scores, seed=seed, k=k)
        metrics["ensemble_topk_jaccard"] = stability["mean_topk_jaccard"]
        results.append(
            {
                "pair_id": pair_id,
                "group_id": pair["group_id"],
                "model": model,
                "metrics": metrics,
                "stability": stability,
                "residents": assessed if pair_id in examples else [],
                "synthetic": True,
            }
        )
    aggregation = summarize_residents(results)
    artifact = {
        "schema_version": "supervised-resident-impact-v1",
        "rows": results,
        **aggregation,
        "population": f"up to{count} uniform valid noncurrent cells per pair, seed independent of targets",
        "topk": k,
        "completed_handoffs": None,
        "handoff_reason": "main station agents do not execute missions/handoffs; coarse historical horizons do not supply minute truth",
        "limitations": [
            "historical exterior is footprint-negative assumption",
            "no real rescue validation",
            "ranking ties can dominate persistence/stability",
            "coarse risk does not replace physical dispatch timing",
            "resident calibration is evaluated on uniform valid noncurrent fictional placements, not actual population exposure",
        ],
    }
    atomic_json(report_dir / "resident_outputs.json", artifact)
    return artifact


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--report-dir", required=True)
    args = parser.parse_args()
    out = evaluate_residents(args.dataset, args.report_dir)
    print(json.dumps(out["summary"], indent=2))


if __name__ == "__main__":
    main()
