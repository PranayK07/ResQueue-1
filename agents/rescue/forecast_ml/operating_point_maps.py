"""Frozen operating-point maps from persisted probabilities, never inference.

Each figure shares the full geographic grid across both thresholds and five
columns. The outlined front region uses only the ISSUE starting footprint.
Predetermined examples are retained even when their observed growth is empty.
"""

from __future__ import annotations

import argparse
import base64
from collections import defaultdict
from datetime import datetime, timezone
import html
import json
from pathlib import Path

import numpy as np

from .provenance import atomic_json, sha256
from .reports import COLORS, LABELS, MODELS, _plotting, _save


def growth_masks(current, target, probability, valid, threshold):
    """Return observed/predicted/false/missed growth on identical known cells."""
    current, target, valid = np.asarray(current, bool), np.asarray(target, bool), np.asarray(valid, bool)
    p = np.asarray(probability, float)
    if current.shape != target.shape or current.shape != valid.shape or p.shape != current.shape:
        raise ValueError("growth maps require identical geographic shapes")
    if not 0 < threshold < 1 or not np.isfinite(p[valid]).all() or np.any((p[valid] < 0) | (p[valid] > 1)):
        raise ValueError("known probability maps and a valid frozen threshold required")
    observed = target & ~current & valid
    predicted = (p >= threshold) & ~current & valid
    return {
        "current": current & valid,
        "observed": observed,
        "predicted": predicted,
        "false_positive": predicted & ~observed,
        "missed": observed & ~predicted,
    }


def issue_front(current, valid, cell_size_m):
    """Use the exact shared issue-front definition from the metrics protocol."""
    from .frozen_operating_point import front_mask

    return front_mask(current, valid, cell_size_m)


def supplemental_target_example(rows):
    """Post hoc illustration chosen solely by observed size, never prediction quality."""
    eligible = sorted(
        (r for r in rows if r.get("model") == "unet" and r.get("actual_growth_cells", 0) > 0),
        key=lambda r: (r["actual_growth_cells"], r["pair_id"]),
    )
    if not eligible:
        return None
    row = eligible[len(eligible) // 2]
    return {
        "pair_id": row["pair_id"],
        "observed_growth_cells": row["actual_growth_cells"],
        "eligible_pairs": len(eligible),
        "selection": "post hoc target-only illustration; upper median after sorting positive observed-growth pairs by (observed growth cell count,pair_id); no prediction quality used",
        "status": "descriptive illustration only; no tuning or changed metrics",
    }


def named_sequence_choice(rows):
    """Target-only post hoc rule for the named three-window illustration."""
    grouped = defaultdict(list)
    for row in rows:
        if row.get("model") == "unet":
            grouped[row["sequence_id"]].append(row)
    eligible = sorted(
        [
            (sum(r["actual_growth_cells"] for r in records), sequence)
            for sequence, records in grouped.items()
            if len(records) == 3 and all(r["actual_growth_cells"] >= 10 for r in records)
        ],
        key=lambda value: (value[0], value[1]),
    )
    if not eligible:
        return None
    count, sequence = eligible[len(eligible) // 2]
    return {
        "sequence_id": sequence,
        "observed_growth_cell_sum": count,
        "eligible_sequences": len(eligible),
        "rule": "post hoc target-only illustration: exactly 3 saved pairs of one sequence, each with>=10 observed growth cells; median summed observed growth after sorting(sum,sequence_id); no prediction-quality selection",
    }


def render_named_sequence(report_dir):
    """Render Airplane Lake's three independent forecasts from saved arrays only."""
    import pyarrow.parquet as pq
    from matplotlib.colors import ListedColormap
    from matplotlib.patches import Patch

    report_dir = Path(report_dir)
    directory = report_dir / "frozen_operating_point"
    rows = json.loads((report_dir / "pair_metrics.json").read_text())
    choice = named_sequence_choice(rows)
    sequence = "sequence-be1076568178183e34db923a"
    if not choice or choice["sequence_id"] != sequence:
        raise ValueError("named target-only selection differs from the frozen Airplane Lake choice")
    protocol = json.loads((report_dir / "protocol.json").read_text())
    shape = tuple(protocol["grid_shape"])
    source = report_dir / "forecast_predictions.parquet"
    source_hash = sha256(source)
    frame = pq.read_table(
        source, filters=[("sequence_id", "=", sequence), ("model", "=", "unet")]
    ).to_pandas()
    windows = []
    for pair, part in frame.groupby("pair_id"):
        part = part.sort_values("cell_id")
        if len(part) != int(np.prod(shape)) or not np.array_equal(part.cell_id, np.arange(len(part))):
            raise ValueError("named sequence grid is incomplete")
        current = part.current.to_numpy().reshape(shape)
        target = part.target.to_numpy().reshape(shape)
        valid = part.valid.to_numpy().reshape(shape)
        probability = part.probability.to_numpy().reshape(shape)
        masks = growth_masks(current, target, probability, valid, 0.05)
        scale = float(part.cell_size_m.iloc[0])
        observed = masks["observed"]
        predicted = masks["predicted"]
        counts = {
            "actual_current_footprint_cells": int((current & valid).sum()),
            "raw_target_footprint_cells": int((target & valid).sum()),
            "observed_growth_cells": int(observed.sum()),
            "predicted_growth_cells": int(predicted.sum()),
            "tp": int((observed & predicted).sum()),
            "fp": int(masks["false_positive"].sum()),
            "fn": int(masks["missed"].sum()),
            "current_revision_cells": int((current & ~target & valid).sum()),
        }
        info = {
            "pair_id": str(pair),
            "issue_s": float(part.issue_s.iloc[0]),
            "target_s": float(part.target_s.iloc[0]),
            "horizon_s": float(part.horizon_s.iloc[0]),
            "cell_size_m": scale,
            "target_coverage_fraction": float(part.target_coverage_fraction.iloc[0]),
            "target_out_of_domain_area_m2": float(part.target_out_of_domain_area_m2.iloc[0]),
            **counts,
            "observed_growth_km2": counts["observed_growth_cells"] * scale**2 / 1e6,
            "predicted_growth_km2": counts["predicted_growth_cells"] * scale**2 / 1e6,
            "actual_current_affected_footprint_km2": counts["actual_current_footprint_cells"]
            * scale**2
            / 1e6,
            "raw_target_affected_footprint_km2": counts["raw_target_footprint_cells"] * scale**2 / 1e6,
        }
        windows.append({"info": info, "current": current, "target": target, "valid": valid, "masks": masks})
    windows.sort(key=lambda row: row["info"]["issue_s"])
    if len(windows) != 3:
        raise ValueError("exactly three saved observation windows required")
    for prior, later in zip(windows, windows[1:]):
        if prior["info"]["target_s"] != later["info"]["issue_s"] or not np.array_equal(
            prior["target"], later["current"]
        ):
            raise ValueError("named windows do not share consecutive ACTUAL observations")
    scale = windows[0]["info"]["cell_size_m"]
    if any(w["info"]["cell_size_m"] != scale for w in windows):
        raise ValueError("named fire grid resolution changed")
    width, height = shape[1] * scale / 1000, shape[0] * scale / 1000
    extent = (0, width, 0, height)
    x = (np.arange(shape[1]) + 0.5) * scale / 1000
    y = (np.arange(shape[0]) + 0.5) * scale / 1000
    plt = _plotting()
    fig, axes = plt.subplots(3, 4, figsize=(17, 15))
    fig.subplots_adjust(left=0.15, right=0.985, top=0.83, bottom=0.105, wspace=0.13, hspace=0.2)
    titles = [
        "ACTUAL current observation",
        "Current + observed NEW growth",
        "Current + predicted growth at 0.05",
        "New-growth errors at 0.05",
    ]
    for index, window in enumerate(windows):
        current, target, valid, masks = window["current"], window["target"], window["valid"], window["masks"]
        observed, predicted = masks["observed"], masks["predicted"]
        info = window["info"]
        actual_image = np.where(current, 1, 0)
        actual_image[observed] = 2
        predicted_image = np.where(current, 1, 0)
        predicted_image[predicted] = 2
        errors = np.where(current, 1, 0)
        errors[observed & predicted] = 2
        errors[masks["false_positive"]] = 3
        errors[masks["missed"]] = 4
        images = [
            (current.astype(int), ["#fafafa", "#666666"]),
            (actual_image, ["#fafafa", "#666666", "#bb3333"]),
            (predicted_image, ["#fafafa", "#666666", "#0072b2"]),
            (errors, ["#fafafa", "#666666", "#009e73", "#e69f00", "#cc79a7"]),
        ]
        annotations = [
            f"ACTUAL observed input\n{int(current.sum()):,} affected cells",
            f"Observed NEW growth:  {info['observed_growth_cells']} cells\n{info['observed_growth_km2']:.4f} km²; revised current: {info['current_revision_cells']}\nRaw target: {info['raw_target_footprint_cells']} cells ({info['raw_target_affected_footprint_km2']:.4f} km²)",
            f"Predicted NEW growth: {info['predicted_growth_cells']} cells\n{info['predicted_growth_km2']:.4f} km²",
            f"TP={info['tp']} · FP={info['fp']} · FN={info['fn']}",
        ]
        for col, ((image, colors), annotation) in enumerate(zip(images, annotations)):
            ax = axes[index, col]
            cmap = ListedColormap(colors)
            cmap.set_bad("#bdbdbd")
            ax.imshow(
                np.where(valid, image, np.nan),
                origin="lower",
                extent=extent,
                cmap=cmap,
                vmin=0,
                vmax=len(colors) - 1,
            )
            if col == 1 and target.any() and not target.all():
                ax.contour(x, y, target, levels=[0.5], colors=["#222222"], linewidths=0.6, linestyles="--")
            if index == 0:
                ax.set_title(titles[col], loc="left", fontsize=11)
            ax.text(
                0.015,
                0.985,
                annotation,
                transform=ax.transAxes,
                va="top",
                fontsize=8,
                bbox={"facecolor": "white", "alpha": 0.9, "edgecolor": "none"},
            )
            ax.tick_params(labelsize=8)
            if col == 0:
                start = datetime.fromtimestamp(info["issue_s"], timezone.utc).strftime("%b%d %H:%M UTC")
                end = datetime.fromtimestamp(info["target_s"], timezone.utc).strftime("%b%d %H:%M UTC")
                ax.set_ylabel(
                    f"Window {index + 1}\n{start}\n→ {end}\n{info['horizon_s'] / 3600:.3f} h · {scale:g} m/cell\nTarget covered:{100 * info['target_coverage_fraction']:.2f}%\nOutside:{info['target_out_of_domain_area_m2'] / 1e6:.3f} km²\nNorth from fixed origin (km)",
                    fontsize=8,
                )
            else:
                ax.set_yticklabels([])
            if index == 2:
                ax.set_xlabel("East from fixed grid origin (km)", fontsize=9)
    fig.suptitle(
        "AIRPLANE LAKE (2023) · WA-OWF-000374_AirplaneLake\nFrozen U-Net seed 202 / epoch 4 / threshold 0.05 · three independent saved forecasts\nEach row starts from the next ACTUAL observation: predicted masks are NOT fed forward\nPOST HOC TARGET-SIZE-ONLY ILLUSTRATION · reused diagnostic panel: 105 groups / 303 pairs",
        x=0.15,
        ha="left",
        fontsize=14,
        weight="bold",
    )
    fig.legend(
        handles=[
            Patch(facecolor=color, label=label)
            for color, label in [
                ("#666666", "Actual current context"),
                ("#bb3333", "Observed new growth"),
                ("#0072b2", "Predicted growth"),
                ("#009e73", "TP"),
                ("#e69f00", "FP"),
                ("#cc79a7", "FN"),
            ]
        ],
        loc="lower center",
        bbox_to_anchor=(0.57, 0.05),
        ncols=6,
        fontsize=9,
    )
    fig.text(
        0.15,
        0.025,
        "Gray is current-observation context, not a substituted target label. Dashed outline = raw later footprint. Raw revisions remain scored. Same fixed extent in every panel; outside-grid growth is unscored. No recursive generations, new inference, tuning or training.",
        fontsize=9,
    )
    main = directory / "airplane_lake_2023_saved_observation_windows.png"
    _save(plt, fig, main)
    fig, ax = plt.subplots(figsize=(10, 4.5))
    positions = np.arange(3)
    actual = [w["info"]["observed_growth_km2"] for w in windows]
    pred = [w["info"]["predicted_growth_km2"] for w in windows]
    ax.bar(positions - 0.18, actual, width=0.36, color="#bb3333", label="Observed NEW growth")
    ax.bar(positions + 0.18, pred, width=0.36, color="#0072b2", label="Predicted NEW growth at 0.05")
    labels = [
        datetime.fromtimestamp(w["info"]["issue_s"], timezone.utc).strftime("%b%d")
        + " → "
        + datetime.fromtimestamp(w["info"]["target_s"], timezone.utc).strftime("%b%d")
        for w in windows
    ]
    ax.set_xticks(positions, labels)
    ax.set_ylabel("New-growth area within fixed grid (km²)")
    ax.set_title("Airplane Lake 2023 · independent saved observation windows", loc="left")
    ax.legend()
    ax.grid(axis="y", alpha=0.2)
    area = directory / "airplane_lake_2023_growth_areas.png"
    _save(plt, fig, area)
    if sha256(source) != source_hash:
        raise ValueError("saved source changed during named-fire rendering")
    manifest = {
        "fire": "AIRPLANE LAKE 2023",
        "source_incident": "WA-OWF-000374_AirplaneLake",
        "sequence_id": sequence,
        "selection": choice,
        "source_probability_sha256": source_hash,
        "model_seed": 202,
        "epoch": 4,
        "threshold": 0.05,
        "consecutive_actual_observations": True,
        "recursive_prediction": False,
        "inference_or_training_performed": False,
        "test_status": "all 105 groups / 303 pairs reused diagnostic evidence",
        "windows": [w["info"] for w in windows],
        "map": str(main),
        "area_plot": str(area),
    }
    atomic_json(directory / "airplane_lake_2023_windows.json", manifest)
    lines = [
        f"| {index + 1} | {w['info']['observed_growth_cells']} | {w['info']['predicted_growth_cells']} | {w['info']['tp']} / {w['info']['fp']} / {w['info']['fn']} | {w['info']['observed_growth_km2']:.4f} | {w['info']['predicted_growth_km2']:.4f} |"
        for index, w in enumerate(windows)
    ]
    text = f"""# Airplane Lake 2023: saved observation windows

Frozen seed 202, epoch 4, threshold 0.05. Post hoc target-only illustrative choice: among {choice["eligible_sequences"]} sequences with exactly 3 saved pairs and at least 10 observed new-growth cells in each, sort by summed observed growth and sequence ID and choose the median ({choice["observed_growth_cell_sum"]} observed growth cells). Prediction quality played no role in selection. This is descriptive, not a new independent test.

The rows are independent saved forecasts initialized from successive ACTUAL observations on Aug 26–29, 2023. They are not recursive/simulated generations; no predicted perimeter is fed into the next row and no model inference was rerun. The panel has 105 reused groups / 303 pairs. Current gray cells are reference context; the raw target outline/revisions are preserved, not silently unioned into truth.

| Window | Observed growth cells | Predicted growth cells | TP / FP / FN | Observed growth km² | Predicted growth km² |
|---|---:|---:|---:|---:|---:|
{chr(10).join(lines)}

All panels share the same projected grid and 110 m cells. Target geometric coverage/outside area and UTC window durations are recorded in the JSON and map. Original aggregate metrics remain unchanged.
"""
    (directory / "airplane_lake_2023_windows.md").write_text(text)
    return manifest


def render_maps(report_dir):
    """Read existing neural rows only; write three fixed two-threshold figures."""
    import pyarrow.parquet as pq
    from matplotlib.colors import ListedColormap
    from matplotlib.lines import Line2D

    report_dir = Path(report_dir)
    protocol = json.loads((report_dir / "protocol.json").read_text())
    training = json.loads((report_dir / "training_runs.json").read_text())
    if (
        training.get("selected_seed") != 202
        or training.get("selected_epoch") != 4
        or training.get("threshold") != 0.05
    ):
        raise ValueError("operating-point maps require the frozen seed 202 epoch 4 threshold 0.05 receipt")
    shape = tuple(protocol["grid_shape"])
    pairs = protocol.get("forecast_example_pair_ids", [])
    supplemental = supplemental_target_example(json.loads((report_dir / "pair_metrics.json").read_text()))
    if supplemental and supplemental["pair_id"] not in pairs:
        pairs = [*pairs, supplemental["pair_id"]]
    destination = report_dir / "frozen_operating_point/maps"
    destination.mkdir(parents=True, exist_ok=True)
    source = report_dir / "forecast_predictions.parquet"
    source_hash = sha256(source)
    plt = _plotting()
    outputs = []
    for pair in pairs:
        frame = (
            pq.read_table(source, filters=[("pair_id", "=", pair), ("model", "=", "unet")])
            .to_pandas()
            .sort_values("cell_id")
        )
        if len(frame) != int(np.prod(shape)) or not np.array_equal(frame.cell_id, np.arange(len(frame))):
            raise ValueError("complete unique saved neural grid required")
        current = frame.current.to_numpy().reshape(shape)
        target = frame.target.to_numpy().reshape(shape)
        valid = frame.valid.to_numpy().reshape(shape)
        p = frame.probability.to_numpy().reshape(shape)
        scale = float(frame.cell_size_m.iloc[0])
        front = issue_front(current, valid, scale)
        width, height = shape[1] * scale / 1000, shape[0] * scale / 1000
        extent = (0, width, 0, height)
        x = (np.arange(shape[1]) + 0.5) * scale / 1000
        y = (np.arange(shape[0]) + 0.5) * scale / 1000
        fig, axes = plt.subplots(2, 5, figsize=(18, 9))
        fig.subplots_adjust(left=0.055, right=0.985, top=0.76, bottom=0.14, wspace=0.14, hspace=0.25)
        columns = [
            ("current", "Current observed footprint", "#333333"),
            ("observed", "Observed future growth", "#bb3333"),
            ("predicted", "Predicted new growth", "#0072b2"),
            ("false_positive", "False-positive growth", "#e69f00"),
            ("missed", "Missed growth", "#cc79a7"),
        ]
        for row, threshold in enumerate((0.05, 0.50)):
            masks = growth_masks(current, target, p, valid, threshold)
            for col, (key, title, color) in enumerate(columns):
                ax = axes[row, col]
                cmap = ListedColormap(["#fafafa", color])
                cmap.set_bad("#bdbdbd")
                ax.imshow(
                    np.where(valid, masks[key].astype(float), np.nan),
                    origin="lower",
                    extent=extent,
                    cmap=cmap,
                    vmin=0,
                    vmax=1,
                )
                if front.any() and not front.all():
                    ax.contour(x, y, front, levels=[0.5], colors=["#00b8c7"], linewidths=0.65)
                if row == 0:
                    ax.set_title(title, loc="left", fontsize=11)
                count = int(masks[key].sum())
                ax.text(
                    0.02,
                    0.98,
                    f"{count:,} cells · {count * scale * scale / 1e6:.3g} km²",
                    transform=ax.transAxes,
                    va="top",
                    fontsize=8,
                    bbox={"facecolor": "white", "alpha": 0.85, "edgecolor": "none"},
                )
                ax.tick_params(labelsize=7)
                if col == 0:
                    ax.set_ylabel(
                        f"{threshold:.2f} {'FROZEN SELECTED' if row == 0 else 'DIAGNOSTIC'}\nNorth from origin (km)",
                        fontsize=9,
                    )
                else:
                    ax.set_yticklabels([])
                if row == 1:
                    ax.set_xlabel("East from origin (km)", fontsize=8)
        issue = datetime.fromtimestamp(float(frame.issue_s.iloc[0]), timezone.utc).isoformat()
        target_time = datetime.fromtimestamp(float(frame.target_s.iloc[0]), timezone.utc).isoformat()
        coverage = (
            float(frame.target_coverage_fraction.iloc[0]) if "target_coverage_fraction" in frame else np.nan
        )
        coverage_text = f"{100 * coverage:.2f}%" if np.isfinite(coverage) else "unknown"
        is_supplement = supplemental is not None and pair == supplemental["pair_id"]
        role = "POST HOC TARGET-ONLY MEDIAN · DESCRIPTIVE" if is_supplement else "PREDECLARED EXAMPLE"
        fig.suptitle(
            f"Frozen U-Net seed 202 · epoch 4 · 0.05 selected / 0.50 diagnostic\nREUSED diagnostic panel: 105 groups, 303 pairs · {role} {pair[:16]}\n{issue} → {target_time} · {float(frame.horizon_s.iloc[0]) / 3600:.1f} h · {scale:g} m/cell · target geometric coverage: {coverage_text}",
            x=0.055,
            ha="left",
            fontsize=13,
            weight="bold",
        )
        fig.legend(
            handles=[
                Line2D(
                    [0],
                    [0],
                    color="#00b8c7",
                    label="Issue-front subset: valid unburned cells within 1 km of current observed footprint (raster-center distance)",
                )
            ],
            loc="lower center",
            bbox_to_anchor=(0.5, 0.065),
            fontsize=10,
        )
        fig.text(
            0.055,
            0.025,
            "Both rows reuse the SAME saved probabilities and full grid. Known footprint excluded from all growth columns. Gray = invalid/unknown. No new inference or training. Outside-grid target growth is not shown.",
            fontsize=9,
        )
        prefix = "posthoc_target_median_growth" if is_supplement else "growth_005_selected_050_diagnostic"
        path = destination / f"{prefix}_{pair[:16]}.png"
        _save(plt, fig, path)
        outputs.append(
            {"pair_id": pair, "path": str(path), "front_cells": int(front.sum()), "cell_size_m": scale}
        )
    if sha256(source) != source_hash:
        raise ValueError("saved probability source changed while rendering maps")
    manifest = {
        "source_probability_sha256": source_hash,
        "model_seed": 202,
        "selected_epoch": 4,
        "selected_threshold": 0.05,
        "diagnostic_threshold": 0.5,
        "test_status": "all 105 groups / 303 pairs reused; no untouched groups claimed",
        "front_definition": "valid & ~current & EDT(~(current&valid),sampling=mpp)<=1000m; empty if no current footprint",
        "case_selection": "three existing predeclared lexical IDs preserved; supplemental target-only case described separately",
        "maps": outputs,
        "supplemental_example": supplemental,
    }
    atomic_json(report_dir / "frozen_operating_point/maps_manifest.json", manifest)
    return manifest


def render_reliability(report_dir):
    """Plot pooled saved bins; legend uncertainty is the incident-macro ECE."""
    report_dir = Path(report_dir)
    directory = report_dir / "frozen_operating_point"
    path = directory / "metrics.json"
    if not path.exists():
        raise ValueError("saved frozen operating-point metrics are required")
    data = json.loads(path.read_text())
    domains = data["thresholds"]["0.05"]["domains"]
    plt = _plotting()
    fig, axes = plt.subplots(1, 2, figsize=(14, 6))
    for ax, key, title in zip(
        axes,
        ["growth", "front_1000m"],
        ["Full growth domain: known footprint excluded", "1 km issue-front subset: valid unburned cells"],
    ):
        region = domains[key]
        for model in MODELS:
            score = region["models"][model]
            bins = [b for b in score["pooled"]["calibration_bins"] if b["count"]]
            if not bins:
                continue
            ece = score["macro"]["calibration_ece"]
            value = ece.get("estimate")
            ci = ece.get("ci95")
            label = (
                f"{LABELS[model]} · macro ECE {value:.4f}"
                if value is not None
                else f"{LABELS[model]} · ECE undefined"
            )
            if ci:
                label += f" [{ci[0]:.4f},{ci[1]:.4f}]"
            x = [b["mean_probability"] for b in bins]
            y = [b["observed_fraction"] for b in bins]
            ax.plot(x, y, "-", color=COLORS[model], label=label)
            counts = np.asarray([b["count"] for b in bins], float)
            ax.scatter(x, y, s=18 + 85 * np.sqrt(counts / counts.max()), color=COLORS[model], alpha=0.8)
        ax.plot([0, 1], [0, 1], "--", color="gray", linewidth=1)
        ax.set(
            xlim=(-0.02, 1.02),
            ylim=(-0.02, 1.02),
            xlabel="Mean predicted affected-area probability",
            ylabel="Observed affected fraction",
        )
        ax.set_title(title, loc="left", fontsize=12)
        ax.grid(alpha=0.15)
        ax.legend(fontsize=7, loc="upper left")
        unet_bins = region["models"]["unet"]["pooled"]["calibration_bins"]
        n = sum(b["count"] for b in unet_bins)
        ax.text(
            0.01,
            -0.18,
            f"N = {n:,} repeated cell forecasts; U-Net bin counts:\n"
            + ", ".join(f"{b['count']:,}" for b in unet_bins),
            transform=ax.transAxes,
            fontsize=8,
        )
    fig.suptitle(
        "0.05 FROZEN SELECTED · 0.50 DIAGNOSTIC shares the SAME probabilities", fontsize=14, weight="bold"
    )
    fig.text(
        0.06,
        0.015,
        "Lines pool saved cell forecasts; legend ECE/95% intervals use 2,000 whole-incident bootstrap draws. Marker sizes reflect bin count. Known affected cells are excluded. No fitting, inference or training.",
        fontsize=9,
    )
    fig.subplots_adjust(top=0.86, bottom=0.28, wspace=0.24)
    destination = directory / "reliability_growth_front.png"
    _save(plt, fig, destination)
    return str(destination)


def render_focused_html(report_dir):
    """Embed operating-point markdown and figures without computing metrics."""
    report_dir = Path(report_dir)
    directory = report_dir / "frozen_operating_point"
    narrative = (
        (directory / "metrics.md").read_text()
        if (directory / "metrics.md").exists()
        else "Focused metrics are not supplied yet. No performance is inferred from these maps."
    )
    named = [
        p
        for p in (
            directory / "airplane_lake_2023_saved_observation_windows.png",
            directory / "airplane_lake_2023_growth_areas.png",
        )
        if p.exists()
    ]
    pictures = named + sorted((directory / "maps").glob("*.png")) + sorted(directory.glob("reliability*.png"))
    named_text = (
        (directory / "airplane_lake_2023_windows.md").read_text()
        if (directory / "airplane_lake_2023_windows.md").exists()
        else ""
    )
    embeds = "".join(
        f'<section><h2>{html.escape(p.stem)}</h2><img alt="{html.escape(p.stem)}" src="data:image/png;base64,{base64.b64encode(p.read_bytes()).decode()}"></section>'
        for p in pictures
    )
    page = f'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Frozen 0.05 operating point</title><style>body{{font:16px/1.6 system-ui;max-width:1500px;margin:auto;padding:32px;color:#172b3a;background:#f2f5f7}}section{{background:white;margin:24px 0;padding:24px}}img{{width:100%}}pre{{white-space:pre-wrap;word-break:break-word}}</style><h1>0.05 FROZEN SELECTED · 0.50 DIAGNOSTIC</h1><p>Seed 202,epoch 4. All 105 incident groups and 303 forecast pairs are reused diagnostic evidence. No untouched groups, new inference or training are claimed. Post hoc illustrations are explicitly target-size-only, never chosen for prediction quality.</p><section><pre>{html.escape(named_text)}</pre></section>{embeds}<section><pre>{html.escape(narrative)}</pre></section></html>'
    (directory / "index.html").write_text(page)
    return {"report": str(directory / "index.html"), "figures": len(pictures)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-dir", required=True)
    args = parser.parse_args()
    print(json.dumps(render_maps(args.report_dir), indent=2))
    print(json.dumps(render_named_sequence(args.report_dir), indent=2))
    print(json.dumps({"reliability": render_reliability(args.report_dir)}))
    print(json.dumps(render_focused_html(args.report_dir)))


if __name__ == "__main__":
    main()
