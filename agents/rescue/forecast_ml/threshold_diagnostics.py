"""Compare already saved threshold views, without inference or model selection.

Full-footprint classification retains known affected cells. Growth precision,
recall and all-defined F1 exclude the initial footprint. The primary growth
IoU/Dice additionally use the common observed-growth-positive population.
These distinct populations are always named and counted explicitly.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .metrics import aggregate, per_incident
from .provenance import atomic_json, sha256


def summarize_threshold(rows, threshold):
    """Summarize frozen metrics using the existing incident-macro formulas."""
    rows = [{**row, "model": "unet"} for row in rows]
    summary = aggregate(rows)["unet"]
    incidents = per_incident(rows)
    positive = [r for r in rows if r.get("actual_growth_cells", 0) > 0]
    full = {key: summary.get(key + "_macro") for key in ("precision", "recall", "f1")}
    full["defined_groups"] = {
        key: summary.get(key + "_defined_groups") for key in ("precision", "recall", "f1")
    }
    full["pooled_confusion"] = {
        key: sum(r["confusion"][key] for r in rows) for key in ("tn", "fp", "fn", "tp")
    }
    growth = {
        "precision_macro": summary.get("new_growth_precision_macro"),
        "recall_macro": summary.get("new_growth_recall_macro"),
        "f1_all_defined_macro": summary.get("new_growth_dice_all_defined_macro"),
        "f1_all_defined_defined_groups": summary.get("new_growth_dice_all_defined_defined_groups"),
        "precision_defined_groups": summary.get("new_growth_precision_defined_groups"),
        "recall_defined_groups": summary.get("new_growth_recall_defined_groups"),
        "pooled_confusion": {
            key: sum(r["growth_confusion"][key] for r in rows) for key in ("tn", "fp", "fn", "tp")
        },
        "f1_population": "all pairs where actual or predicted growth is nonempty; no-growth false positives remain as F1=0",
    }
    primary = {
        "new_growth_iou_macro": summary.get("new_growth_iou_macro"),
        "new_growth_dice_conditional_macro": summary.get("new_growth_dice_macro"),
        "eligible_groups": len({r["group_id"] for r in positive}),
        "eligible_pairs": len(positive),
        "population": "same actual-growth-positive pairs at every threshold; conditional Dice is not the all-defined growth F1",
    }
    return {
        "threshold": threshold,
        "incident_groups": len(incidents),
        "forecast_pairs": len(rows),
        "full_footprint": full,
        "growth_only": growth,
        "primary_new_growth": primary,
        "per_incident": incidents,
    }


def compare_saved_thresholds(report_dir):
    """Read the existing primary and validation-selected views of one probability source."""
    report_dir = Path(report_dir)
    metrics = json.loads((report_dir / "metrics.json").read_text())
    primary_threshold = float(metrics.get("primary_threshold", 0.5))
    primary = [r for r in json.loads((report_dir / "pair_metrics.json").read_text()) if r["model"] == "unet"]
    secondary = json.loads((report_dir / "validation_threshold_metrics.json").read_text())
    secondary_threshold = float(secondary["threshold"])
    secondary_rows = secondary["pair_metrics"]
    left = {(r["group_id"], r["pair_id"]): r.get("actual_growth_cells") for r in primary}
    right = {(r["group_id"], r["pair_id"]): r.get("actual_growth_cells") for r in secondary_rows}
    if left != right:
        raise ValueError("threshold views do not share identical frozen case/label membership")
    summaries = {
        format(primary_threshold, ".12g"): summarize_threshold(primary, primary_threshold),
        format(secondary_threshold, ".12g"): summarize_threshold(secondary_rows, secondary_threshold),
    }
    artifact = {
        "schema_version": "saved-supervised-threshold-comparison-v1",
        "thresholds": summaries,
        "source_probability_sha256": sha256(report_dir / "forecast_predictions.parquet"),
        "source_primary_metrics_sha256": sha256(report_dir / "pair_metrics.json"),
        "source_primary_metrics_file": "pair_metrics.json",
        "source_pair_metrics_sha256": sha256(report_dir / "pair_metrics.json"),
        "source_aggregate_metrics_sha256": sha256(report_dir / "metrics.json"),
        "source_secondary_metrics_sha256": sha256(report_dir / "validation_threshold_metrics.json"),
        "selection": "threshold chosen on validation only; primary remains 0.5; no new model inference or fitting",
        "test_set_status": metrics.get("test_set_status"),
        "definitions": {
            "averaging": "pair metric means within incident, then macro across defined incidents",
            "full_footprint": "all valid observed target cells, including already known footprint",
            "growth_only": "valid cells outside starting footprint",
            "all_defined_growth_f1": "2TP/(2TP+FP+FN); both-empty pairs undefined; includes zero-actual-growth false positives",
            "conditional_growth_dice": "same formula but only actual-growth-positive pairs, matching primary IoU population",
        },
    }
    atomic_json(report_dir / "threshold_comparison.json", artifact)
    full_lines = []
    growth_lines = []
    for key, row in sorted(summaries.items(), key=lambda item: float(item[0])):
        full = row["full_footprint"]
        g = row["growth_only"]
        p = row["primary_new_growth"]

        def show(value):
            return "undefined" if value is None else f"{100 * value:.2f}%"

        full_lines.append(
            f"| {float(key):.2f} | {show(full['precision'])} | {show(full['recall'])} | {show(full['f1'])} | {row['incident_groups']} / {row['forecast_pairs']} |"
        )
        growth_lines.append(
            f"| {float(key):.2f} | {show(g['precision_macro'])} | {show(g['recall_macro'])} | {show(g['f1_all_defined_macro'])} | {g['precision_defined_groups']} / {g['recall_defined_groups']} / {g['f1_all_defined_defined_groups']} | {show(p['new_growth_iou_macro'])} | {show(p['new_growth_dice_conditional_macro'])} | {p['eligible_groups']} / {p['eligible_pairs']} |"
        )
    text = f"""# Saved-probability threshold comparison

These are two threshold views of the same frozen neural probability maps. No inference, optimization or new model selection occurred. {metrics.get("test_set_status")}.

## Full footprint, including known affected cells

| Threshold | Precision | Recall | F1 | Incident groups / pairs |
|---|---:|---:|---:|---:|
{chr(10).join(full_lines)}

## New growth, excluding the starting footprint

| Threshold | Growth precision | Growth recall | Growth F1 (all defined) | Defined groups P / R / F1 | Original conditional growth IoU | Conditional growth Dice | Positive-target groups / pairs |
|---|---:|---:|---:|---:|---:|---:|---:|
{chr(10).join(growth_lines)}

The F1 column and conditional Dice have the same cell-level formula but different admitted pair populations. All-defined growth F1 includes false-positive predictions on no-observed-growth pairs; both-empty pairs are undefined. The original conditional IoU/Dice use the identical observed-growth-positive cases for both thresholds. The frozen operating-point report separately reports all-defined growth IoU and its confidence intervals. Metric-specific defined-group counts and raw confusion totals are in `threshold_comparison.json`.

High full-footprint precision/recall/F1 can be driven by retaining already known affected cells. They do not establish comparable new-growth accuracy. 0.50 remains the common primary threshold for every method; the other threshold was selected using validation and is reported separately.
"""
    (report_dir / "threshold_comparison.md").write_text(text)
    return artifact


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-dir", required=True)
    args = parser.parse_args()
    result = compare_saved_thresholds(args.report_dir)
    print(
        json.dumps(
            {
                key: {
                    "full_footprint": row["full_footprint"],
                    "growth_only": row["growth_only"],
                    "primary": row["primary_new_growth"],
                }
                for key, row in result["thresholds"].items()
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
