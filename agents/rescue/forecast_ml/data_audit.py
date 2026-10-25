"""Read-only historical-date and source-jurisdiction analysis annotations.

This module never changes the frozen dataset, splits, masks or model inputs.
Jurisdiction is the source Incident_C state prefix, not an authoritative USFS
region or polygon/state intersection. Dates are checked without relabeling UTC.
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import re

import pandas as pd

from .data import digest, normalize

US_STATES = set(
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT "
    "NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split()
)


def source_annotations(frame, dataset_hash):
    """Return component strata and source-row date checks; inputs stay unchanged."""
    acquisition = pd.to_datetime(frame.UTC, utc=True, errors="coerce", format="mixed")
    auxiliary = pd.to_datetime(frame.DateUTC, utc=True, errors="coerce", format="mixed")
    comparable = acquisition.notna() & auxiliary.notna()
    agreement = acquisition.dt.normalize().eq(auxiliary.dt.normalize())
    disagreement = comparable & ~agreement
    components = {}
    for raw, _ in frame.groupby("Incident_C", sort=True):
        hit = re.match(r"^([A-Z]{2})[-_]", raw)
        state = hit.group(1) if hit and hit.group(1) in US_STATES else None
        components[normalize(raw)] = {
            "Incident_C": raw,
            "source_jurisdiction": f"source_jurisdiction:{state}" if state else "unknown",
            "source_state_code": state,
            "official_usfs_region": "unknown",
            "interpretation": "State prefix of source incident jurisdiction, not a polygon boundary classification or complete footprint state.",
        }
    quality = {
        "source_rows": len(frame),
        "full_utc_parseable": int(acquisition.notna().sum()),
        "dateutc_parseable": int(auxiliary.notna().sum()),
        "comparable_dates": int(comparable.sum()),
        "dates_agree": int((comparable & agreement).sum()),
        "dates_disagree": int(disagreement.sum()),
        "unknown_comparison": int((~comparable).sum()),
        "decision": "Keep authoritative full UTC field; DateUTC is an auxiliary consistency check only. No observations were excluded by this comparison.",
        "disagreement_rows": [
            {
                "source_fid": int(index),
                "UTC": str(frame.loc[index, "UTC"]),
                "DateUTC": str(frame.loc[index, "DateUTC"]),
                "component_id": normalize(frame.loc[index, "Incident_C"]),
            }
            for index in frame.index[disagreement]
        ],
    }
    result = {
        "schema_version": "nirops-analysis-metadata-v1",
        "dataset_sha256": dataset_hash,
        "purpose": "Evaluation-only strata/quality annotations; no change to frozen features or data manifest.",
        "components": components,
        "source_jurisdiction_component_counts": dict(
            Counter(value["source_jurisdiction"] for value in components.values())
        ),
        "dateutc_fullutc_quality": quality,
    }
    result["analysis_metadata_sha256"] = digest(result)
    return result


def write_analysis_metadata(dataset, output):
    """Read attributes only from the inspected local source; write one sidecar."""
    import pyogrio

    dataset = Path(dataset)
    if dataset.is_dir():
        dataset /= "dataset.json"
    target = Path(output)
    if target.resolve().is_relative_to(dataset.parent.resolve()):
        raise ValueError("analysis annotations must be written outside the immutable data directory")
    frozen = dataset.read_bytes()
    manifest = json.loads(frozen)
    layer = dataset.parent / "raw" / "NIROPS_2020_2024_R1_R6.shp"
    frame = pyogrio.read_dataframe(layer, read_geometry=False)
    result = source_annotations(frame, manifest["dataset_sha256"])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, indent=2))
    if dataset.read_bytes() != frozen:
        raise RuntimeError("frozen dataset changed during independent annotation")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = write_analysis_metadata(args.dataset, args.output)
    print(
        json.dumps(
            {
                "analysis_metadata_sha256": result["analysis_metadata_sha256"],
                "dateutc_fullutc_quality": result["dateutc_fullutc_quality"],
                "source_jurisdiction_component_counts": result["source_jurisdiction_component_counts"],
            },
            indent=2,
        )
    )
