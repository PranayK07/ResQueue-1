"""Explicit bounded supervised U-Net fitting. Importing this module never trains.

Each completed epoch visits every eligible train pair once. Only the frozen
validation panel selects epochs and thresholds. The analytic BCE prior correction
uses train counts; no calibration parameters are fitted on validation or test.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import json
from pathlib import Path
import signal
import time

import numpy as np
import torch
from torch.utils.data import DataLoader, Subset

from .provenance import (
    atomic_json,
    sha256,
    freeze_training_inputs,
    assert_training_inputs_unchanged,
    TrainingInputsChanged,
)
from .unet import (
    ARCHITECTURE,
    FEATURE_NAMES,
    FEATURE_SCHEMA,
    ForecastPairDataset,
    TimeConditionedUNet,
    _parameter_hash,
    _save_native,
    cumulative_probability,
    normalization_for_records,
    segmentation_loss,
    selected_native_validation,
    training_class_counts,
)

DEFAULTS = {
    "agent": "codex",
    "algorithm": "supervised_time_conditioned_unet",
    "seed": 101,
    "width": 16,
    "depth": 3,
    "batch_size": 16,
    "learning_rate": 0.001,
    "weight_decay": 0.01,
    "epochs": 20,
    "patience": 5,
    "growth_dice_weight": 0.2,
    "max_pos_weight": 50.0,
    "threshold_grid": [0.05, 0.1, 0.2, 0.3, 0.4, 0.5],
    "torch_threads": 1,
    "num_workers": 0,
    "device": "mps",
}


class _CapReached(RuntimeError):
    pass


def _check_deadline(deadline):
    if time.monotonic() >= deadline:
        raise _CapReached("authorized supervised training budget reached")


def _validation_pairs(records):
    """Same frozen first/middle/last-by-incident rule, with no training imports."""
    from .evaluation import primary_pairs

    return primary_pairs({"sequences": records}, "validation")


def validate(model, data, *, pos_weight, thresholds, batch_size, deadline):
    """Cheap exact confusion/Brier sufficient statistics on the frozen panel."""
    model.eval()
    device = next(model.parameters()).device
    rows = []
    loader = DataLoader(data, batch_size=batch_size, shuffle=False, num_workers=0)
    with torch.inference_mode():
        for batch in loader:
            _check_deadline(deadline)
            logits = model(batch["inputs"].to(device))
            current = batch["current"].to(device)
            probabilities = cumulative_probability(logits, current, pos_weight).cpu().numpy()[:, 0]
            raw_probabilities = cumulative_probability(logits, current, 1.0).cpu().numpy()[:, 0]
            for k, pair_index in enumerate(batch["pair_index"].tolist()):
                pair = data.pairs[pair_index]
                current_np = batch["current"][k, 0].numpy().astype(bool)
                target = batch["target"][k, 0].numpy().astype(bool)
                valid = batch["valid"][k, 0].numpy().astype(bool)
                domain = valid & ~current_np
                actual = target & domain
                p = probabilities[k]
                scores = []
                for threshold in thresholds:
                    prediction = (p >= threshold) & domain
                    tp = int((prediction & actual).sum())
                    fp = int((prediction & ~actual).sum())
                    fn = int((~prediction & actual).sum())
                    scores.append(
                        {
                            "threshold": threshold,
                            "tp": tp,
                            "fp": fp,
                            "fn": fn,
                            "new_growth_iou": tp / (tp + fp + fn) if actual.any() else None,
                        }
                    )
                rows.append(
                    {
                        "pair_index": pair_index,
                        "pair_id": pair.get("pair_id"),
                        "sequence_id": pair["sequence_id"],
                        "group_id": data.records[pair["sequence_id"]]["group_id"],
                        "from_index": pair["from_index"],
                        "to_index": pair["to_index"],
                        "horizon_s": pair["horizon_s"],
                        "actual_growth_cells": int(actual.sum()),
                        "raw_regression_cells": int((valid & current_np & ~target).sum()),
                        "brier": float(np.square(p[valid].astype(float) - target[valid]).mean()),
                        "raw_sigmoid_brier": float(
                            np.square(raw_probabilities[k][valid].astype(float) - target[valid]).mean()
                        ),
                        "new_growth_brier": float(np.square(p[domain].astype(float) - target[domain]).mean())
                        if domain.any()
                        else None,
                        "threshold_scores": scores,
                    }
                )
    _check_deadline(deadline)
    by_group = defaultdict(list)
    for row in rows:
        by_group[row["group_id"]].append(row)
    macro_brier = float(np.mean([np.mean([r["brier"] for r in group]) for group in by_group.values()]))
    raw_brier = float(
        np.mean([np.mean([r["raw_sigmoid_brier"] for r in group]) for group in by_group.values()])
    )
    threshold_scores = []
    for index, threshold in enumerate(thresholds):
        group_ious = [
            float(
                np.mean(
                    [
                        r["threshold_scores"][index]["new_growth_iou"]
                        for r in group
                        if r["actual_growth_cells"] > 0
                    ]
                )
            )
            for group in by_group.values()
            if any(r["actual_growth_cells"] > 0 for r in group)
        ]
        threshold_scores.append(
            {
                "threshold": threshold,
                "macro_new_growth_iou": float(np.mean(group_ious)) if group_ious else None,
                "positive_growth_groups": len(group_ious),
                "macro_brier": macro_brier,
            }
        )
    eligible = [s for s in threshold_scores if s["macro_new_growth_iou"] is not None]
    if not eligible:
        raise ValueError("validation panel has no observed positive-growth groups")
    selected = max(eligible, key=lambda s: (s["macro_new_growth_iou"], -s["macro_brier"], -s["threshold"]))
    return {
        **selected,
        "macro_raw_sigmoid_brier": raw_brier,
        "groups": len(by_group),
        "pairs": len(rows),
        "positive_growth_pairs": sum(r["actual_growth_cells"] > 0 for r in rows),
        "threshold_grid_scores": threshold_scores,
        "selection": "incident macro actual-positive-growth IoU, lower full-footprint Brier, lower threshold for exact ties",
        "complete": True,
    }, rows


def _config(config):
    cfg = {**DEFAULTS, **(config or {})}
    if set(cfg) != set(DEFAULTS):
        raise ValueError("unknown supervised training configuration key")
    for key in DEFAULTS:
        if key not in {"seed", "device"} and cfg[key] != DEFAULTS[key]:
            raise ValueError(f"predeclared supervised configuration is fixed: {key}")
    if cfg["seed"] not in (101, 202, 303) or cfg["device"] not in ("mps", "cpu"):
        raise ValueError("unsupported predeclared seed or device")
    return cfg


def train(dataset_path, output, config=None, *, max_seconds, resume=None):
    """Train only when explicitly called; root owns the cumulative budget ledger.

    max_seconds includes loading/counting, training, full validation and saving.
    Ten seconds are reserved for synchronized final checkpoint/receipt cleanup.
    The caller must enforce its campaign wall cap across all seeds/resumptions.
    """
    started = time.monotonic()
    if not 10 < max_seconds <= 2820:
        raise ValueError("authorized remaining invocation cap must be 10 < seconds <= 2820")
    cfg = _config(config)
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if (output / "training.json").exists() and not resume:
        raise ValueError("existing supervised run requires explicit --resume")
    from .data import load_dataset

    dataset = load_dataset(dataset_path)
    snapshot = freeze_training_inputs(dataset_path, dataset)
    records = [r for r in dataset["sequences"] if r["split"] == "train"]
    validation_records = [r for r in dataset["sequences"] if r["split"] == "validation"]
    normalization = normalization_for_records(records)
    data = ForecastPairDataset(records, normalization)
    validation_data = ForecastPairDataset(
        validation_records, normalization, pairs=_validation_pairs(validation_records)
    )
    if not len(validation_data):
        raise ValueError("a frozen nonempty validation panel is required")
    counts = training_class_counts(data, cfg["max_pos_weight"])
    correction = {
        "method": "analytic_weighted_bce_logit_prior_correction",
        "logit_subtraction": float(np.log(counts["pos_weight"])),
        "pos_weight": counts["pos_weight"],
        "fit_partition": "train",
        "fitted_calibration_parameters": False,
        "approximate_because": "fixed 0.2 soft Dice auxiliary and finite model optimization; assess empirical Brier/ECE",
    }
    torch.set_num_threads(cfg["torch_threads"])
    torch.manual_seed(cfg["seed"])
    if cfg["device"] == "mps":
        if not torch.backends.mps.is_available():
            raise RuntimeError("configured MPS device is unavailable")
        torch.mps.manual_seed(cfg["seed"])
    rng = np.random.default_rng(cfg["seed"])
    model = TimeConditionedUNet().to(cfg["device"])
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=cfg["learning_rate"], weight_decay=cfg["weight_decay"]
    )
    initial_hash = _parameter_hash(model)
    epoch = cursor = updates = processed = stale = 0
    prior_elapsed = epoch_loss_sum = 0.0
    epoch_loss_pairs = 0
    order = None
    curve, best_validation_rows = [], []
    best_path = best_hash = None
    best_score = (-1.0, -float("inf"))
    if resume:
        native = torch.load(resume, map_location="cpu", weights_only=True)
        previous = native["metadata"]
        if "resume" not in native or native.get("optimizer_state") is None:
            raise ValueError("resume requires latest.pt with optimizer and epoch state")
        for key, value in (
            ("feature_schema", FEATURE_SCHEMA),
            ("dataset_canonical_sha256", snapshot["dataset_canonical_sha256"]),
            ("config", cfg),
            ("normalization", normalization),
            ("class_counts", counts),
        ):
            if previous.get(key) != value:
                raise ValueError(f"resume {key} mismatch")
        model.load_state_dict(native["model_state"])
        optimizer.load_state_dict(native["optimizer_state"])
        initial_hash = previous["parameter_hash_before"]
        state = native["resume"]
        epoch, cursor, updates, processed, prior_elapsed, stale = (
            state[k] for k in ("epoch", "batch_cursor", "updates", "processed", "elapsed_seconds", "stale")
        )
        order, curve = state["order"], state["curve"]
        epoch_loss_sum, epoch_loss_pairs = state["epoch_loss_sum"], state["epoch_loss_pairs"]
        best_path, best_score, best_hash = (
            state["best_checkpoint"],
            tuple(state["best_score"]),
            state["best_parameter_hash"],
        )
        rng.bit_generator.state = state["numpy_rng"]
        torch.set_rng_state(state["torch_rng"].cpu())
    deadline = started + float(max_seconds) - 10
    metadata = {
        "schema_version": "wildfire-supervised-training-v2",
        "feature_schema": FEATURE_SCHEMA,
        "feature_names": FEATURE_NAMES,
        "architecture": ARCHITECTURE,
        "normalization": normalization,
        "calibration": correction,
        "class_counts": counts,
        "config": cfg,
        "dataset_file_sha256": snapshot["dataset_file_sha256"],
        "dataset_canonical_sha256": snapshot["dataset_canonical_sha256"],
        "archive_sha256": dataset["archive_sha256"],
        "clean_dataset_sha256": dataset["clean_sha256"],
        "split_manifest_sha256": snapshot["split_manifest_file_sha256"],
        "family": "supervised_time_conditioned_unet",
        "ensemble_size": None,
        "grid_shape": [128, 128],
        "orientation": "row0south_col0west",
        "grid_domain_algorithm": dataset.get("domain_algorithm"),
        "rasterization": dataset.get("rasterization"),
        "supported_horizon_s": [21600, 259200],
        "source_sha256": {
            "unet.py": sha256(Path(__file__).with_name("unet.py")),
            "train_supervised.py": sha256(__file__),
        },
        "dependencies": {"torch": str(torch.__version__), "numpy": str(np.__version__)},
        "device": cfg["device"],
        "model_seed": cfg["seed"],
        "parameter_hash_before": initial_hash,
        "sampling": "one shuffled pass over all actual eligible training pairs per complete epoch",
        "training_pairs_per_epoch": len(data),
        "validation_pairs": len(validation_data),
        "validation_groups": len({p["group_id"] for p in validation_data.pairs}),
        "loss_domain": "valid & ~current; raw regression labels unchanged and scored at evaluation",
        "selection_metric": "incident_macro_validation_actual_positive_growth_iou_then_lower_full_brier",
        "threshold_selection": "same frozen validation panel and fixed grid, no test tuning",
    }
    atomic_json(output / "input_manifest.json", snapshot)
    atomic_json(output / "configuration.json", metadata)
    capped = False
    invalidation = training_error = None
    previous_handler = signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(_CapReached()))
    signal.setitimer(signal.ITIMER_REAL, max(1e-6, deadline - time.monotonic()))
    try:
        _check_deadline(deadline)
        while epoch < cfg["epochs"] and stale < cfg["patience"]:
            assert_training_inputs_unchanged(snapshot)
            if order is None:
                order = rng.permutation(len(data)).tolist()
            loader = DataLoader(
                Subset(data, order[cursor:]), batch_size=cfg["batch_size"], shuffle=False, num_workers=0
            )
            model.train()
            for batch in loader:
                _check_deadline(deadline)
                optimizer.zero_grad(set_to_none=True)
                inputs, current, target, valid = (
                    batch[k].to(cfg["device"]) for k in ("inputs", "current", "target", "valid")
                )
                logits = model(inputs)
                loss, _ = segmentation_loss(
                    logits, current, target, valid, cfg["growth_dice_weight"], counts["pos_weight"]
                )
                if not bool(torch.isfinite(loss)):
                    raise FloatingPointError("nonfinite supervised loss")
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 10.0, error_if_nonfinite=True)
                _check_deadline(deadline)
                optimizer.step()
                updates += 1
                processed += len(inputs)
                cursor += len(inputs)
                epoch_loss_sum += float(loss.detach().cpu()) * len(inputs)
                epoch_loss_pairs += len(inputs)
            validation, validation_rows = validate(
                model,
                validation_data,
                pos_weight=counts["pos_weight"],
                thresholds=cfg["threshold_grid"],
                batch_size=cfg["batch_size"],
                deadline=deadline,
            )
            assert_training_inputs_unchanged(snapshot)
            epoch += 1
            cursor, order = 0, None
            row = {
                "epoch": epoch,
                "updates": updates,
                "processed_pairs": processed,
                "mean_training_loss": epoch_loss_sum / max(epoch_loss_pairs, 1),
                "validation": validation,
                "elapsed_seconds": prior_elapsed + time.monotonic() - started,
            }
            curve.append(row)
            epoch_loss_sum, epoch_loss_pairs = 0.0, 0
            key = (validation["macro_new_growth_iou"], -validation["macro_brier"])
            if key > best_score:
                best_hash = _parameter_hash(model)
                candidate_meta = {
                    **metadata,
                    "trained": True,
                    "actual_updates": updates,
                    "validation": validation,
                    "threshold": validation["threshold"],
                    "parameter_hash_after": best_hash,
                    "model_identity": best_hash[:16],
                    "actual_parameter_update": best_hash != initial_hash,
                    "selected_epoch": epoch,
                }
                best_path = str(output / "best.pt")
                _save_native(best_path, model, optimizer, candidate_meta)
                best_validation_rows = validation_rows
                atomic_json(output / "selected_validation_pairs.json", best_validation_rows)
                stale, best_score = 0, key
            else:
                stale += 1
            atomic_json(output / "learning_curve.json", curve)
            print(json.dumps({"stage": "supervised_unet_epoch", **row}), flush=True)
    except _CapReached:
        capped = True
    except TrainingInputsChanged as exc:
        invalidation = str(exc)
    except (FloatingPointError, RuntimeError, ValueError) as exc:
        training_error = f"{type(exc).__name__}: {exc}"
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
    try:
        assert_training_inputs_unchanged(snapshot)
    except TrainingInputsChanged as exc:
        invalidation = str(exc)
    final_hash = _parameter_hash(model)
    resume_state = {
        "epoch": epoch,
        "batch_cursor": cursor,
        "updates": updates,
        "processed": processed,
        "elapsed_seconds": prior_elapsed + time.monotonic() - started,
        "stale": stale,
        "order": order,
        "numpy_rng": rng.bit_generator.state,
        "torch_rng": torch.get_rng_state(),
        "curve": curve,
        "epoch_loss_sum": epoch_loss_sum,
        "epoch_loss_pairs": epoch_loss_pairs,
        "best_checkpoint": best_path,
        "best_score": list(best_score),
        "best_parameter_hash": best_hash,
    }
    latest_metadata = {
        **metadata,
        "trained": updates > 0,
        "actual_updates": updates,
        "parameter_hash_after": final_hash,
        "model_identity": final_hash[:16],
        "actual_parameter_update": updates > 0 and final_hash != initial_hash,
    }
    _save_native(output / "latest.pt", model, optimizer, latest_metadata, resume=resume_state)
    selected_validation = selected_native_validation(best_path) if best_path else None
    selected_metadata = (
        torch.load(best_path, map_location="cpu", weights_only=True)["metadata"] if best_path else {}
    )
    elapsed = prior_elapsed + time.monotonic() - started
    receipt = {
        **metadata,
        "actual_updates": updates,
        "actual_processed_pairs": processed,
        "epochs_completed": epoch,
        "elapsed_seconds": elapsed,
        "invocation_elapsed_seconds": time.monotonic() - started,
        "prior_elapsed_seconds": prior_elapsed,
        "authorized_invocation_cap_seconds": float(max_seconds),
        "finalization_reserve_seconds": 10,
        "completed": invalidation is None
        and training_error is None
        and (epoch >= cfg["epochs"] or stale >= cfg["patience"]),
        "budget_reached": capped,
        "cap_interruption_note": "signal interruption may replay an interrupted batch on explicit resume; selection uses only complete validation epochs"
        if capped
        else None,
        "input_integrity_verified": invalidation is None,
        "invalidation_reason": invalidation,
        "training_error": training_error,
        "selected_checkpoint": best_path if not invalidation else None,
        "selected_seed": cfg["seed"],
        "validation": selected_validation,
        "selected_epoch": selected_metadata.get("selected_epoch"),
        "threshold": selected_metadata.get("threshold"),
        "checkpoint_sha256": sha256(best_path) if best_path else None,
        "model_identity": best_hash[:16] if best_hash else None,
        "selected_parameter_hash": best_hash,
        "parameter_hash_after": final_hash,
        "actual_parameter_update": updates > 0 and final_hash != initial_hash,
        "trained": updates > 0,
        "requires_explicit_activation": True,
    }
    atomic_json(output / "training.json", receipt)
    atomic_json(output / "learning_curve.json", curve)
    if best_path:
        atomic_json(
            output / "model_metadata.json",
            {**selected_metadata, "checkpoint_sha256": receipt["checkpoint_sha256"]},
        )
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--max-seconds", required=True, type=float)
    parser.add_argument("--seed", choices=(101, 202, 303), type=int)
    parser.add_argument("--resume")
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    if args.seed is not None:
        config["seed"] = args.seed
    print(
        json.dumps(
            train(args.dataset, args.output, config, max_seconds=args.max_seconds, resume=args.resume),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
