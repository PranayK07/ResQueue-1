"""Copy native supervised weights with measured validation gates; no fitting."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import shutil

import numpy as np

from .metrics import paired_bootstrap
from .provenance import atomic_json, sha256


def export_native(training_path, validation_dir, output):
    training = json.loads(Path(training_path).read_text())
    validation_dir = Path(validation_dir)
    measured = json.loads((validation_dir / "metrics.json").read_text())
    if (
        measured["evaluation_split"] != "validation"
        or not training.get("trained")
        or not training.get("input_integrity_verified")
    ):
        raise ValueError("export requires verified training and validation evidence")
    for key in ["archive_sha256", "split_manifest_sha256", "dataset_canonical_sha256"]:
        if training[key] != measured[key]:
            raise ValueError("training/validation provenance differs")
    rows = json.loads((validation_dir / "pair_metrics.json").read_text())
    secondary = json.loads((validation_dir / "validation_threshold_metrics.json").read_text())
    comparisons = [
        paired_bootstrap(
            [r for r in rows if r["model"] != "unet"] + secondary["pair_metrics"],
            "unet_validation_threshold",
            baseline,
            metric="new_growth_iou",
        )
        for baseline in ["persistence", "existing_physical", "growth_extrapolation"]
    ]
    growth_ok = all(r["ci95"] is not None and r["ci95"][0] > 0 for r in comparisons)
    probability_ok = measured["unet"]["brier_macro"] <= measured["baselines"]["persistence"]["brier_macro"]
    latency = [r["latency_ms"] for r in rows if r["model"] == "unet"]
    timing = {
        "median_ms": float(np.median(latency)),
        "p95_ms": float(np.quantile(latency, 0.95)),
        "limit_ms": 2000.0,
    }
    timing_ok = timing["p95_ms"] <= 2000
    from .unet import NativePredictor, FEATURE_SCHEMA

    predictor = NativePredictor(training["selected_checkpoint"], training)
    if not predictor.metadata.get("trained") or not predictor.metadata.get("actual_parameter_update"):
        raise ValueError("native checkpoint has no trained-state evidence")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    source = Path(training["selected_checkpoint"])
    digest = sha256(source)
    destination = output / "model.pt"
    if destination.exists() and sha256(destination) != digest:
        raise ValueError("export already contains a different model")
    temporary = output / ".model.partial.pt"
    shutil.copyfile(source, temporary)
    os.replace(temporary, destination)
    reasons = []
    if not growth_ok:
        reasons.append("validation growth improvement is not established against every baseline")
    if not probability_ok:
        reasons.append("validation Brier is worse than persistence")
    if not timing_ok:
        reasons.append("measured inference timing gate failed")
    metadata = {
        **training,
        "selected_checkpoint": str(destination.resolve()),
        "checkpoint_sha256": digest,
        "export_schema_version": "supervised-native-export-v1",
        "model_family": "time_conditioned_unet",
        "dependencies": {n: importlib.metadata.version(n) for n in ["torch", "numpy", "scipy", "pyproj"]},
        "deployment": {
            "feature_schema": FEATURE_SCHEMA,
            "model_family": "time_conditioned_unet",
            "trained": True,
            "model_id": training["model_identity"],
            "checkpoint_sha256": digest,
            "grid_shape": [128, 128],
            "supported_horizon_s": [21600, 259200],
            "required_modalities": ["known_perimeter"],
            "missing_modalities": ["historical_weather", "vegetation", "terrain", "information_release_time"],
            "validation_passed": bool(growth_ok and probability_ok),
            "inference_checked": bool(timing_ok),
            "growth_gate_passed": bool(growth_ok),
            "probability_gate_passed": bool(probability_ok),
            "validation_threshold": training["threshold"],
            "growth_comparisons": comparisons,
            "timing": timing,
            "activation_scope": "supplementary historical risk with compatible known history only",
            "minute_dispatch_validated": False,
            "default_backend": "simulation",
            "fallback_reasons": reasons,
        },
    }
    atomic_json(output / "model_metadata.json", metadata)
    receipt = {
        "schema_version": "supervised-export-receipt-v1",
        "checkpoint_sha256": digest,
        "model": str(destination.resolve()),
        "metadata_sha256": sha256(output / "model_metadata.json"),
        "validation_quality_passed": bool(growth_ok and probability_ok),
        "inference_timing_passed": bool(timing_ok),
        "activation_scope": metadata["deployment"]["activation_scope"],
        "app_settings_changed": False,
        "optimizer_updates": 0,
        "fallback_reasons": reasons,
    }
    atomic_json(output / "export_receipt.json", receipt)
    return receipt


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ["training", "validation-dir", "output"]:
        p.add_argument("--" + name, required=True)
    a = p.parse_args()
    print(json.dumps(export_native(a.training, a.validation_dir, a.output), indent=2))


if __name__ == "__main__":
    main()
