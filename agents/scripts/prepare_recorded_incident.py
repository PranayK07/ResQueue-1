"""Export an existing recorded sequence and model into a portable replay bundle. Never trains.

python agents/scripts/prepare_recorded_incident.py --dataset data/codex/dataset.json \
  --sequence-id <id> --model-export runs/supervised/export --output runs/recorded-demo
"""

from __future__ import annotations

import argparse
from dataclasses import asdict
import json
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from rescue.forecast_ml.data import load_dataset, load_sequence  # noqa: E402
from rescue.forecast_ml.integration import make_demo  # noqa: E402
from rescue.forecast_ml.provenance import sha256  # noqa: E402
from rescue.forecast_ml.risk import ForecastProduct, synthetic_residents  # noqa: E402
from rescue.forecast_ml.geo_contract import validate_projected_grid  # noqa: E402


def prepare(dataset_path, sequence_id, model_export, output):
    dataset = load_dataset(dataset_path)
    record = next(s for s in dataset["sequences"] if s["sequence_id"] == sequence_id)
    if sha256(record["masks_path"]) != record["masks_sha256"]:
        raise ValueError("source sequence checksum mismatch")
    sequence = load_sequence(record)
    grid = validate_projected_grid(record["grid"])
    model_export, output = Path(model_export), Path(output)
    metadata = json.loads((model_export / "model_metadata.json").read_text())
    if sha256(model_export / "model.pt") != metadata["deployment"]["checkpoint_sha256"]:
        raise ValueError("model export checksum mismatch")
    output.mkdir(parents=True, exist_ok=False)
    np.savez_compressed(
        output / "observations.npz",
        masks=sequence["masks"],
        valid=sequence["valid"],
        times_s=sequence["times_s"],
    )
    # Only the first known observation determines synthetic stations/resident eligibility.
    product = ForecastProduct(
        grid,
        float(sequence["times_s"][0]),
        [21600.0],
        sequence["masks"][:1].astype(float),
        sequence["valid"],
        sequence["masks"][0],
        "observation-only",
        "persistence",
    )
    residents = synthetic_residents(
        grid, sequence["valid"], pair_id=sequence_id, observed=product.observed, count=24
    )
    world, _, stations, units = make_demo(product, residents)
    manifest = dict(
        schema_version="recorded-fire-v1",
        scenario=f"recorded-{sequence_id}",
        source_id=sequence_id,
        grid=record["grid"],
        routing_grid=asdict(world),
        arrays="observations.npz",
        arrays_sha256=sha256(output / "observations.npz"),
        source_dataset_sha256=sha256(dataset["_manifest_path"]),
        source_sequence_sha256=record["masks_sha256"],
        availability_assumption="idealized_release_equals_acquisition",
        stations=stations,
        units=[{k: u[k] for k in ("id", "station_id", "callsign", "kind", "capacity")} for u in units],
        residents=residents,
    )
    (output / "incident.json").write_text(json.dumps(manifest, indent=2) + "\n")
    for name in ("model.pt", "model_metadata.json"):
        shutil.copyfile(model_export / name, output / name)
    return output / "incident.json"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("dataset", "sequence-id", "model-export", "output"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    print(prepare(args.dataset, args.sequence_id, args.model_export, args.output).resolve())
