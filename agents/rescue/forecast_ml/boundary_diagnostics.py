"""Validation-only boundary-distance diagnostics from saved predictions.

Distances are projected meters between raster cell centers, using fixed bands
outside the known starting footprint. This secondary debugging analysis never
loads weights, runs inference, fits parameters, or modifies primary metrics.
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

from .growth_diagnostics import aggregate_growth_classification, growth_classification
from .provenance import atomic_json, sha256
from .reports import COLORS, LABELS, MODELS, SHORT_LABELS, _number, _plotting, _save

BANDS = (
    ("0–300m", 0.0, 300.0),
    ("300–1000m", 300.0, 1000.0),
    ("1000–3000m", 1000.0, 3000.0),
    (">3000m", 3000.0, None),
)
AREA_KEYS = (
    "actual_growth_area_m2",
    "predicted_growth_area_m2",
    "false_positive_growth_area_m2",
    "false_negative_growth_area_m2",
    "fp_to_target_growth_area_ratio",
    "predicted_to_target_growth_area_ratio",
)


def boundary_bands(current, valid, cell_size_m):
    """Disjoint right-closed meter bands; absent starting fire gives unknown distance.

    EDT measures center-to-nearest-affected-center distance. It is not exact
    polygon-boundary distance; uncertainty is of order a raster cell. A coarse
    grid can have no cells in a narrow band, which remains an empty slice.
    """
    current, valid = np.asarray(current, bool), np.asarray(valid, bool)
    if current.ndim != 2 or current.shape != valid.shape or not np.isfinite(cell_size_m) or cell_size_m <= 0:
        raise ValueError("matching2D masks and positive projected meters per cell required")
    eligible = valid & ~current
    observed = current & valid
    distance = (
        distance_transform_edt(~observed, sampling=(cell_size_m, cell_size_m))
        if observed.any()
        else np.full(current.shape, np.nan)
    )
    masks = {
        name: eligible
        & np.isfinite(distance)
        & (distance > low)
        & (True if high is None else distance <= high)
        for name, low, high in BANDS
    }
    return (
        masks,
        distance,
        {
            "eligible_outside_cells": int(eligible.sum()),
            "unknown_boundary_distance_cells": int((eligible & ~np.isfinite(distance)).sum()),
        },
    )


def growth_areas(current, target, probability, domain, cell_size_m):
    """Areas/ratios in a declared domain; no target growth gives null ratios."""
    domain = np.asarray(domain, bool) & ~np.asarray(current, bool) & np.isfinite(probability)
    actual = np.asarray(target, bool) & domain
    predicted = (np.asarray(probability) >= 0.5) & domain
    cell_area = float(cell_size_m) ** 2
    actual_area = int(actual.sum()) * cell_area
    predicted_area = int(predicted.sum()) * cell_area
    false_positive = int((predicted & ~actual).sum()) * cell_area
    return {
        "domain_cells": int(domain.sum()),
        "empty_domain": not domain.any(),
        "actual_growth_area_m2": actual_area,
        "predicted_growth_area_m2": predicted_area,
        "false_positive_growth_area_m2": false_positive,
        "false_negative_growth_area_m2": int((actual & ~predicted).sum()) * cell_area,
        "fp_to_target_growth_area_ratio": false_positive / actual_area if actual_area else None,
        "predicted_to_target_growth_area_ratio": predicted_area / actual_area if actual_area else None,
        "no_actual_growth": actual_area == 0,
        "no_actual_growth_with_false_positive": actual_area == 0 and false_positive > 0,
    }


def area_summary(rows):
    groups = defaultdict(list)
    for row in rows:
        groups[(row["model"], row["group_id"])].append(row)
    incidents = []
    for (model, group), records in sorted(groups.items()):
        incident = {"model": model, "group_id": group}
        for key in AREA_KEYS:
            values = [r[key] for r in records if r.get(key) is not None]
            incident[key] = float(np.mean(values)) if values else None
        incidents.append(incident)
    summary = {}
    for model in sorted({r["model"] for r in rows}):
        records = [r for r in rows if r["model"] == model]
        summary[model] = {
            "pairs": len(records),
            "no_actual_growth_pairs": sum(r["no_actual_growth"] for r in records),
            "no_actual_growth_with_false_positive_pairs": sum(
                r["no_actual_growth_with_false_positive"] for r in records
            ),
            "empty_domain_pairs": sum(r.get("empty_domain", False) for r in records),
        }
        for key in AREA_KEYS:
            values = [r[key] for r in incidents if r["model"] == model and r[key] is not None]
            summary[model][key + "_macro"] = float(np.mean(values)) if values else None
            summary[model][key + "_median"] = float(np.median(values)) if values else None
            summary[model][key + "_defined_groups"] = len(values)
        numerator = sum(r["false_positive_growth_area_m2"] for r in records)
        denominator = sum(r["actual_growth_area_m2"] for r in records)
        predicted = sum(r["predicted_growth_area_m2"] for r in records)
        summary[model]["pooled_fp_to_target_growth_area_ratio"] = (
            numerator / denominator if denominator else None
        )
        summary[model]["pooled_predicted_to_target_growth_area_ratio"] = (
            predicted / denominator if denominator else None
        )
        summary[model]["pooled_physical_area_growth_precision"] = (
            (predicted - numerator) / predicted if predicted else None
        )
        summary[model]["pooled_physical_area_growth_recall"] = (
            (predicted - numerator) / denominator if denominator else None
        )
        summary[model]["positive_growth_pairs"] = sum(r["actual_growth_area_m2"] > 0 for r in records)
        for key in ("fp_to_target_growth_area_ratio", "predicted_to_target_growth_area_ratio"):
            values = [r[key] for r in records if r[key] is not None]
            summary[model]["pairwise_" + key + "_median"] = float(np.median(values)) if values else None
        summary[model]["median_definition"] = (
            "existing *_median fields are medians of incident means of pair ratios; pairwise_*_median fields are medians across positive-growth forecast pairs"
        )
    return {"summary": summary, "per_incident": incidents}


def add_denominator_details(rows, by_band):
    """Disclose metric-defined populations, especially one-class AP omissions."""
    for name, _, _ in BANDS:
        for model, summary in by_band[name]["summary"].items():
            selected = [r for r in rows if r["band"] == name and r["model"] == model]
            for key in ("average_precision", "roc_auc", "precision", "recall", "prevalence", "brier"):
                summary[key + "_defined_pairs"] = sum(r.get(key) is not None for r in selected)
            groups = defaultdict(list)
            for row in selected:
                if row.get("average_precision") is not None:
                    groups[row["group_id"]].append(row["prevalence"])
            values = [float(np.mean(v)) for v in groups.values()]
            summary["prevalence_on_average_precision_defined_pairs_macro"] = (
                float(np.mean(values)) if values else None
            )


def write_boundary_audit(result, destination):
    """Render the narrative from saved metrics, without rescoring predictions."""
    destination = Path(destination)
    areas = result["whole_growth_domain_areas"]
    lines = []
    for model in MODELS:
        row = areas["summary"].get(model, {})
        if row:
            lines.append(
                f"| {LABELS[model]} | {_number(row.get('pooled_predicted_to_target_growth_area_ratio'), 3)} | {_number(row.get('pooled_fp_to_target_growth_area_ratio'), 3)} | {_number(row.get('pairwise_predicted_to_target_growth_area_ratio_median'), 3)} | {_number(row.get('predicted_to_target_growth_area_ratio_macro'), 3)} | {row['no_actual_growth_with_false_positive_pairs']} / {row['no_actual_growth_pairs']} |"
            )
    near = result["by_band"][BANDS[0][0]]["summary"].get("unet", {})
    audit = f"""# Validation boundary audit

Saved validation predictions only. No weights were loaded; no inference, training, loss configuration change or threshold tuning occurred. Primary/final-test artifacts are unchanged. Source SHA-256: `{result["source_forecast_predictions_sha256"]}`.

Bands are fixed before scoring: 0–300 m, 300–1000 m, 1000–3000 m, and >3000 m outside the known footprint, inside valid cells. Distances use projected meters and native raster-cell centers. A 400 m pixel can leave the0–300m band empty; this is undefined evidence, not zero error. These are not exact polygon-front distances; spatial uncertainty is of order the meters-per-pixel value.

| Method | Pooled predicted / actual growth | Pooled FP / actual growth | Median PAIR predicted / actual | Mean INCIDENT pair-ratio | No-growth pairs with FP / all no-growth pairs |
|---|---:|---:|---:|---:|---:|
{chr(10).join(lines)}

Pooled ratios divide summed physical areas over all forecast pairs. Pairwise medians use positive-growth pairs. Incident-macro ratios first average eligible pair ratios within incident and then average incidents; tiny positive denominators can greatly inflate these means. Existing *_median JSON fields are medians of INCIDENT MEANS, not medians across pairs; explicit pairwise_*_median fields avoid ambiguity. Zero target growth gives an undefined individual ratio even when false growth is large; these pairs are counted separately.

Near-band U-Net AP: {_number(near.get("average_precision_macro"))} on {near.get("average_precision_defined_groups")} groups/{near.get("average_precision_defined_pairs")} AP-defined pairs. Near-band prevalence: {_number(near.get("prevalence_macro"))} on {near.get("prevalence_defined_groups")} groups. Their different undefined-slice populations prevent directly comparing those two means. AP-defined-population prevalence is {_number(near.get("prevalence_on_average_precision_defined_pairs_macro"))}. All metric-defined pair/group counts are saved. One-class AP/AUC are never assigned invented values.

Confusions, prevalence, precision, recall, Brier, probability-score AP/AUC and 2,000 whole-incident bootstrap intervals are in `boundary_metrics.json`, separately for all four methods and bands. Known initial affected cells are excluded. The examples are the three lowest lexical validation pair IDs: {result["example_pair_ids"]}. Each shows observed new growth, U-Net probability, false/missed growth and predicted-area comparisons on identical domains.

Large false-positive ratios quantify overprediction; they do not prove one root cause. Fixed-domain clipping, irregular raw labels and missing historical weather/fuel still limit interpretation. No new model selection follows this analysis.
"""
    (destination / "boundary_audit.md").write_text(audit)


def _comparison_plot(destination, by_band, areas):
    plt = _plotting()
    fig, axes = plt.subplots(2, 3, figsize=(16, 9))
    labels = [name for name, _, _ in BANDS]
    for ax, key, title in zip(
        axes.ravel()[:5],
        ["brier", "precision", "recall", "average_precision", "roc_auc"],
        [
            "Growth Brier ↓",
            "Growth precision ↑",
            "Growth recall ↑",
            "Growth average precision ↑",
            "Growth ROC-AUC ↑",
        ],
    ):
        for model in MODELS:
            values = [by_band[name]["summary"].get(model, {}).get(key + "_macro") for name in labels]
            if any(v is not None for v in values):
                ax.plot(
                    range(4),
                    [np.nan if v is None else v for v in values],
                    "o-",
                    color=COLORS[model],
                    label=SHORT_LABELS[model],
                )
        ax.set_xticks(range(4), labels, rotation=15)
        ax.set_ylim(-0.03, 1.03)
        ax.set_title(title, loc="left")
        ax.grid(alpha=0.2)
    ax = axes.ravel()[5]
    models = [m for m in MODELS if m in areas["summary"]]
    for index, model in enumerate(models):
        value = areas["summary"][model]["fp_to_target_growth_area_ratio_macro"]
        if value is not None:
            ax.bar(
                index - 0.18,
                value,
                width=0.36,
                color=COLORS[model],
                label="Incident-macro pair ratio" if index == 0 else None,
            )
            pooled = areas["summary"][model].get("pooled_fp_to_target_growth_area_ratio")
            if pooled is not None:
                ax.bar(
                    index + 0.18,
                    pooled,
                    width=0.36,
                    color=COLORS[model],
                    alpha=0.45,
                    hatch="//",
                    label="Pooled physical-area ratio" if index == 0 else None,
                )
        else:
            ax.text(index, 0.05, "undefined", rotation=90, ha="center")
    ax.set_xticks(range(len(models)), [SHORT_LABELS[m] for m in models], rotation=15)
    ax.set_yscale("symlog", linthresh=1)
    ax.set_ylabel("FP growth area / observed growth area")
    ax.set_title("FP / observed growth · two explicit denominators", loc="left")
    ax.legend(fontsize=8)
    ax.grid(axis="y", alpha=0.2)
    axes[0, 0].legend(fontsize=8, ncols=3)
    fig.suptitle(
        "Saved validation forecasts · incident-macro boundary diagnostics · binary masks at 0.50",
        x=0.07,
        ha="left",
        weight="bold",
    )
    fig.text(
        0.07,
        0.005,
        "Fixed-meter bands outside starting footprint; center distances at native resolution. Empty/one-class slices remain undefined. No tuning or new inference.",
        fontsize=9,
    )
    fig.tight_layout(rect=(0, 0.03, 1, 0.95))
    _save(plt, fig, destination / "boundary_comparison.png")


def _example_plot(destination, pair_id, example, area_rows):
    from matplotlib.colors import ListedColormap
    from matplotlib.patches import Patch

    plt = _plotting()
    current, target, valid = example["current"], example["target"], example["valid"]
    probability = example["probabilities"].get("unet")
    if probability is None:
        return None
    actual = target & ~current & valid
    predicted = (probability >= 0.5) & ~current & valid
    fig, axes = plt.subplots(2, 3, figsize=(14, 9))
    fig.subplots_adjust(left=0.04, right=0.91, top=0.82, bottom=0.12, wspace=0.2, hspace=0.3)
    panels = [
        (current, "Known starting footprint", "Greys"),
        (actual, "Actual new growth in fixed grid", "YlOrRd"),
        (np.where(current, 0, probability), "U-Net new-growth probability", "YlOrRd"),
    ]
    image = None
    for ax, (value, title, cmap) in zip(axes[0], panels):
        image = ax.imshow(np.where(valid, value, np.nan), origin="lower", cmap=cmap, vmin=0, vmax=1)
        ax.set_title(title, loc="left", fontsize=11)
    error = np.zeros(current.shape, int)
    error[actual & predicted] = 1
    error[actual & ~predicted] = 2
    error[predicted & ~actual] = 3
    error[current] = 4
    axes[1, 0].imshow(
        np.where(valid, error, np.nan),
        origin="lower",
        vmin=0,
        vmax=4,
        cmap=ListedColormap(["#f5f5f5", "#009e73", "#cc79a7", "#e69f00", "#777777"]),
    )
    axes[1, 0].set_title("U-Net false / missed growth at 0.50", loc="left", fontsize=11)
    models = [m for m in MODELS if any(r["model"] == m and r["pair_id"] == pair_id for r in area_rows)]
    for index, model in enumerate(models):
        row = next(r for r in area_rows if r["model"] == model and r["pair_id"] == pair_id)
        axes[1, 1].bar(index, row["predicted_growth_area_m2"] / 1e6, color=COLORS[model])
    actual_area = actual.sum() * example["cell_size_m"] ** 2 / 1e6
    axes[1, 1].axhline(
        actual_area, color="black", linestyle="--", label=f"Observed growth:{actual_area:.3g}km²"
    )
    axes[1, 1].set_xticks(range(len(models)), [SHORT_LABELS[m] for m in models], rotation=25)
    axes[1, 1].set_ylabel("Predicted growth km²")
    axes[1, 1].set_yscale("symlog", linthresh=0.01)
    axes[1, 1].set_title("Growth area at 0.50 on identical domain", loc="left", fontsize=11)
    axes[1, 1].legend(fontsize=8)
    bands, _, _ = boundary_bands(current, valid, example["cell_size_m"])
    band_image = np.zeros(current.shape, int)
    for index, (name, _, _) in enumerate(BANDS, 1):
        band_image[bands[name]] = index
    axes[1, 2].imshow(
        np.where(valid, band_image, np.nan),
        origin="lower",
        vmin=0,
        vmax=4,
        cmap=ListedColormap(["#777777", "#d9f0a3", "#addd8e", "#78c679", "#238443"]),
    )
    axes[1, 2].set_title("Fixed bands:0–300 /300–1000 /1000–3000 />3000m", loc="left", fontsize=9)
    for ax in [*axes[0], axes[1, 0], axes[1, 2]]:
        ax.set_xticks([])
        ax.set_yticks([])
    issue = datetime.fromtimestamp(example["issue_s"], timezone.utc).isoformat()
    target_time = datetime.fromtimestamp(example["target_s"], timezone.utc).isoformat()
    coverage = example.get("target_coverage_fraction")
    coverage_note = (
        f"Target geometric coverage:{100 * coverage:.2f}%"
        if coverage is not None and np.isfinite(coverage)
        else "Target coverage unknown"
    )
    fig.suptitle(
        f"Predetermined validation pair {pair_id[:16]} · {example['group_id']}\n{issue} → {target_time} · {example['horizon_s'] / 3600:.1f}h · {example['cell_size_m']:g}m/cell\n{coverage_note}; outside-grid growth is not scored. North is up.",
        x=0.04,
        ha="left",
        weight="bold",
        fontsize=12,
    )
    colorbar = fig.add_axes([0.935, 0.58, 0.012, 0.2])
    fig.colorbar(image, cax=colorbar, label="Probability / binary mask")
    fig.legend(
        handles=[
            Patch(facecolor=c, label=label)
            for c, label in [
                ("#009e73", "Correct growth"),
                ("#cc79a7", "Missed growth"),
                ("#e69f00", "False growth"),
                ("#777777", "Already observed"),
            ]
        ],
        loc="lower center",
        ncols=4,
    )
    path = destination / f"validation_growth_examples_{pair_id[:16]}.png"
    _save(plt, fig, path)
    return str(path)


def diagnose_boundary(
    source="runs/codex/forecast_validation", destination="reports/wildfire_forecast/diagnostics"
):
    """Analyze only frozen validation outputs; preserve all source-file bytes."""
    import pyarrow.parquet as pq

    source, destination = Path(source), Path(destination)
    metrics = json.loads((source / "metrics.json").read_text())
    if metrics.get("evaluation_split") != "validation":
        raise ValueError("boundary debugging requires saved validation forecasts")
    protocol = json.loads((source / "protocol.json").read_text())
    shape = tuple(protocol["grid_shape"])
    pairs = json.loads((source / "evaluation_pairs.json").read_text())
    example_ids = sorted(p["pair_id"] for p in pairs)[:3]
    path = source / "forecast_predictions.parquet"
    source_hash = sha256(path)
    parquet = pq.ParquetFile(path)
    rows = []
    area_rows = []
    examples = {}
    seen = set()
    distance_unknown = {}
    last_pair = None
    signatures = {}
    for number in range(parquet.num_row_groups):
        frame = parquet.read_row_group(number).to_pandas().sort_values("cell_id")
        model = str(frame.model.iloc[0])
        if model not in MODELS:
            continue
        if (
            len(frame) != int(np.prod(shape))
            or frame.model.nunique() != 1
            or frame.pair_id.nunique() != 1
            or frame.group_id.nunique() != 1
            or not np.array_equal(frame.cell_id, np.arange(len(frame)))
        ):
            raise ValueError("complete unique model/pair grid required")
        pair, group = str(frame.pair_id.iloc[0]), str(frame.group_id.iloc[0])
        if (model, pair) in seen:
            raise ValueError("duplicate saved model/pair")
        seen.add((model, pair))
        current = frame.current.to_numpy().reshape(shape)
        target = frame.target.to_numpy().reshape(shape)
        valid = frame.valid.to_numpy().reshape(shape)
        probability = frame.probability.to_numpy().reshape(shape)
        scale = float(frame.cell_size_m.iloc[0])
        signature = hashlib.sha256(
            current.tobytes() + target.tobytes() + valid.tobytes() + str(scale).encode()
        ).hexdigest()
        if pair in signatures and signatures[pair] != signature:
            raise ValueError("saved models do not share identical observed geometry/domain")
        signatures[pair] = signature
        if pair != last_pair:
            bands, _, unknown = boundary_bands(current, valid, scale)
            last_pair = pair
            distance_unknown[pair] = unknown
        for name, mask in bands.items():
            score = growth_classification(current, target, probability, mask, cell_size_m=scale)
            rows.append(
                {
                    "model": model,
                    "pair_id": pair,
                    "group_id": group,
                    "band": name,
                    "cell_size_m": scale,
                    **score,
                    **growth_areas(current, target, probability, mask, scale),
                }
            )
        area_rows.append(
            {
                "model": model,
                "pair_id": pair,
                "group_id": group,
                **growth_areas(current, target, probability, valid, scale),
            }
        )
        if pair in example_ids:
            if pair not in examples:
                examples[pair] = {
                    "current": current,
                    "target": target,
                    "valid": valid,
                    "cell_size_m": scale,
                    "group_id": group,
                    "issue_s": float(frame.issue_s.iloc[0]),
                    "target_s": float(frame.target_s.iloc[0]),
                    "horizon_s": float(frame.horizon_s.iloc[0]),
                    "probabilities": {},
                    "target_coverage_fraction": float(frame.target_coverage_fraction.iloc[0])
                    if "target_coverage_fraction" in frame
                    else None,
                }
            examples[pair]["probabilities"][model] = probability
        if (number + 1) % 100 == 0:
            print(
                json.dumps(
                    {
                        "stage": "saved_validation_boundary_diagnostic",
                        "row_groups": number + 1,
                        "total": parquet.num_row_groups,
                    }
                ),
                flush=True,
            )
    by_band = {
        name: {
            **aggregate_growth_classification([r for r in rows if r["band"] == name]),
            "areas": area_summary([r for r in rows if r["band"] == name]),
        }
        for name, _, _ in BANDS
    }
    add_denominator_details(rows, by_band)
    areas = area_summary(area_rows)
    if sha256(path) != source_hash:
        raise ValueError("saved validation forecasts changed during analysis")
    destination.mkdir(parents=True, exist_ok=True)
    result = {
        "schema_version": "validation-boundary-diagnostics-v1",
        "evaluation_split": "validation",
        "source": str(source),
        "source_forecast_predictions_sha256": source_hash,
        "split_manifest_sha256": metrics.get("split_manifest_sha256"),
        "threshold": 0.5,
        "bands": [
            {"name": name, "lower_exclusive_m": low, "upper_inclusive_m": high} for name, low, high in BANDS
        ],
        "distance_definition": "EDT outside observed mask; projected cell-center distance to nearest affected cell center",
        "empty_boundary_distance": distance_unknown,
        "by_band": by_band,
        "whole_growth_domain_areas": areas,
        "pair_growth_areas": area_rows,
        "pair_band_metrics": [{k: v for k, v in row.items() if k != "calibration"} for row in rows],
        "example_pair_ids": example_ids,
        "selection": "three lowest lexical validation pair IDs before diagnostic scores",
        "limitations": [
            "secondary validation debugging; no primary metric, loss, threshold or model changes",
            "meter bands have discrete cell-center support; coarse pixels can leave narrow bands empty",
            "no affected starting cells means distance unknown, not farther than 3000 m",
            "FP/target-growth ratios are null when target growth is zero; zero-growth false positives counted separately",
            "areas are within fixed initial-information grid; outside-target clipping remains unscored",
        ],
    }
    atomic_json(destination / "boundary_metrics.json", result)
    _comparison_plot(destination, by_band, areas)
    plots = [
        _example_plot(destination, pair, examples[pair], area_rows)
        for pair in example_ids
        if pair in examples
    ]
    write_boundary_audit(result, destination)
    return {
        "path": str(destination / "boundary_metrics.json"),
        "examples": [p for p in plots if p],
        "areas": areas["summary"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default="runs/codex/forecast_validation")
    parser.add_argument("--output", default="reports/wildfire_forecast/diagnostics")
    args = parser.parse_args()
    print(json.dumps(diagnose_boundary(args.source, args.output), indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
