"""Frozen-input checks use bytes and tiny fixtures; never perform model updates."""

import copy
import json
from pathlib import Path
import numpy as np
import pytest
from rescue.forecast_ml.provenance import (
    sha256,
    canonical_dataset_hash,
    freeze_inputs,
    assert_inputs_unchanged,
    FrozenInputsChanged,
    snapshot_data_assets,
    compare_data_snapshots,
)
from rescue.forecast_ml.data_audit import write_analysis_metadata


def fixture(tmp_path):
    groups = []
    records = []
    crosswalk = []
    for index, partition in enumerate(("train", "validation", "test")):
        group = f"group-{index}"
        component = f"component-{index}"
        ids = [f"row-{index}-{j}" for j in range(3)]
        array = tmp_path / f"{index}.npz"
        np.savez(array, masks=np.zeros((3, 2, 2), bool))
        groups.append({"group_id": group, "split": partition})
        records.append(
            {
                "sequence_id": f"seq-{index}",
                "group_id": group,
                "component_id": component,
                "split": partition,
                "source_row_ids": ids,
                "masks_path": str(array),
                "masks_sha256": sha256(array),
            }
        )
        crosswalk.extend(
            {"source_row_id": s, "component_id": component, "group_id": group, "split": partition}
            for s in ids
        )
    split = tmp_path / "split_manifest.json"
    split.write_text(
        json.dumps(
            {"groups": groups, "crosswalk": crosswalk, "counts": {"train": 1, "validation": 1, "test": 1}}
        )
    )
    value = {
        "schema_version": "fire-rl-dataset-v1",
        "sequences": records,
        "split_manifest_path": str(split),
        "split_manifest_sha256": sha256(split),
        "test_pairs": [
            {
                "sequence_id": "seq-2",
                "group_id": "group-2",
                "source_row_ids": ["row-2-0", "row-2-1"],
                "from_index": 0,
                "to_index": 1,
            }
        ],
        "test_pair_membership_sha256": "explicit-synthetic-membership",
    }
    path = tmp_path / "dataset.json"
    write(path, value)
    return path, value


def write(path, value):
    value["dataset_sha256"] = canonical_dataset_hash(value)
    path.write_text(json.dumps(value, indent=2))


def test_snapshot_distinguishes_canonical_and_file_hashes(tmp_path):
    path, value = fixture(tmp_path)
    snapshot = freeze_inputs(path, value)
    assert snapshot["dataset_canonical_sha256"] == value["dataset_sha256"]
    assert snapshot["dataset_file_sha256"] == sha256(path)
    assert snapshot["dataset_canonical_sha256"] != snapshot["dataset_file_sha256"]
    assert snapshot["isolation_verified"]
    assert_inputs_unchanged(snapshot)


@pytest.mark.parametrize("kind", ["metadata", "split", "sequence"])
def test_mutation_is_rejected_without_model_updates(tmp_path, kind):
    path, value = fixture(tmp_path)
    snapshot = freeze_inputs(path, value)
    changed = {
        "metadata": path,
        "split": Path(value["split_manifest_path"]),
        "sequence": Path(value["sequences"][0]["masks_path"]),
    }[kind]
    changed.write_bytes(changed.read_bytes() + b" ")
    with pytest.raises(FrozenInputsChanged, match="changed"):
        assert_inputs_unchanged(snapshot)


@pytest.mark.parametrize("kind", ["component", "source"])
def test_partition_isolation_rejects_overlapping_observations(tmp_path, kind):
    path, value = fixture(tmp_path)
    if kind == "component":
        value["sequences"][1]["component_id"] = value["sequences"][0]["component_id"]
    else:
        value["sequences"][1]["source_row_ids"][0] = value["sequences"][0]["source_row_ids"][0]
    write(path, value)
    with pytest.raises(ValueError, match="crosses"):
        freeze_inputs(path, value)


def test_sequence_and_split_declared_hashes_are_enforced(tmp_path):
    path, value = fixture(tmp_path)
    value["sequences"][0]["masks_sha256"] = "wrong"
    write(path, value)
    with pytest.raises(ValueError, match="sequence bytes"):
        freeze_inputs(path, value)
    value["split_manifest_sha256"] = "wrong"
    write(path, value)
    with pytest.raises(ValueError, match="split manifest"):
        freeze_inputs(path, value)


def test_metadata_change_between_load_and_freeze_is_rejected(tmp_path):
    path, value = fixture(tmp_path)
    changed = copy.deepcopy(value)
    changed["extra"] = "changed"
    write(path, changed)
    with pytest.raises(ValueError, match="changed while loading"):
        freeze_inputs(path, value)


def test_frozen_test_pair_source_identity_is_enforced(tmp_path):
    path, value = fixture(tmp_path)
    value["test_pairs"][0]["source_row_ids"][0] = "other"
    write(path, value)
    with pytest.raises(ValueError, match="source IDs"):
        freeze_inputs(path, value)


def test_full_asset_snapshots_detect_npz_clean_and_archive_changes(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    fixture(data)
    clean = data / "clean"
    clean.mkdir()
    # Byte-integrity fixture only; no claim these bytes are valid GeoParquet.
    (clean / "synthetic.parquet").write_bytes(b"synthetic integrity fixture")
    archive = tmp_path / "source.zip"
    archive.write_bytes(b"synthetic archive bytes")
    before = snapshot_data_assets(data, archive)
    assert compare_data_snapshots(before, snapshot_data_assets(data, archive))["status"] == "passed"
    (data / "0.npz").write_bytes(b"changed synthetic array")
    (clean / "synthetic.parquet").write_bytes(b"changed synthetic geometry bytes")
    archive.write_bytes(b"changed synthetic archive")
    difference = compare_data_snapshots(before, snapshot_data_assets(data, archive))
    assert difference["status"] == "failed"
    assert not difference["checks"]["all_npz_files_identical"]
    assert not difference["checks"]["all_clean_geoparquet_files_identical"]
    assert not difference["checks"]["original_archive_identical"]
    assert difference["checks"]["split_bytes_identical"]


def test_asset_snapshot_comparison_detects_added_or_removed_files(tmp_path):
    fixture(tmp_path)
    before = snapshot_data_assets(tmp_path)
    extra = tmp_path / "unexpected.json"
    extra.write_text("unexpected derived data")
    added = compare_data_snapshots(before, snapshot_data_assets(tmp_path))
    assert added["status"] == "failed" and len(added["added_files"]) == 1
    extra.unlink()
    (tmp_path / "0.npz").unlink()
    removed = compare_data_snapshots(before, snapshot_data_assets(tmp_path))
    assert removed["status"] == "failed" and len(removed["removed_files"]) == 1


@pytest.mark.parametrize("filename", ["dataset.json", "new_annotations.json"])
def test_analysis_writer_cannot_modify_immutable_data_tree(tmp_path, filename):
    dataset = tmp_path / "dataset.json"
    dataset.write_text('{"synthetic": true}')
    before = dataset.read_bytes()
    with pytest.raises(ValueError, match="outside the immutable"):
        write_analysis_metadata(dataset, tmp_path / filename)
    assert dataset.read_bytes() == before
    assert not (tmp_path / "new_annotations.json").exists()
