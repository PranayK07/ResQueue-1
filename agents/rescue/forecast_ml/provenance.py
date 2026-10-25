"""Small reproducibility helpers; never import application settings or secrets."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import subprocess
import tempfile
import os
from pathlib import Path
from datetime import datetime, timezone

AGENT_ID = "codex"
BASE_COMMIT = "dcaaf5b"


class FrozenInputsChanged(RuntimeError):
    """Frozen scientific input bytes changed after campaign initialization."""


def canonical_dataset_hash(dataset: dict) -> str:
    """Hash ETL's canonical payload, distinct from pretty JSON file bytes."""
    payload = {k: v for k, v in dataset.items() if k != "dataset_sha256" and not k.startswith("_")}
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def freeze_inputs(dataset_path: str | Path, dataset: dict) -> dict:
    """Validate partition isolation and capture immutable file/content hashes.

    Components and every source observation must belong to one parent group
    and partition. This checks the declared grouping; geological/identifier
    evidence for grouping belongs to the separately audited ETL crosswalk.
    """
    path = Path(dataset_path).resolve()
    if path.is_dir():
        path = path / "dataset.json"
    canonical = canonical_dataset_hash(dataset)
    if dataset.get("dataset_sha256") != canonical:
        raise ValueError("canonical dataset hash does not match frozen metadata")
    if canonical_dataset_hash(json.loads(path.read_text())) != canonical:
        raise ValueError("dataset file changed while loading campaign metadata")
    split_path = Path(dataset["split_manifest_path"])
    if not split_path.is_absolute():
        split_path = path.parent / split_path
    split_path = split_path.resolve()
    split_hash = sha256(split_path)
    if split_hash != dataset.get("split_manifest_sha256"):
        raise ValueError("split manifest file hash does not match dataset")
    split = json.loads(split_path.read_text())
    memberships = {}
    for group in split["groups"]:
        if group["group_id"] in memberships:
            raise ValueError("duplicate incident-group manifest entry")
        memberships[group["group_id"]] = group["split"]
    groups, components, sources, files = {}, {}, {}, {}
    sequences = {}

    def bind(mapping, key, value, label):
        if key in mapping and mapping[key] != value:
            raise ValueError(f"{label} crosses incident groups or partitions: {key}")
        mapping[key] = value

    for record in dataset["sequences"]:
        partition, group = record["split"], record["group_id"]
        if partition not in {"train", "validation", "test"} or memberships.get(group) != partition:
            raise ValueError("sequence partition differs from group manifest")
        bind(groups, group, partition, "incident group")
        bind(components, record["component_id"], (group, partition), "component")
        for source in record["source_row_ids"]:
            bind(sources, source, (group, partition), "source observation")
        if record["sequence_id"] in sequences:
            raise ValueError("duplicate historical sequence ID")
        sequences[record["sequence_id"]] = record
        array_path = Path(record["masks_path"])
        if not array_path.is_absolute():
            array_path = path.parent / array_path
        array_path = array_path.resolve()
        actual = sha256(array_path)
        if actual != record.get("masks_sha256"):
            raise ValueError("historical sequence bytes differ from frozen record hash")
        files[str(array_path)] = actual
    for row in split.get("crosswalk", []):
        declared = (row["group_id"], row["split"])
        if memberships.get(row["group_id"]) != row["split"]:
            raise ValueError("source crosswalk partition differs from group manifest")
        bind(components, row["component_id"], declared, "component")
        bind(sources, row["source_row_id"], declared, "source observation")
    for pair in dataset.get("test_pairs", []):
        record = sequences[pair["sequence_id"]]
        if record["split"] != "test" or pair["group_id"] != record["group_id"]:
            raise ValueError("final-test pair is outside its declared held-out group")
        expected = [record["source_row_ids"][pair["from_index"]], record["source_row_ids"][pair["to_index"]]]
        if pair["source_row_ids"] != expected:
            raise ValueError("final-test pair source IDs differ from frozen observations")
    return {
        "dataset_path": str(path),
        "dataset_file_sha256": sha256(path),
        "dataset_canonical_sha256": canonical,
        "split_manifest_path": str(split_path),
        "split_manifest_file_sha256": split_hash,
        "sequence_file_sha256": files,
        "partition_sequence_counts": {
            p: sum(r["split"] == p for r in dataset["sequences"]) for p in ("train", "validation", "test")
        },
        "incident_groups": len(groups),
        "incident_groups_with_sequences": len(groups),
        "all_manifest_incident_groups": len(memberships),
        "components": len(components),
        "source_observations": len(sources),
        "isolation_verified": True,
    }


def assert_inputs_unchanged(snapshot: dict) -> None:
    """Reject changed metadata, split bytes or NPZ inputs before model selection."""
    expected = {
        snapshot["dataset_path"]: snapshot["dataset_file_sha256"],
        snapshot["split_manifest_path"]: snapshot["split_manifest_file_sha256"],
        **snapshot["sequence_file_sha256"],
    }
    for path, digest in expected.items():
        try:
            unchanged = sha256(path) == digest
        except OSError as exc:
            raise FrozenInputsChanged(f"frozen input unavailable: {path}") from exc
        if not unchanged:
            raise FrozenInputsChanged(f"frozen input changed: {path}")


# Compatibility with supervised checkpoint code written before the package
# rename. These aliases perform integrity checks; they never train or update.
TrainingInputsChanged = FrozenInputsChanged
freeze_training_inputs = freeze_inputs
assert_training_inputs_unchanged = assert_inputs_unchanged


def sha256(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path: str | Path, value) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def manifest(root: str | Path, *, inputs=None, config=None):
    root = Path(root).resolve()

    def git(*args):
        result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=False)
        return result.stdout.strip()

    versions = {}
    for name in (
        "numpy",
        "torch",
        "scipy",
        "pandas",
        "pyproj",
        "rasterio",
        "pyogrio",
        "shapely",
        "pyarrow",
    ):
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    source = {
        str(p.relative_to(root)): sha256(p) for p in sorted((root / "agents/rescue/forecast_ml").glob("*.py"))
    }
    return {
        "agent": AGENT_ID,
        "base_commit": BASE_COMMIT,
        "branch": git("branch", "--show-current"),
        "commit": git("rev-parse", "HEAD"),
        "dirty": bool(git("status", "--porcelain")),
        "recorded_utc": datetime.now(timezone.utc).isoformat(),
        "python": platform.python_version(),
        "dependencies": versions,
        "source_sha256": source,
        "inputs": inputs or {},
        "config": config or {},
    }


def snapshot_data_assets(data_root: str | Path, archive: str | Path | None = None) -> dict:
    """Hash all explicit dataset files without rewriting data or fitting models.

    The snapshot includes raw companions, cleaned GeoParquet, all NPZ arrays,
    metadata and split bytes. It is written by the CLI outside the data tree.
    """
    repository = Path.cwd().resolve()
    data_root = Path(data_root).resolve()
    paths = sorted(path for path in data_root.rglob("*") if path.is_file())
    files = {}
    for path in paths:
        key = str(path.relative_to(repository)) if path.is_relative_to(repository) else str(path)
        files[key] = {"bytes": path.stat().st_size, "sha256": sha256(path)}
    dataset = json.loads((data_root / "dataset.json").read_text())
    split = json.loads((data_root / "split_manifest.json").read_text())
    source = Path(archive).expanduser().resolve() if archive else None
    return {
        "schema_version": "immutable-historical-data-snapshot-v1",
        "phase": "after-supervised-package-migration",
        "root": str(repository),
        "files": files,
        "source_archive": {"path": str(source), "bytes": source.stat().st_size, "sha256": sha256(source)}
        if source
        else None,
        "dataset_canonical_sha256": dataset["dataset_sha256"],
        "dataset_file_sha256": sha256(data_root / "dataset.json"),
        "split_file_sha256": sha256(data_root / "split_manifest.json"),
        "test_pair_membership_sha256": dataset["test_pair_membership_sha256"],
        "group_count": len(split["groups"]),
        "partition_counts": split["counts"],
        "npz_files": sum(path.suffix == ".npz" for path in paths),
        "clean_geoparquet_files": sum(
            path.suffix == ".parquet" and path.parent.name == "clean" for path in paths
        ),
    }


def compare_data_snapshots(before: dict, after: dict) -> dict:
    """Return exact byte-identity evidence; metadata labels do not change hashes."""
    old, new = before["files"], after["files"]
    added, removed = sorted(new.keys() - old.keys()), sorted(old.keys() - new.keys())
    changed = sorted(path for path in old.keys() & new.keys() if old[path] != new[path])
    differences = added + removed + changed

    def unchanged_subset(marker):
        return not any(marker in path for path in differences)

    checks = {
        "all_data_files_identical": not (added or removed or changed),
        "all_npz_files_identical": not any(Path(path).suffix == ".npz" for path in differences),
        "all_clean_geoparquet_files_identical": unchanged_subset("/clean/"),
        "dataset_bytes_identical": before["dataset_file_sha256"] == after["dataset_file_sha256"],
        "split_bytes_identical": before["split_file_sha256"] == after["split_file_sha256"],
        "test_pair_membership_identical": before["test_pair_membership_sha256"]
        == after["test_pair_membership_sha256"],
        "original_archive_identical": before.get("source_archive") == after.get("source_archive"),
    }
    return {
        "schema_version": "immutable-historical-data-comparison-v1",
        "status": "passed" if all(checks.values()) else "failed",
        "checks": checks,
        "before_file_count": len(old),
        "after_file_count": len(new),
        "npz_files": after["npz_files"],
        "clean_geoparquet_files": after["clean_geoparquet_files"],
        "added_files": added,
        "removed_files": removed,
        "changed_files": changed,
        "dataset_canonical_sha256": after["dataset_canonical_sha256"],
        "dataset_file_sha256": after["dataset_file_sha256"],
        "split_file_sha256": after["split_file_sha256"],
        "test_pair_membership_sha256": after["test_pair_membership_sha256"],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Read-only immutable historical-data verification; no training"
    )
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--archive")
    parser.add_argument("--output", required=True)
    parser.add_argument("--compare-with")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    if output.is_relative_to(Path(args.data_root).resolve()):
        raise SystemExit("Write verification receipts outside the immutable data directory")
    before = json.loads(Path(args.compare_with).read_text()) if args.compare_with else None
    archive = args.archive or ((before.get("source_archive") or {}).get("path") if before else None)
    if archive and output == Path(archive).expanduser().resolve():
        raise SystemExit("Verification output cannot replace the source archive")
    snapshot = snapshot_data_assets(args.data_root, archive)
    atomic_json(output, snapshot)
    if before:
        comparison = compare_data_snapshots(before, snapshot)
        atomic_json(output.with_name("data_immutability_comparison.json"), comparison)
        print(json.dumps(comparison, indent=2))
        if comparison["status"] != "passed":
            raise SystemExit(1)
    else:
        print(json.dumps({key: value for key, value in snapshot.items() if key != "files"}, indent=2))
