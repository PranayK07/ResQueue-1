"""Supervised wildfire reports rebuilt exclusively from saved evidence.

No model is loaded and no training/inference routine is called. Undefined
metrics remain null. Classification on known affected cells is distinguished
from prediction of new growth; previously inspected test reuse is explicit.
"""

from __future__ import annotations
import argparse
import base64
from datetime import datetime, timezone
import html
import json
from pathlib import Path
import numpy as np

MODELS = ("persistence", "existing_physical", "growth_extrapolation", "unet")
LABELS = {
    "persistence": "Persistence",
    "existing_physical": "Physical ensemble",
    "growth_extrapolation": "Growth extrapolation",
    "unet": "Time-conditioned U-Net",
}
SHORT_LABELS = {
    "persistence": "Persistence",
    "existing_physical": "Physical",
    "growth_extrapolation": "Extrapolation",
    "unet": "U-Net",
}
COLORS = {
    "persistence": "#757575",
    "existing_physical": "#0072b2",
    "growth_extrapolation": "#009e73",
    "unet": "#8e44ad",
}


def _read(path, fallback=None):
    path = Path(path)
    return json.loads(path.read_text()) if path.exists() else fallback


def _number(value, digits=4):
    return (
        f"{value:.{digits}f}"
        if isinstance(value, (int, float)) and np.isfinite(value)
        else "undefined / not measured"
    )


def _plotting():
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "font.size": 10,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "figure.dpi": 120,
            "savefig.dpi": 160,
            "axes.titleweight": "bold",
        }
    )
    return plt


def _save(plt, fig, path):
    fig.savefig(path, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def _unmeasured(plt, path, title, reason):
    fig, ax = plt.subplots(figsize=(10, 3))
    ax.axis("off")
    ax.text(0.02, 0.8, title, weight="bold", fontsize=17, transform=ax.transAxes)
    ax.text(0.02, 0.4, reason, wrap=True, transform=ax.transAxes)
    _save(plt, fig, path)


def _table(metrics):
    return {**metrics.get("baselines", {}), "unet": metrics.get("unet", {})}


def _scorecard(plt, directory, metrics):
    keys = [
        ("new_growth_iou_macro", "Growth IoU ↑"),
        ("new_growth_dice_macro", "Growth Dice ↑"),
        ("brier_macro", "Footprint Brier ↓"),
        ("f1_macro", "Footprint F1 ↑"),
        ("roc_auc_macro", "Footprint AUC ↑"),
        ("average_precision_macro", "Footprint AP ↑"),
    ]
    table = _table(metrics)
    fig, ax = plt.subplots(figsize=(14, 4))
    ax.axis("off")
    chart = ax.table(
        cellText=[[_number(table[m].get(k), 3) for k, _ in keys] for m in MODELS],
        rowLabels=[LABELS[m] for m in MODELS],
        colLabels=[title for _, title in keys],
        loc="center",
        cellLoc="center",
    )
    chart.auto_set_font_size(False)
    chart.set_fontsize(10)
    chart.scale(1, 2)
    for (row, _), cell in chart.get_celld().items():
        cell.set_edgecolor("white")
        cell.set_facecolor("#e9eff4" if row == 0 else "#f4f6f8" if row % 2 else "white")
    ax.set_title(
        f"Original common-0.50 comparison · {metrics['evaluation_incident_groups']} groups / {metrics['evaluation_forecast_pairs']} pairs",
        loc="left",
        fontsize=16,
    )
    fig.text(0.02, 0.04, metrics["test_set_status"], fontsize=10, color="#a34218")
    _save(plt, fig, directory / "scorecard.png")


def _comparison(plt, directory, rows):
    from .metrics import per_incident

    incidents = per_incident(rows)
    fig, axes = plt.subplots(1, 2, figsize=(12, 4))
    for ax, key in zip(axes, ["new_growth_iou", "new_growth_dice"]):
        for index, model in enumerate(MODELS):
            values = [r[key] for r in incidents if r["model"] == model and r.get(key) is not None]
            if values:
                ax.boxplot(
                    [values],
                    positions=[index],
                    widths=0.5,
                    patch_artist=True,
                    boxprops={"facecolor": COLORS[model], "alpha": 0.4},
                )
                x = np.asarray(values)
                rng = np.random.default_rng(20261024)
                interval = np.quantile(
                    x[rng.integers(0, len(x), size=(2000, len(x)))].mean(axis=1), [0.025, 0.975]
                )
                ax.errorbar(
                    index,
                    x.mean(),
                    yerr=[[max(0, x.mean() - interval[0])], [max(0, interval[1] - x.mean())]],
                    fmt="D",
                    color=COLORS[model],
                    capsize=4,
                )
        ax.set_xticks(range(4), [SHORT_LABELS[m] for m in MODELS])
        ax.set_ylim(-0.03, 1.03)
        ax.set_title(key.replace("_", " ").title(), loc="left")
        ax.grid(axis="y", alpha=0.2)
    fig.suptitle("Common observed-growth-positive pairs · incident means · 2,000 group bootstrap intervals")
    _save(plt, fig, directory / "growth_comparison.png")
    physics = {r["group_id"]: r for r in incidents if r["model"] == "existing_physical"}
    pairs = [
        (physics[r["group_id"]]["new_growth_iou"], r["new_growth_iou"])
        for r in incidents
        if r["model"] == "unet"
        and r["group_id"] in physics
        and r["new_growth_iou"] is not None
        and physics[r["group_id"]]["new_growth_iou"] is not None
    ]
    if pairs:
        fig, ax = plt.subplots(figsize=(6, 5))
        ax.scatter(*np.asarray(pairs).T, color=COLORS["unet"], alpha=0.6)
        ax.plot([0, 1], [0, 1], "--", color="gray")
        ax.set(
            xlim=(-0.02, 1.02),
            ylim=(-0.02, 1.02),
            xlabel="Physical incident growth IoU",
            ylabel="U-Net incident growth IoU",
            title="One point per incident group",
        )
        _save(plt, fig, directory / "per_incident_scatter.png")
    else:
        _unmeasured(
            plt,
            directory / "per_incident_scatter.png",
            "Per-incident comparison",
            "No defined paired incident scores",
        )


def _calibration(plt, directory, rows):
    fig, axes = plt.subplots(1, 2, figsize=(12, 4))
    for model in MODELS:
        bins = [{"count": 0, "probability_sum": 0.0, "positive_count": 0} for _ in range(10)]
        for row in rows:
            if row["model"] != model:
                continue
            for a, b in zip(bins, row.get("calibration", [])):
                for key in a:
                    a[key] += b[key]
        nonempty = [b for b in bins if b["count"]]
        if nonempty:
            axes[0].plot(
                [b["probability_sum"] / b["count"] for b in nonempty],
                [b["positive_count"] / b["count"] for b in nonempty],
                "o-",
                label=SHORT_LABELS[model],
                color=COLORS[model],
            )
            axes[1].plot(np.arange(10) / 10 + 0.05, [b["count"] for b in bins], "o-", color=COLORS[model])
    axes[0].plot([0, 1], [0, 1], "--", color="gray")
    axes[0].set(
        xlabel="Predicted affected probability",
        ylabel="Observed affected fraction",
        title="Full-footprint reliability",
    )
    axes[0].legend()
    axes[1].set(
        xlabel="Probability bin center",
        ylabel="Cell forecasts",
        yscale="symlog",
        title="Sample counts; cells are not independent fires",
    )
    _save(plt, fig, directory / "calibration.png")


def _learning(plt, directory, training):
    runs = training.get("campaign_seeds", [training])
    traces = []
    for run in runs:
        checkpoint = run.get("selected_checkpoint")
        curve = _read(Path(checkpoint).parent / "learning_curve.json", []) if checkpoint else []
        if curve:
            traces.append((run.get("selected_seed", run.get("model_seed")), curve))
    if not traces:
        _unmeasured(
            plt,
            directory / "learning_curves.png",
            "Supervised learning curves",
            "No saved epoch measurements supplied; training is not inferred from a filename",
        )
        return
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    for seed, curve in traces:
        epochs = [r["epoch"] for r in curve]
        axes[0, 0].plot(
            epochs, [r.get("mean_training_loss", np.nan) for r in curve], "o-", label=f"seed {seed}"
        )
        axes[1, 1].plot(epochs, [r.get("elapsed_seconds", np.nan) for r in curve], "o-", label=f"seed {seed}")
        for ax, key in [(axes[0, 1], "macro_new_growth_iou"), (axes[1, 0], "macro_brier")]:
            ax.plot(
                epochs, [r.get("validation", {}).get(key, np.nan) for r in curve], "o-", label=f"seed {seed}"
            )
        if seed == training.get("selected_seed"):
            selected = next((r for r in curve if r["epoch"] == training.get("selected_epoch")), None)
            if selected:
                axes[0, 1].scatter(
                    selected["epoch"],
                    selected["validation"]["macro_new_growth_iou"],
                    marker="*",
                    s=180,
                    edgecolor="black",
                    zorder=5,
                    label="globally selected checkpoint",
                )
    titles = [
        "Weighted BCE + Dice training loss",
        "Validation IoU at per-epoch selected threshold",
        "Validation full-footprint Brier ↓",
        "Elapsed training seconds",
    ]
    for ax, title in zip(axes.ravel(), titles):
        ax.set_title(title, loc="left", fontsize=11)
        ax.set_xlabel("Completed epoch")
        ax.grid(alpha=0.2)
    axes[0, 0].legend(fontsize=8)
    axes[0, 1].legend(fontsize=8)
    fig.suptitle(
        "Saved supervised runs · validation-only selection; IoU curve is not the common-0.50 score",
        fontsize=12,
    )
    fig.tight_layout(rect=(0, 0, 1, 0.95))
    _save(plt, fig, directory / "learning_curves.png")


def _examples(plt, directory, protocol):
    import pyarrow.parquet as pq
    from matplotlib.colors import ListedColormap

    figures = []
    destination = directory / "forecast_examples"
    destination.mkdir(exist_ok=True)
    for pair in protocol.get("forecast_example_pair_ids", []):
        frame = pq.read_table(
            directory / "forecast_predictions.parquet", filters=[("pair_id", "=", pair)]
        ).to_pandas()
        first = frame[frame.model == "unet"].sort_values("cell_id")
        if first.empty:
            continue
        shape = tuple(protocol["grid_shape"])
        current = first.current.to_numpy().reshape(shape)
        target = first.target.to_numpy().reshape(shape)
        probability = first.probability.to_numpy().reshape(shape)
        growth = target & ~current
        pred = (probability >= 0.5) & ~current
        fig, axes = plt.subplots(2, 3, figsize=(13, 8))
        fig.subplots_adjust(top=0.8, right=0.9, wspace=0.2, hspace=0.25)
        physical = (
            frame[frame.model == "existing_physical"]
            .sort_values("cell_id")
            .probability.to_numpy()
            .reshape(shape)
        )
        for ax, value, title in zip(
            axes.ravel()[:5],
            [current, target, physical, probability, np.where(current, 0, probability)],
            [
                "Known observed footprint",
                "Raw later footprint",
                "Physical probability",
                "U-Net cumulative probability",
                "U-Net new-growth probability",
            ],
        ):
            image = ax.imshow(value, origin="lower", cmap="YlOrRd", vmin=0, vmax=1)
            ax.set_title(title, loc="left", fontsize=10)
        errors = np.zeros(shape, int)
        errors[growth & pred] = 1
        errors[growth & ~pred] = 2
        errors[pred & ~growth] = 3
        errors[current] = 4
        axes[1, 2].imshow(
            errors,
            origin="lower",
            vmin=0,
            vmax=4,
            cmap=ListedColormap(["#f5f5f5", "#009e73", "#cc79a7", "#e69f00", "#777777"]),
        )
        axes[1, 2].set_title("Green:correct; pink:missed; orange:false growth", fontsize=9)
        for ax in axes.ravel():
            ax.set_xticks([])
            ax.set_yticks([])
        issue = datetime.fromtimestamp(float(first.issue_s.iloc[0]), timezone.utc).isoformat()
        coverage = first.target_coverage_fraction.iloc[0] if "target_coverage_fraction" in first else np.nan
        fig.suptitle(
            f"Predetermined pair {pair[:16]} · {first.group_id.iloc[0]}\n{issue} · {first.horizon_s.iloc[0] / 3600:.1f}h · {first.cell_size_m.iloc[0]:g}m/cell · target coverage: {coverage:.3f}\nNorth is up. Error masks use 0.50. Outside-grid growth is not scored.",
            x=0.05,
            ha="left",
            fontsize=12,
        )
        colorbar = fig.add_axes([0.93, 0.35, 0.014, 0.3])
        fig.colorbar(image, cax=colorbar, label="Probability / binary mask (0–1)")
        path = destination / f"{pair[:16]}.png"
        _save(plt, fig, path)
        figures.append(path)
    return figures


def _resident(plt, directory, resident):
    summary = resident.get("summary", {}) if isinstance(resident, dict) else {}
    if not summary:
        _unmeasured(
            plt,
            directory / "resident_risk.png",
            "Fictional resident exposure",
            "Saved resident analysis was not supplied; no real rescue outcomes are inferred",
        )
        return
    fig, axes = plt.subplots(1, 2, figsize=(12, 4))
    for ax, key in zip(axes, ["topk_recall", "resident_brier"]):
        for index, model in enumerate(MODELS):
            value = summary.get(model, {}).get(key + "_macro")
            if value is None:
                continue
            ax.bar(index, value, color=COLORS[model])
            ci = summary[model].get(key + "_ci95")
            if ci:
                ax.errorbar(
                    index,
                    value,
                    yerr=[[max(0, value - ci[0])], [max(0, ci[1] - value)]],
                    fmt="none",
                    color="black",
                    capsize=3,
                )
        ax.set_xticks(range(4), [SHORT_LABELS[m] for m in MODELS])
        ax.set_title(key.replace("_", " "), loc="left")
    fig.suptitle("Fictional placements · incident macro · 2,000 whole-incident intervals")
    _save(plt, fig, directory / "resident_risk.png")


def build_reports(directory):
    directory = Path(directory)
    metrics = _read(directory / "metrics.json")
    if metrics is None:
        raise ValueError("saved evaluation metrics are required; reports never create measurements")
    rows = _read(directory / "pair_metrics.json", [])
    training = _read(directory / "training_runs.json", {})
    protocol = _read(directory / "protocol.json", {})
    plt = _plotting()
    _scorecard(plt, directory, metrics)
    _comparison(plt, directory, rows)
    _calibration(plt, directory, rows)
    _learning(plt, directory, training)
    resident = _read(directory / "resident_outputs.json", {})
    _resident(plt, directory, resident)
    examples = _examples(plt, directory, protocol)
    fig, ax = plt.subplots(figsize=(9, 4))
    runtime = metrics.get("runtime", {}).get("per_model_median_ms", {})
    measured = [m for m in MODELS if runtime.get(m) is not None]
    ax.barh(
        [LABELS[m] for m in measured], [runtime[m] for m in measured], color=[COLORS[m] for m in measured]
    )
    ax.set_xlabel("Median frozen forecast milliseconds")
    _save(plt, fig, directory / "runtime_comparison.png")
    table = _table(metrics)
    lines = [
        f"| {LABELS[m]} | {_number(table[m].get('new_growth_iou_macro'))} | {_number(table[m].get('new_growth_dice_macro'))} | {_number(table[m].get('brier_macro'))} | {_number(table[m].get('average_precision_macro'))} |"
        for m in MODELS
    ]
    growth = _read(directory / "growth_classification_metrics.json", {})
    growth_lines = [
        f"| {LABELS[m]} | {_number(growth.get('summary', {}).get(m, {}).get('average_precision_macro'))} | {_number(growth.get('summary', {}).get(m, {}).get('brier_macro'))} |"
        for m in MODELS
    ]
    budget = _read(directory / "training_budget.json", {})
    cleanup = _read(directory / "cleanup_migration.json", {})
    immutable = _read(directory / "data_immutability_comparison.json", {})
    export = _read(directory / "export_receipt.json", {})
    export_gate = {
        key: value
        for key, value in export.items()
        if key
        in (
            "model_family",
            "validation_passed",
            "inference_checked",
            "calibration_passed",
            "calibration_gate",
            "brier_gate",
            "native_reload_passed",
            "fallback_reasons",
            "active_backend",
            "gate",
            "gates",
            "deployment",
            "validation_gate",
            "brier_passed",
            "brier_noninferiority_passed",
            "calibration_gate_passed",
            "quality_gate_passed",
            "validation_quality_passed",
            "inference_timing_passed",
            "app_settings_changed",
            "activation_scope",
        )
    }
    if export and not export_gate:
        export_gate = {
            "receipt_available": True,
            "fields": list(export),
            "interpretation": "inspect export_receipt.json; no unrecorded pass is inferred",
        }
    if not export:
        export_gate = {"status": "not supplied; deployment/calibration gate not measured by report renderer"}
    threshold_text = (
        (directory / "threshold_comparison.md").read_text()
        if (directory / "threshold_comparison.md").exists()
        else "Persisted threshold comparison was not supplied. Primary 0.5 and the validation-selected secondary threshold remain distinct."
    )
    budget_text = (
        f"The supervised campaign consumed {budget.get('supervised_seconds'):.3f} s. Prior consumed compute: {budget.get('prior_consumed_seconds'):.3f} s. Combined: {budget.get('combined_seconds'):.3f} s ({budget.get('combined_seconds') / 60:.2f} min) of the {budget.get('cap_seconds'):.0f} s ({budget.get('cap_seconds') / 60:.0f} min) authorized cap. Cap respected: {budget.get('cap_respected')}. Training finished: {budget.get('training_finished')}; new training planned: {budget.get('new_training_planned')}."
        if all(
            isinstance(budget.get(k), (int, float))
            for k in ("supervised_seconds", "prior_consumed_seconds", "combined_seconds", "cap_seconds")
        )
        else "Combined training budget receipt not supplied; no cap-compliance claim is inferred."
    )
    campaign_lines = [
        f"| {r.get('seed')} | {r.get('epochs')} | {r.get('best_epoch')} | {r.get('updates')} | {_number(r.get('seconds'), 2)} | {r.get('complete')} |"
        for r in budget.get("seeds", [])
    ]
    cleanup_count = (
        len(cleanup["removed_owned_paths"])
        if cleanup.get("removed_owned_paths") is not None
        else "not supplied"
    )
    preservation = (
        "Original archives, normalized historical observations, frozen grouping/split and shared live application were preserved."
        if immutable.get("status") == "passed"
        else "Historical-data preservation was not verified by a supplied successful receipt."
    )
    integration = _read(directory / "integration_demo.json", {})
    serving = _read(directory / "serving_smoke.json", {})
    verification = _read(directory / "verification.json", {})
    integration_summary = (
        {
            key: integration.get(key)
            for key in (
                "status",
                "server",
                "synthetic_requests",
                "initial_queue_entries",
                "queue_after_wind_change",
                "completed_handoffs",
                "handoff_reason",
                "consent_expiry_timer",
                "full_uagents_asi1_frontend",
            )
        }
        if integration
        else {"status": "not supplied"}
    )
    if integration:
        integration_summary["check_records"] = len(integration.get("checks", []))
    serving_summary = (
        {
            key: serving.get(key)
            for key in (
                "active",
                "reason",
                "elapsed_s",
                "optimizer_updates",
                "output_shape",
                "checkpoint_unchanged",
                "default",
                "missing_history",
            )
        }
        if serving
        else {"status": "not supplied"}
    )
    focused = (directory / "frozen_operating_point/metrics.md").exists()
    focused_link = (
        "**Current frozen operating point: 0.05 selected (seed 202, epoch 4); 0.50 is diagnostic.** "
        "[Open the focused operating-point report](frozen_operating_point/index.html). "
        "The tables below retain the original common-0.50 comparison and its original positive-growth population; metrics.json is unchanged."
        if focused
        else "The selected native threshold is reported separately from the original common-0.50 comparison below."
    )
    text = f"""# Supervised wildfire forecast benchmark

{focused_link}

Model family: time-conditioned U-Net. Split: {metrics["evaluation_split"]}; {metrics["evaluation_incident_groups"]} incident groups / {metrics["evaluation_forecast_pairs"]} observed pairs. **{metrics["test_set_status"]}**. Model selection uses validation only. Reused test results are diagnostic, not pristine unseen evidence.

| Method | New-growth IoU | New-growth Dice | Full-footprint Brier | Full-footprint AP |
|---|---:|---:|---:|---:|
{chr(10).join(lines)}

The original common-protocol growth metric uses the SAME actual-growth-positive pairs for every method, averages pairs within incident, then averages incidents. Empty growth never earns perfect credit. The focused operating-point report separately names its all-defined and original conditional growth populations. Raw perimeter regressions remain in full-footprint metrics. Probability-score AUC/AP are undefined for one-class slices. 2,000 whole-incident paired bootstrap intervals are in confidence_intervals.json; pixels are not independent fires.

The original comparison uses 0.50 for every method. The frozen validation-selected threshold is {_number(metrics.get("validation_selected_threshold"), 3)}; its separately saved conditional growth IoU is {_number(metrics.get("secondary_validation_threshold", {}).get("new_growth_iou_macro"))}. Both views reuse exactly the same frozen probabilities. The current focused readout emphasizes 0.05 and retains 0.50 as a diagnostic without rewriting the original comparison.

## Growth probability diagnostic

Full-footprint AP includes already known affected cells and does not establish new-spread skill. The following secondary analysis excludes the starting footprint; it does not change model selection or the primary score.

| Method | Growth-only AP | Growth-only Brier |
|---|---:|---:|
{chr(10).join(growth_lines)}

## Precision, recall and F1 at both saved thresholds

{threshold_text}

## Learning, outputs and use

Historical observed masks and elapsed acquisition times create input/target pairs. Train-only normalization and a U-Net with architecture {training.get("architecture")} predict new-growth probabilities while preserving the observed footprint. A later raw observation supplies supervised segmentation loss. Weighted-BCE logits receive a train-prior correction before probabilities are exposed. The Dice auxiliary and finite training make that correction approximate; calibration is measured empirically, not asserted. Calibration metadata: {training.get("calibration")}. The model does not assign rescue resources: danger/slack remains separate and Lookahead dispatch remains unchanged. Simulation stays the default until explicit compatibility/quality activation succeeds. There is no live learning or operational safety assurance.

Actual completed epochs: {training.get("epochs_completed")}; optimizer updates: {training.get("actual_updates")}; processed historical pairs: {training.get("actual_processed_pairs")}; training seconds: {training.get("elapsed_seconds")}. Checkpoint: {training.get("checkpoint_sha256")}. Frozen normalization, configuration and dependency versions are in training_runs.json. No training or inference occurs when rebuilding reports.

The preceding epoch/update/time values describe the selected seed, not the entire campaign. Across all supervised seeds there were {training.get("all_supervised_updates")} updates and {training.get("all_supervised_pair_exposures")} historical-pair exposures (repeated training exposures, not independent observations).

## Actual compute budget and cleanup

{budget_text}

| Seed | Completed epochs | Selected epoch | Updates | Elapsed seconds | Complete |
|---|---:|---:|---:|---:|---|
{chr(10).join(campaign_lines) if campaign_lines else "Per-seed campaign receipt not supplied."}

The cleanup receipt records {cleanup_count} retired owned paths. The current forecaster is exclusively supervised. {preservation} Data-immutability audit status: {immutable.get("status", "not supplied")}; files before/after: {immutable.get("before_file_count")} / {immutable.get("after_file_count")}; NPZ arrays: {immutable.get("npz_files")}; cleaned GeoParquet files: {immutable.get("clean_geoparquet_files")}. Exact hashes and changed/added/removed-file lists remain in data_immutability_comparison.json; no data-preservation claim is inferred when the receipt is absent.

## Native export and empirical calibration gate

```json
{json.dumps(export_gate, indent=2)}
```

This status is read from the saved export receipt, not inferred from training completion, ordinary pixel accuracy or a successful file save. The analytic class-prior correction remains approximate with Dice; empirical Brier/ECE and the recorded gate determine whether measured calibration requirements passed. Simulation remains the default and activation requires explicit compatible configuration. No model prediction certifies resident safety.

## Executed integration and verification evidence

```json
{json.dumps({"isolated_loopback_database": integration_summary, "exported_backend_smoke": serving_summary, "verification": verification or {"status": "not supplied"}}, indent=2)}
```

The database exercise used synthetic requests in isolated local state. It is not evidence of a production emergency deployment or a fully launched agent/frontend stack. The receipts distinguish exercised checks from source-only inspection, including the consent timer and unavailable station handoff execution. The serving smoke loaded the exported artifact with compatible validation history, checked unchanged checkpoint bytes, and exercised visible fallbacks; it did not train the model.

## Limits and traceability

Missing historical weather/fuel, irregular/reconstructed acquisitions, unknown information release, raw perimeter revisions and fixed initial-domain clipping limit interpretation. Daily/irregular labels do not validate minute-level arrival times. Coverage: {metrics.get("coverage")}. Source archive: {metrics.get("archive_sha256")}; split manifest: {metrics.get("split_manifest_sha256")}. The frozen 303-pair/105-group test panel was previously inspected and remains disclosed as reused; no thresholds/loss weights are selected against it.

Fictional resident metrics, when supplied, use the same placements across forecasts and bootstrap whole incidents. Exposure probability is separate from assistance needs, arrival intervals and feasible rescue slack. Unknown routes/arrival windows require review, never a claim that someone is safe or unreachable. Historical fire labels do not validate real rescues. The application is simulated and does not replace 911.

Boundary diagnostics under diagnostics/ use saved validation outputs only, fixed meter bands outside the initial mask, and explicit zero-denominator handling. Raster-center distances have spatial resolution uncertainty; narrow bands can be empty. No model or loss change follows inspection of the reused test panel.

Rebuild: `PYTHONPATH=agents python -m rescue.forecast_ml.reports --report-dir {directory}`.
"""
    (directory / "BENCHMARK_REPORT.md").write_text(text)
    (directory / "model_card.md").write_text(
        f"# Time-conditioned U-Net model card\n\n{training.get('feature_schema')} · checkpoint {training.get('checkpoint_sha256')}\n\n"
        + text
    )
    paths = [
        directory / name
        for name in (
            "scorecard.png",
            "dataset_audit.png",
            "growth_comparison.png",
            "calibration.png",
            "learning_curves.png",
            "per_incident_scatter.png",
            "resident_risk.png",
            "runtime_comparison.png",
        )
    ]
    paths = [p for p in paths if p.exists()] + examples + sorted((directory / "diagnostics").glob("*.png"))
    focused_paths = [
        path
        for path in (
            directory / "frozen_operating_point/airplane_lake_2023_saved_observation_windows.png",
            directory / "frozen_operating_point/airplane_lake_2023_growth_areas.png",
        )
        if path.exists()
    ]
    focused_paths += sorted((directory / "frozen_operating_point/maps").glob("*.png")) + sorted(
        (directory / "frozen_operating_point").glob("reliability*.png")
    )
    paths = focused_paths + paths
    images = "".join(
        f'<section><h2>{html.escape(p.stem.replace("_", " "))}</h2><img alt="{html.escape(p.stem)}" src="data:image/png;base64,{base64.b64encode(p.read_bytes()).decode()}"></section>'
        for p in paths
    )
    focused_nav = (
        '<section><h2>0.05 FROZEN SELECTED · 0.50 DIAGNOSTIC</h2><p>Seed 202, epoch 4. All 105 groups / 303 pairs are reused diagnostic evidence.</p><a href="frozen_operating_point/index.html">Open focused operating-point metrics, intervals, reliability and maps</a><p>The original common-0.50 comparison remains below and in unchanged metrics.json.</p></section>'
        if focused
        else ""
    )
    document = f'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Supervised wildfire forecasts</title><style>body{{font:16px/1.6 system-ui;background:#f2f5f7;color:#172b3a;max-width:1200px;margin:auto;padding:32px}}section{{background:white;padding:24px;margin:24px 0}}img{{width:100%}}pre{{white-space:pre-wrap;word-break:break-word}}</style><h1>Supervised wildfire forecasting</h1><p>{html.escape(metrics["test_set_status"])}</p>{focused_nav}{images}<section><pre>{html.escape(text)}</pre></section></html>'
    (directory / "index.html").write_text(document)
    return {"report": str(directory / "index.html"), "figures": [str(p) for p in paths]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-dir", required=True)
    args = parser.parse_args()
    print(json.dumps(build_reports(args.report_dir), indent=2))


if __name__ == "__main__":
    main()
