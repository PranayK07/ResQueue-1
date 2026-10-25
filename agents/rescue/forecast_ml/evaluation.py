"""Frozen supervised wildfire evaluation; saved outputs never trigger training.

Inputs are versioned observation pairs and a validation-selected native U-Net
checkpoint. Targets remain raw perimeters. The previously inspected test panel
is explicitly reused diagnostic evidence, never advertised as pristine unseen.
"""

from __future__ import annotations
import argparse
import csv
import hashlib
import json
from pathlib import Path
import resource
import sys
import time
import numpy as np
from .baselines import forecast_baselines
from .metrics import aggregate, forecast_metrics, paired_bootstrap, per_incident
from .provenance import atomic_json, assert_inputs_unchanged, freeze_inputs, sha256

SCHEMA = "supervised-wildfire-benchmark-v1"
BASELINES = ("persistence", "existing_physical", "growth_extrapolation")


def canonical_hash(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def primary_pairs(dataset: dict, split: str) -> list[dict]:
    """Use the frozen primary test panel; deterministic same rule for validation."""
    if split == "test":
        return list(dataset["test_pairs"])
    candidates = dataset.get(f"{split}_pairs")
    if candidates is not None:
        return list(candidates)
    by_group = {}
    for record in dataset["sequences"]:
        if record["split"] != split:
            continue
        times = record.get("times_s", record.get("acquisition_s"))
        for index in record.get("eligible_transition_indices", range(len(times) - 1)):
            target = index + 1
            horizon = float(times[target] - times[index])
            if not 6 * 3600 <= horizon <= 72 * 3600:
                continue
            payload = {
                "sequence_id": record["sequence_id"],
                "group_id": record["group_id"],
                "component_id": record["component_id"],
                "from_index": index,
                "to_index": target,
                "source_row_ids": [record["source_row_ids"][index], record["source_row_ids"][target]],
                "issue_s": float(times[index]),
                "target_s": float(times[target]),
                "horizon_s": horizon,
                "year": record.get("year", "unknown"),
                "region": record.get("region", "unknown"),
            }
            payload["pair_id"] = canonical_hash(payload)
            by_group.setdefault(record["group_id"], []).append(payload)
    pairs = []
    for group, candidates in sorted(by_group.items()):
        ordered = sorted(candidates, key=lambda p: (p["issue_s"], p["component_id"], p["from_index"]))
        for index in sorted({0, len(ordered) // 2, len(ordered) - 1}):
            pairs.append(ordered[index])
    return pairs


def _receipt(training_metadata, checkpoint, dataset):
    training = (
        training_metadata
        if isinstance(training_metadata, dict)
        else json.loads(Path(training_metadata or Path(checkpoint).parent / "training.json").read_text())
    )
    if (
        not training.get("trained")
        or training.get("actual_updates", 0) <= 0
        or training.get("input_integrity_verified") is not True
        or training.get("invalidation_reason")
        or not training.get("validation", {}).get("complete")
    ):
        raise ValueError("a verified trained model with completed frozen validation is required")
    if Path(checkpoint).resolve() != Path(training["selected_checkpoint"]).resolve():
        raise ValueError("checkpoint differs from frozen validation selection")
    for key, expected in (
        ("dataset_canonical_sha256", dataset["dataset_sha256"]),
        ("split_manifest_sha256", dataset["split_manifest_sha256"]),
    ):
        if training.get(key) != expected:
            raise ValueError("training/evaluation dataset provenance mismatch")
    if sha256(checkpoint) != training.get("checkpoint_sha256"):
        raise ValueError("native checkpoint bytes changed")
    selection = str(training.get("selection", training.get("selection_metric", "")))
    if "validation" not in selection:
        raise ValueError("model selection must be documented as validation-only")
    return training


def evaluate_forecast(
    dataset_path,
    checkpoint,
    output,
    *,
    training_metadata=None,
    split="validation",
    acknowledge_reused_test=False,
):
    """One frozen U-Net plus three equal-information baselines; no fitting.

    The common primary growth-IoU population uses observed-growth-positive
    pairs for every method. All pairs remain in raw footprint/calibration and
    no-growth diagnostics. Whole incident groups are bootstrap units.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq
    import torch
    from .data import load_dataset, load_sequence, grid_from_record
    from .unet import UNetPredictor

    if split not in {"validation", "test"}:
        raise ValueError("validation or reused test partition required")
    if split == "test" and not acknowledge_reused_test:
        raise ValueError(
            "the previously inspected test panel requires explicit diagnostic reuse acknowledgement"
        )
    output = Path(output)
    if (output / "metrics.json").exists():
        raise ValueError("completed evaluation exists; rebuild reports instead")
    dataset = load_dataset(dataset_path)
    training = _receipt(training_metadata, checkpoint, dataset)
    frozen = freeze_inputs(dataset_path, dataset)
    pairs = primary_pairs(dataset, split)
    if not pairs:
        raise ValueError("no eligible frozen forecasting pairs")
    records = {r["sequence_id"]: r for r in dataset["sequences"]}
    if any(records[p["sequence_id"]]["split"] != split for p in pairs):
        raise ValueError("pair crosses declared split")
    torch.set_num_threads(1)
    predictor = UNetPredictor(checkpoint, training)
    selected_threshold = float(training.get("threshold", 0.5))
    if not 0 < selected_threshold < 1 or float(predictor.threshold) != selected_threshold:
        raise ValueError("validation-selected threshold differs from frozen native metadata")
    sidecar = Path(dataset["_manifest_path"]).parent / "analysis_metadata.json"
    analysis = json.loads(sidecar.read_text()) if sidecar.exists() else {}
    if analysis and analysis.get("dataset_sha256") != dataset["dataset_sha256"]:
        raise ValueError("strata sidecar belongs to another dataset")
    output.mkdir(parents=True, exist_ok=True)
    declared = (
        json.loads((output / "protocol.json").read_text()) if (output / "protocol.json").exists() else {}
    )
    protocol = {
        **declared,
        "schema_version": "supervised-wildfire-protocol-v1",
        "model_family": "time_conditioned_unet",
        "threshold": 0.5,
        "unet_validation_selected_threshold": selected_threshold,
        "probability_calibration": training.get("calibration"),
        "physical_ensemble_size": 16,
        "physical_ensemble_seeds": list(range(17001, 17017)),
        "grid_shape": [128, 128],
        "orientation": "row0_south_col0_west",
        "rasterization": dataset["rasterization"],
        "domain_algorithm": dataset["domain_algorithm"],
        "target": "raw_later_observed_component_footprint",
        "primary_population": "common actual-growth-positive pairs for all methods",
        "horizons_s": [21600, 259200],
        "split": split,
        "test_status": "previously inspected; reused diagnostic panel"
        if split == "test"
        else "validation model-selection panel",
        "bootstrap_resamples": 2000,
        "bootstrap_seed": 20261024,
        "test_pair_manifest_sha256": canonical_hash(pairs),
        "forecast_example_pair_ids": sorted(p["pair_id"] for p in pairs)[:3],
        "historical_weather": "unavailable; physical baseline assumes zero wind",
        "unet_uncertainty": "deterministic probability head; no ensemble arrivals",
    }
    for name, value in (
        ("protocol.json", protocol),
        ("evaluation_pairs.json", pairs),
        ("training_runs.json", training),
        ("evaluation_input_manifest.json", frozen),
    ):
        atomic_json(output / name, value)
    rows = []
    secondary_rows = []
    runtimes = {}
    writer = None
    last = None
    sequence = None
    started = time.monotonic()
    partial = output / ".forecast_predictions.partial.parquet"
    try:
        for number, pair in enumerate(pairs, 1):
            if pair["sequence_id"] != last:
                sequence = load_sequence(records[pair["sequence_id"]])
                last = pair["sequence_id"]
            i, j = pair["from_index"], pair["to_index"]
            current, target = sequence["masks"][i], sequence["masks"][j]
            valid = np.asarray(sequence["valid"], bool)
            grid = grid_from_record(sequence["grid"])
            forecasts = forecast_baselines(sequence, i, pair["horizon_s"])
            before = time.perf_counter()
            prediction = predictor.predict(sequence, pair)
            forecasts["unet"] = {
                "probability": prediction["probability"],
                "latency_ms": 1000 * (time.perf_counter() - before),
                "model_version": prediction["model_version"],
                "no_ensemble": True,
            }
            coverage = sequence.get("coverage_fraction", [None] * len(sequence["masks"]))[j]
            outside = sequence.get("out_of_domain_area_m2", [None] * len(sequence["masks"]))[j]
            for model, forecast in forecasts.items():
                probability = np.asarray(forecast["probability"], float)
                score = forecast_metrics(current, target, probability, valid, cell_size_m=grid.cell_size_m)
                record = {
                    **pair,
                    "model": model,
                    "split": split,
                    "history_length": i + 1,
                    "latency_ms": forecast["latency_ms"],
                    "model_version": forecast.get("model_version"),
                    "target_coverage_fraction": coverage,
                    "target_out_of_domain_area_m2": outside,
                    "target_coverage_bucket": "unknown"
                    if coverage is None
                    else "complete"
                    if coverage >= 1 - 1e-9
                    else "clipped",
                    "source_jurisdiction": analysis.get("components", {})
                    .get(pair["component_id"], {})
                    .get("source_jurisdiction", "unknown"),
                    "horizon_bucket": "6–12h"
                    if pair["horizon_s"] < 43200
                    else "12–36h"
                    if pair["horizon_s"] <= 129600
                    else "36–72h",
                    "fire_size_bucket": "small"
                    if current.sum() * grid.cell_size_m**2 < 10e6
                    else "medium"
                    if current.sum() * grid.cell_size_m**2 < 100e6
                    else "large",
                    **score,
                }
                rows.append(record)
                if model == "unet":
                    secondary_rows.append(
                        {
                            **pair,
                            "model": "unet_validation_threshold",
                            **forecast_metrics(
                                current,
                                target,
                                probability,
                                valid,
                                cell_size_m=grid.cell_size_m,
                                threshold=selected_threshold,
                            ),
                        }
                    )
                runtimes.setdefault(model, []).append(forecast["latency_ms"])
                n = current.size
                members = forecast.get("members")
                bits = (
                    np.sum(
                        (np.asarray(members) <= pair["horizon_s"]).astype(np.uint16)
                        * (1 << np.arange(16, dtype=np.uint16))[:, None, None],
                        axis=0,
                        dtype=np.uint32,
                    ).astype(np.uint16)
                    if members is not None
                    else None
                    if forecast.get("no_ensemble")
                    else np.where(probability >= 0.5, 65535, 0).astype(np.uint16)
                )
                table = pa.table(
                    {
                        "model": [model] * n,
                        "group_id": [pair["group_id"]] * n,
                        "pair_id": [pair["pair_id"]] * n,
                        "sequence_id": [pair["sequence_id"]] * n,
                        "cell_id": np.arange(n, dtype=np.int32),
                        "current": current.ravel(),
                        "target": target.ravel(),
                        "valid": valid.ravel(),
                        "probability": probability.ravel(),
                        "member_affect_bits": pa.array([None] * n, type=pa.uint16())
                        if bits is None
                        else pa.array(bits.ravel(), type=pa.uint16()),
                        "issue_s": np.full(n, pair["issue_s"]),
                        "target_s": np.full(n, pair["target_s"]),
                        "horizon_s": np.full(n, pair["horizon_s"]),
                        "cell_size_m": np.full(n, float(grid.cell_size_m)),
                        "target_coverage_fraction": pa.array([coverage] * n, type=pa.float64()),
                        "target_out_of_domain_area_m2": pa.array([outside] * n, type=pa.float64()),
                    }
                )
                if writer is None:
                    writer = pq.ParquetWriter(partial, table.schema, compression="zstd")
                writer.write_table(table)
            print(
                json.dumps(
                    {
                        "stage": "frozen_supervised_evaluation",
                        "pairs": number,
                        "total": len(pairs),
                        "elapsed_s": time.monotonic() - started,
                    }
                ),
                flush=True,
            )
    finally:
        if writer is not None:
            writer.close()
    assert_inputs_unchanged(frozen)
    partial.replace(output / "forecast_predictions.parquet")
    summary = aggregate(rows)
    secondary_summary = aggregate(secondary_rows)["unet_validation_threshold"]
    atomic_json(
        output / "validation_threshold_metrics.json",
        {
            "threshold": selected_threshold,
            "selection": "validation only; same frozen probabilities; no additional inference",
            "summary": secondary_summary,
            "per_incident": per_incident(secondary_rows),
            "pair_metrics": secondary_rows,
        },
    )
    differences = [
        paired_bootstrap(rows, "unet", baseline, metric=key)
        for baseline in BASELINES
        for key in ("new_growth_iou", "new_growth_dice", "brier", "f1", "average_precision")
    ]
    incidents = per_incident(rows)
    with (output / "per_incident_metrics.csv").open("w", newline="") as stream:
        w = csv.DictWriter(stream, fieldnames=list(incidents[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(incidents)
    for name, value in (("pair_metrics.json", rows), ("confidence_intervals.json", differences)):
        atomic_json(output / name, value)
    strata = {
        dimension: {
            str(value): aggregate([r for r in rows if r.get(dimension) == value])
            for value in sorted({r.get(dimension, "unknown") for r in rows}, key=str)
        }
        for dimension in (
            "year",
            "region",
            "source_jurisdiction",
            "horizon_bucket",
            "history_length",
            "fire_size_bucket",
            "target_coverage_bucket",
        )
    }
    atomic_json(output / "subgroup_metrics.json", strata)
    known = [r for r in rows if r["model"] == "unet" and r["target_coverage_fraction"] is not None]
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)
    metrics = {
        "schema_version": SCHEMA,
        "model_family": "time_conditioned_unet",
        "agent": "codex",
        "base_commit": "dcaaf5b",
        "archive_sha256": dataset["archive_sha256"],
        "dataset_canonical_sha256": dataset["dataset_sha256"],
        "split_manifest_sha256": dataset["split_manifest_sha256"],
        "test_pair_manifest_sha256": canonical_hash(pairs),
        "evaluation_split": split,
        "evaluation_incident_groups": len({p["group_id"] for p in pairs}),
        "evaluation_forecast_pairs": len(pairs),
        "test_set_status": protocol["test_status"],
        "unet": summary["unet"],
        "primary_threshold": 0.5,
        "validation_selected_threshold": selected_threshold,
        "secondary_validation_threshold": secondary_summary,
        "probability_calibration": training.get("calibration"),
        "baselines": {name: summary[name] for name in BASELINES},
        "confidence_intervals": differences,
        "training": {
            "elapsed_seconds": training.get("elapsed_seconds"),
            "actual_updates": training.get("actual_updates"),
            "actual_processed_pairs": training.get("actual_processed_pairs"),
            "epochs_completed": training.get("epochs_completed"),
            "completed": training.get("completed"),
            "seed": training.get("config", {}).get("seed"),
        },
        "coverage": {
            "known_pairs": len(known),
            "clipped_pairs": sum(r["target_coverage_fraction"] < 1 - 1e-9 for r in known),
            "mean_geometric_coverage": float(np.mean([r["target_coverage_fraction"] for r in known]))
            if known
            else None,
            "interpretation": "pixel scores exclude outside-grid target geometry",
        },
        "runtime": {
            "inference_device": "cpu",
            "torch_threads": torch.get_num_threads(),
            "per_model_median_ms": {name: float(np.median(values)) for name, values in runtimes.items()},
            "inference_median_ms": float(np.median(runtimes["unet"])),
            "ensemble_median_ms": float(np.median(runtimes["existing_physical"])),
            "model_size_bytes": Path(checkpoint).stat().st_size,
            "evaluation_elapsed_s": time.monotonic() - started,
            "peak_memory_bytes": rss,
        },
        "validation": {
            "evaluation_input_integrity_verified": True,
            "tests_passed": None,
            "tests_failed": None,
            "integration_status": "not_checked_by_evaluator",
            "known_limitations": [
                "historical weather unavailable",
                "raw irregular footprint labels",
                "fixed-domain clipping",
                "test panel previously inspected",
                "no real rescue validation",
            ],
        },
    }
    atomic_json(output / "metrics.json", metrics)
    return metrics


evaluate_benchmark = evaluate_forecast
evaluate = evaluate_forecast


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--training", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--split", choices=("validation", "test"), default="validation")
    parser.add_argument("--acknowledge-reused-test", action="store_true")
    args = parser.parse_args()
    training = json.loads(Path(args.training).read_text())
    if not training.get("selected_checkpoint"):
        parser.error("receipt has no frozen validation-selected model")
    result = evaluate_forecast(
        args.dataset,
        training["selected_checkpoint"],
        args.output,
        training_metadata=training,
        split=args.split,
        acknowledge_reused_test=args.acknowledge_reused_test,
    )
    print(
        json.dumps(
            {
                "stage": "supervised_evaluation_complete",
                "unet": result["unet"],
                "test_status": result["test_set_status"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
