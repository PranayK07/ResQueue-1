"""Independent NIROPS ETL and fixed-grid observation sequences (no training).

Acquisition timestamps are UTC Unix seconds. Actual information-release times
and per-row reconstruction confidence are unavailable; benchmark issue equals
acquisition as an explicit idealized-availability assumption. Sequence targets
remain raw observed footprints, including shrinkage and perimeter revisions.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import asdict
import hashlib
import json
import re
import time
import unicodedata
import uuid
from pathlib import Path

import numpy as np
import pandas as pd

from .archive import prepare_archive, file_hash
from .spatial import grid_from_record as grid_from_record
from .spatial import initial_domain, raster_geometry

# Immutable historical-data identity, preserved byte-for-byte across the
# supervised package migration. This string selects no learning algorithm.
SALT = "NIROPS-FIRE-RL-BENCHMARK-V1"
DOMAIN_ALGORITHM = "first-observation-utm-square-margin0.5extent-clipped2to10km-mpp-ceil10m-v1"
RASTER_RULE = "rasterio-all-touched-positive-y-south-up-v1"
VALID_DOMAIN_ASSUMPTION = (
    "Within the fixed domain, raw component perimeter interior is positive and its exterior "
    "is negative for this component footprint task; exterior is not independently surveyed "
    "fire absence or complete complex coverage."
)


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def normalize(value):
    s = unicodedata.normalize("NFKC", str(value or "")).strip().upper()
    return re.sub(r"[^A-Z0-9]", "", s) if s not in {"NONE", "NULL", "NAN", "UNKNOWN", "N/A", ""} else ""


def split_for(key):
    value = int.from_bytes(hashlib.sha256(f"{SALT}:{key}".encode()).digest()[:8], "big") / 2**64
    return ("train" if value < 0.7 else "validation" if value < 0.85 else "test"), value


def parse_acquisition(values):
    """Require the full UTC field; date-only values are not exact acquisitions."""
    text = pd.Series(values).astype("str")
    full = text.str.contains(r"\d{1,2}:\d{2}", regex=True)
    parsed = pd.to_datetime(text.where(full), utc=True, errors="coerce", format="mixed")
    return parsed


def make_groups(index):
    components = sorted(index.component_id.unique())
    parents = {c: c for c in components}
    evidence = []

    def root(c):
        while parents[c] != c:
            parents[c] = parents[parents[c]]
            c = parents[c]
        return c

    def union(a, b, why):
        a, b = root(a), root(b)
        if a != b:
            parents[max(a, b)] = min(a, b)
        evidence.append({"a": a, "b": b, "basis": why})

    seen = {}
    tokens_by_component = {}
    for comp, rows in index.groupby("component_id", sort=True):
        tokens = set()
        year = int(rows.year.min())
        # Incident_C may carry the overarching complex number while IRWINID
        # and Inc Number identify only one child fire. Scope recurring source
        # parent numbers by year and reject all-zero placeholder numbers.
        for value in rows["Incident_C"]:
            prefix = str(value).split("_", 1)[0].strip().upper()
            if re.fullmatch(r"[A-Z]{2}-[A-Z0-9]+-[A-Z0-9]+", prefix):
                digits = re.sub(r"\D", "", prefix.rsplit("-", 1)[-1])
                if digits and int(digits) != 0:
                    tokens.add(f"PARENT:{year}:" + normalize(prefix))
        for v in rows["IRWINID"]:
            try:
                parsed_uuid = uuid.UUID(str(v).strip("{}"))
                if parsed_uuid.int:
                    tokens.add("IRWIN:" + parsed_uuid.hex.upper())
            except ValueError:
                pass
        for v in rows["Inc Number"]:
            if re.fullmatch(r"[A-Z]{2}-[A-Z0-9]+-[A-Z0-9-]+", str(v).strip(), re.I):
                tokens.add(f"INC:{year}:" + normalize(v))
        if not tokens:
            state = str(rows["Incident_C"].iloc[0]).split("-")[0].upper()
            for v in rows["Inc Name"]:
                if normalize(v):
                    tokens.add(f"FALLBACK:{year}:{state}:" + normalize(v))
        if not tokens:
            tokens.add("COMPONENT:" + comp)
        tokens_by_component[comp] = sorted(tokens)
        for token in sorted(tokens):
            if token in seen:
                union(comp, seen[token], token)
            else:
                seen[token] = comp
    groups = defaultdict(list)
    for c in components:
        groups[root(c)].append(c)
    records = []
    mapping = {}
    for members in sorted(groups.values()):
        tokens = sorted({t for c in members for t in tokens_by_component[c]})
        irwin = [t for t in tokens if t.startswith("IRWIN:")]
        inc = [t for t in tokens if t.startswith("INC:")]
        parent = [t for t in tokens if t.startswith("PARENT:")]
        key = min(parent or irwin or inc or tokens)
        group = "group-" + hashlib.sha256(key.encode()).hexdigest()[:20]
        split, u = split_for(key)
        quality = []
        if len(irwin) > 1:
            quality.append("multiple_irwin_parent_identifiers_conservatively_grouped")
        if not parent and not irwin and not inc:
            quality.append("fallback_identity_ambiguous")
        records.append(
            {
                "group_id": group,
                "canonical_group_key": key,
                "components": sorted(members),
                "identifier_tokens": tokens,
                "split": split,
                "split_u": u,
                "quality_flags": quality,
            }
        )
        for c in members:
            mapping[c] = records[-1]
    return records, mapping, evidence


def load_dataset(path):
    path = Path(path)
    if path.is_dir():
        path = path / "dataset.json"
    value = json.loads(path.read_text())
    if value["schema_version"] != "fire-rl-dataset-v1":
        raise ValueError("incompatible dataset schema")
    value["_manifest_path"] = str(path.resolve())
    return value


def load_sequences(path, split=None):
    data = load_dataset(path)
    return [dict(r) for r in data["sequences"] if split is None or r["split"] == split]


def load_sequence(record):
    if "masks" in record:
        result = dict(record)
    else:
        with np.load(record["masks_path"], allow_pickle=False) as archive:
            result = {
                **record,
                "masks": archive["masks"].astype(bool),
                "valid": archive["valid"].astype(bool),
                "times_s": archive["times_s"].astype(float),
            }
    result.setdefault("acquisition_s", list(result["times_s"]))
    for name in ("masks", "valid", "times_s"):
        result[name] = np.asarray(result[name])
        result[name].setflags(write=False)
    return result


def select_test_pairs(sequences):
    by_group = defaultdict(list)
    for seq in sequences:
        if seq["split"] != "test":
            continue
        for i in range(len(seq["acquisition_s"]) - 1):
            issue, target = seq["acquisition_s"][i : i + 2]
            pair = {
                "pair_id": digest([seq["sequence_id"], i, i + 1])[:24],
                "sequence_id": seq["sequence_id"],
                "group_id": seq["group_id"],
                "component_id": seq["component_id"],
                "from_index": i,
                "to_index": i + 1,
                "source_row_ids": seq["source_row_ids"][i : i + 2],
                "issue_s": issue,
                "target_s": target,
                "horizon_s": target - issue,
                "year": seq["year"],
                "region": seq["region"],
            }
            by_group[seq["group_id"]].append(pair)
    chosen = []
    for group, pairs in sorted(by_group.items()):
        pairs.sort(key=lambda p: (p["issue_s"], p["component_id"], p["sequence_id"], p["from_index"]))
        for i in sorted({0, len(pairs) // 2, len(pairs) - 1}):
            chosen.append(pairs[i])
    return chosen


def _runs(times):
    start = 0
    for i, gap in enumerate(np.diff(times)):
        if not 6 * 3600 <= gap <= 72 * 3600:
            if i + 1 - start >= 3:
                yield start, i + 1
            start = i + 1
    if len(times) - start >= 3:
        yield start, len(times)


def build_dataset(archive, output="data/codex", report="reports/wildfire_forecast"):
    """Create an explicitly requested dataset; reuse a completed manifest unchanged.

    The existing data/codex tree is frozen. Package or model changes must not
    rebuild it; use the provenance snapshot verifier for migration checks.
    """
    import pyogrio
    import shapely
    from shapely.geometry import MultiPolygon, Polygon
    from shapely.ops import unary_union

    started = time.monotonic()
    output = Path(output).resolve()
    report = Path(report).resolve()
    output.mkdir(parents=True, exist_ok=True)
    report.mkdir(parents=True, exist_ok=True)
    final = output / "dataset.json"
    if final.exists():
        return load_dataset(final)
    inventory = prepare_archive(archive, output / "raw")
    archive_prepared_at = time.monotonic()
    shp = next((output / "raw").glob("*.shp"))
    info = pyogrio.read_info(shp)
    if info["crs"] != "EPSG:4326":
        raise ValueError("unexpected inspected source CRS")
    index = pyogrio.read_dataframe(shp, read_geometry=False)
    expected = {"Incident_C", "UTC", "DateUTC", "Acres", "IRWINID", "Inc Name", "Inc Number"}
    if not expected.issubset(index.columns):
        raise ValueError(f"actual fields do not match inspected adapter: {index.columns}")
    index["source_fid"] = np.arange(len(index))
    index["acquired"] = parse_acquisition(index.UTC)
    index["year"] = index.acquired.dt.year.astype("Int64")
    index["component_id"] = index.Incident_C.map(normalize)
    index["source_row_id"] = [
        hashlib.sha256(f"{inventory['archive_sha256']}|{info['layer_name']}|{i}".encode()).hexdigest()
        for i in index.source_fid
    ]
    bad_time = index.acquired.isna() | index.component_id.eq("")
    exclusions = [
        {
            "source_row_id": r.source_row_id,
            "source_fid": int(r.source_fid),
            "reason": "missing_full_timestamp_or_component",
        }
        for r in index[bad_time].itertuples()
    ]
    index = index[~bad_time].copy()
    groups, mapping, evidence = make_groups(index)
    clean = output / "clean"
    arrays = output / "sequences"
    clean.mkdir(exist_ok=True)
    arrays.mkdir(exist_ok=True)
    sequences = []
    crosswalk = []
    counts = Counter()
    all_gaps = []
    areas = []
    growth = []
    durations = []
    coverage = []
    accepted_ids = []
    component_audit = []
    omissions = []
    for number, (component, attribute_rows) in enumerate(index.groupby("component_id", sort=True)):
        fids = attribute_rows.source_fid.to_numpy()
        frame = pyogrio.read_dataframe(shp, fids=fids, use_arrow=True)
        frame["source_fid"] = fids
        attr = attribute_rows.set_index("source_fid")
        frame["source_row_id"] = [attr.loc[f, "source_row_id"] for f in fids]
        frame["acquisition_s"] = [attr.loc[f, "acquired"].timestamp() for f in fids]
        frame["component_id"] = component
        group = mapping[component]
        frame["group_id"] = group["group_id"]
        frame["split"] = group["split"]
        frame["timestamp_confidence"] = "unknown_source_may_have_reconstructed_time"
        frame["information_release_s"] = pd.Series([None] * len(frame), dtype="float64")
        frame["availability_assumption"] = (
            "benchmark_issue_equals_acquisition_not_verified_operational_release"
        )
        frame["raw_geometry_wkb"] = shapely.to_wkb(frame.geometry.to_numpy())
        repaired = []
        usable = []
        for j, geom in enumerate(frame.geometry):
            if geom is None or geom.is_empty:
                repaired.append(False)
                usable.append(False)
                counts["missing_or_empty_geometry"] += 1
                continue
            invalid = not geom.is_valid
            if invalid:
                counts["geometry_repaired"] += 1
                geom = shapely.make_valid(geom)
                if geom.geom_type == "GeometryCollection":
                    geom = unary_union([g for g in geom.geoms if isinstance(g, (Polygon, MultiPolygon))])
                frame.at[j, "geometry"] = geom
            repaired.append(invalid)
            usable.append(not geom.is_empty and geom.is_valid and isinstance(geom, (Polygon, MultiPolygon)))
        frame["geometry_repaired"] = repaired
        excluded = set(frame.index[~np.asarray(usable)])
        for _, same in frame.groupby("acquisition_s"):
            if len(same) <= 1:
                continue
            hashes = [hashlib.sha256(v).hexdigest() for v in same.raw_geometry_wkb]
            if len(set(hashes)) == 1:
                excluded.update(same.index[1:])
                counts["exact_duplicates"] += len(same) - 1
            else:
                excluded.update(same.index)
                counts["conflicting_same_time"] += len(same)
        for j in sorted(excluded):
            reason = (
                "conflicting_or_duplicate_timestamp"
                if frame.acquisition_s.duplicated(keep=False).loc[j]
                else "unusable_geometry"
            )
            exclusions.append(
                {
                    "source_row_id": frame.loc[j, "source_row_id"],
                    "source_fid": int(frame.loc[j, "source_fid"]),
                    "reason": reason,
                }
            )
        frame["accepted"] = ~frame.index.isin(excluded)
        component_path = clean / (hashlib.sha256(component.encode()).hexdigest()[:20] + ".parquet")
        frame.to_parquet(component_path, index=False, compression="zstd")
        good = frame[frame.accepted].sort_values(["acquisition_s", "source_fid"]).reset_index(drop=True)
        accepted_ids += good.source_row_id.tolist()
        for r in frame.itertuples():
            crosswalk.append(
                {
                    "source_row_id": r.source_row_id,
                    "source_fid": int(r.source_fid),
                    "component_id": component,
                    "group_id": group["group_id"],
                    "split": group["split"],
                    "accepted": r.accepted,
                }
            )
        if len(good):
            projected = good.to_crs(6933)
            values = projected.area.to_numpy()
            areas += values.tolist()
            growth += np.diff(values).tolist()
            durations.append(float((good.acquisition_s.max() - good.acquisition_s.min()) / 3600))
        times = good.acquisition_s.to_numpy()
        all_gaps += np.diff(times).tolist()
        component_audit.append(
            {
                "component_id": component,
                "group_id": group["group_id"],
                "split": group["split"],
                "records": len(frame),
                "accepted": len(good),
                "clean_path": str(component_path),
                "year": int(attribute_rows.year.min()),
                "region": "unknown",
            }
        )
        used = set()
        for run_index, (start, end) in enumerate(_runs(times)):
            part = good.iloc[start:end]
            grid = initial_domain(part.geometry.iloc[0], 128)
            masks = []
            cover = []
            metric_areas = []
            for geom in part.geometry:
                mask, cov, area = raster_geometry(geom, grid)
                masks.append(mask)
                cover.append(cov)
                metric_areas.append(area)
            masks = np.asarray(masks, bool)
            if not masks[0].any():
                omissions.append({"component_id": component, "reason": "initial_perimeter_no_raster_cells"})
                continue
            seq_id = "sequence-" + digest([component, part.source_row_id.tolist(), asdict(grid)])[:24]
            array_path = arrays / f"{seq_id}.npz"
            np.savez_compressed(
                array_path,
                masks=masks,
                valid=np.ones((128, 128), bool),
                times_s=part.acquisition_s.to_numpy(dtype=float),
            )
            covered = part.index.tolist()
            used.update(covered)
            coverage += cover
            sequences.append(
                {
                    "sequence_id": seq_id,
                    "group_id": group["group_id"],
                    "component_id": component,
                    "split": group["split"],
                    "grid": asdict(grid),
                    "masks_path": str(array_path),
                    "masks_sha256": file_hash(array_path),
                    "acquisition_s": part.acquisition_s.tolist(),
                    "times_s": part.acquisition_s.tolist(),
                    "information_release_s": [None] * len(part),
                    "availability_assumption": "idealized_issue_equals_acquisition",
                    "source_row_ids": part.source_row_id.tolist(),
                    "source_fids": part.source_fid.tolist(),
                    "year": int(attribute_rows.year.min()),
                    "region": "unknown",
                    "geometry_area_m2": metric_areas,
                    "coverage_fraction": cover,
                    "out_of_domain_area_m2": [a * (1 - c) for a, c in zip(metric_areas, cover)],
                    "eligible_transition_indices": list(range(len(part) - 1)),
                    "quality_flags": [
                        "timestamp_confidence_unknown",
                        "historical_weather_missing",
                        "region_unknown",
                    ]
                    + group["quality_flags"],
                    "rasterization": RASTER_RULE,
                    "domain_algorithm": DOMAIN_ALGORITHM,
                }
            )
        for j, r in good.iterrows():
            if j not in used:
                omissions.append(
                    {
                        "source_row_id": r.source_row_id,
                        "component_id": component,
                        "reason": "not_in_contiguous_6_to72hour_run_with_at_least3_observations",
                    }
                )
        if number % 25 == 0:
            print(
                json.dumps(
                    {
                        "stage": "component_raster",
                        "completed": number + 1,
                        "total": len(mapping),
                        "sequences": len(sequences),
                        "accepted": len(accepted_ids),
                    }
                ),
                flush=True,
            )
    pairs = select_test_pairs(sequences)
    split_manifest = {
        "schema_version": "nirops-group-split-v1",
        "salt": SALT,
        "hash_input": "salt:canonical_group_key UTF-8",
        "digest_rule": "first8_unsigned_big_endian_divide2pow64",
        "thresholds": [0.7, 0.85],
        "groups": groups,
        "crosswalk": crosswalk,
        "test_pairs": pairs,
        "test_pair_membership_sha256": digest(pairs),
        "counts": dict(Counter(g["split"] for g in groups)),
        "sequence_counts": dict(Counter(s["split"] for s in sequences)),
        "eligible_pairs_by_partition": {
            split: sum(len(s["acquisition_s"]) - 1 for s in sequences if s["split"] == split)
            for split in ("train", "validation", "test")
        },
        "ambiguity_evidence": evidence,
    }
    (output / "split_manifest.json").write_text(json.dumps(split_manifest, indent=2))
    (report / "split_manifest.json").write_text(json.dumps(split_manifest, indent=2))
    split_hash = file_hash(output / "split_manifest.json")
    (output / "exclusions.json").write_text(json.dumps(exclusions, indent=2))
    (output / "sequence_omissions.json").write_text(json.dumps(omissions, indent=2))
    (output / "component_audit.json").write_text(json.dumps(component_audit, indent=2))
    clean_hash = digest(
        {
            "accepted_source_ids": sorted(accepted_ids),
            "clean_files": {p.name: file_hash(p) for p in sorted(clean.glob("*.parquet"))},
        }
    )
    result = {
        "schema_version": "fire-rl-dataset-v1",
        "agent": "codex",
        "base_commit": "dcaaf5b",
        "archive_sha256": inventory["archive_sha256"],
        "clean_sha256": clean_hash,
        "split_manifest_sha256": split_hash,
        "test_pair_membership_sha256": digest(pairs),
        "rasterization": RASTER_RULE,
        "domain_algorithm": DOMAIN_ALGORITHM,
        "source_count": info["features"],
        "accepted_count": len(accepted_ids),
        "grid_shape": [128, 128],
        "horizon_range_s": [21600, 259200],
        "weather": {
            "available": False,
            "assumption": "zero wind for historical simulator benchmarks; not historical observations",
        },
        "target_definition": "raw_next_component_footprint_in_initial_UTM_domain",
        "valid_domain_assumption": VALID_DOMAIN_ASSUMPTION,
        "sequences": sequences,
        "test_pairs": pairs,
        "split_manifest_path": str(output / "split_manifest.json"),
    }
    result["dataset_sha256"] = digest(result)
    final.write_text(json.dumps(result, indent=2))

    def summary(values):
        return {str(q): float(np.quantile(values, q)) for q in (0, 0.25, 0.5, 0.75, 1)} if len(values) else {}

    audit = {
        "schema_version": "nirops-dataset-audit-v1",
        "agent": "codex",
        "archive_sha256": inventory["archive_sha256"],
        "source_records": info["features"],
        "accepted_records": len(accepted_ids),
        "excluded_records": len(exclusions),
        "counts": dict(counts),
        "source_components": len(mapping),
        "incident_groups": len(groups),
        "partitions": split_manifest["counts"],
        "sequence_counts": split_manifest["sequence_counts"],
        "eligible_pairs": split_manifest["eligible_pairs_by_partition"],
        "test_selected_pairs": len(pairs),
        "test_eligible_groups": len({p["group_id"] for p in pairs}),
        "observations_by_year": {str(k): int(v) for k, v in index.year.value_counts().sort_index().items()},
        "region_counts": {"unknown": len(groups)},
        "duration_hours_quantiles": summary(durations),
        "observation_gap_hours_quantiles": summary(np.asarray(all_gaps) / 3600),
        "growth_area_m2_quantiles": summary(growth),
        "coverage_fraction_quantiles": summary(coverage),
        "area_m2_quantiles": summary(areas),
        "available_history_length_quantiles": summary([len(s["acquisition_s"]) for s in sequences]),
        "timestamp_confidence": "unknown; source documentation permits reconstructed timestamps",
        "information_availability": "not supplied; idealized acquisition-time benchmark only",
        "rasterization": RASTER_RULE,
        "domain_algorithm": DOMAIN_ALGORITHM,
        "canonical_group_count": len(groups),
        "split_manifest_sha256": split_hash,
        "prep_elapsed_s": time.monotonic() - started,
        "archive_preflight_elapsed_s": inventory.get("preflight_elapsed_s"),
        "valid_domain_assumption": VALID_DOMAIN_ASSUMPTION,
        "scientific_limitations": [
            "active perimeters can shrink; raw targets preserved",
            "weather/terrain/vegetation not supplied",
            "regions not present in inspected attributes",
            "later footprints clipped to fixed initial domain; excluded area recorded",
            "parent grouping identifier links may remain ambiguous",
            "component sequences do not assert complete complex coverage",
            "Exterior negatives are component-footprint assumptions, not independently surveyed absence of fire.",
        ],
    }
    audit["etl_raster_elapsed_s"] = time.monotonic() - archive_prepared_at
    audit["total_preparation_elapsed_s"] = audit["etl_raster_elapsed_s"] + inventory.get(
        "preflight_elapsed_s", 0.0
    )
    (output / "dataset_audit.json").write_text(json.dumps(audit, indent=2))
    (report / "dataset_audit.json").write_text(json.dumps(audit, indent=2))
    _audit_plot(audit, report / "dataset_audit.png", all_gaps, growth, durations, coverage)
    print(
        json.dumps(
            {
                "stage": "dataset_complete",
                "path": str(final),
                "accepted": len(accepted_ids),
                "groups": len(groups),
                "sequences": len(sequences),
                "test_pairs": len(pairs),
                "elapsed_s": audit["prep_elapsed_s"],
            }
        ),
        flush=True,
    )
    return result


def _audit_plot(audit, path, gaps, growth, durations, coverage):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 3, figsize=(13, 7), constrained_layout=True)
    years = audit["observations_by_year"]
    axes[0, 0].bar(list(years), list(years.values()))
    axes[0, 0].set(title="Source observations by year", ylabel="Observations")
    axes[0, 1].hist(np.clip(np.asarray(gaps) / 3600, 0, 168), bins=32)
    axes[0, 1].set(title="Observed acquisition gaps", xlabel="Hours (clipped at168)")
    axes[0, 2].hist(durations, bins=30)
    axes[0, 2].set(title="Component observation duration", xlabel="Hours")
    axes[1, 0].hist(np.arcsinh(np.asarray(growth) / 1e6), bins=40)
    axes[1, 0].set(title="Raw area change (can be negative)", xlabel="asinh(delta km²)")
    axes[1, 1].hist(coverage, bins=25)
    axes[1, 1].set(title="Later footprint coverage in fixed domain", xlabel="Area fraction")
    axes[1, 2].axis("off")
    axes[1, 2].text(
        0,
        1,
        f"NIROPS inspected source\n{audit['source_records']:,} original rows\n{audit['accepted_records']:,} accepted rows\n{audit['incident_groups']} leakage groups\n{audit['test_selected_pairs']} frozen test transitions\nRegions: unknown in source\nNo historical weather supplied",
        va="top",
        fontsize=12,
    )
    fig.suptitle(
        "Codex independent NIROPS dataset audit — observed data, not synthetic rescue outcomes", fontsize=14
    )
    fig.savefig(path, dpi=140)
    plt.close(fig)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--archive", required=True)
    p.add_argument("--output", default="data/codex")
    p.add_argument("--report", default="reports/wildfire_forecast")
    args = p.parse_args()
    build_dataset(args.archive, args.output, args.report)
