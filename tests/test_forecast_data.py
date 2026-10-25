"""Small synthetic ETL contracts; no training, network or real-person inputs."""

import hashlib
import json
import zipfile

import numpy as np
import pandas as pd
import pytest
from shapely.geometry import Polygon, box

from rescue.forecast_ml.archive import inspect_zip, prepare_archive
from rescue.forecast_ml.data_audit import source_annotations
from rescue.forecast_ml.data import (
    _runs,
    build_dataset,
    grid_from_record as exported_grid_from_record,
    load_sequence,
    make_groups,
    parse_acquisition,
    select_test_pairs,
    split_for,
)
from rescue.forecast_ml.spatial import grid_from_record, initial_domain, raster_geometry


def test_split_exact_hash_and_incident_isolation():
    key = "IRWIN:00112233445566778899AABBCCDDEEFF"
    u = (
        int.from_bytes(hashlib.sha256(("NIROPS-FIRE-RL-BENCHMARK-V1:" + key).encode()).digest()[:8], "big")
        / 2**64
    )
    part, value = split_for(key)
    assert value == u
    assert part == ("train" if u < 0.7 else "validation" if u < 0.85 else "test")
    data = pd.DataFrame(
        {
            "component_id": ["A", "B", "C"],
            "IRWINID": ["00112233-4455-6677-8899-aabbccddeeff"] * 2
            + ["00000000-0000-0000-0000-000000000000"],
            "Inc Number": ["CA-TST-001", "CA-TST-002", "CA-TST-003"],
            "Inc Name": ["Alpha", "Beta", "Gamma"],
            "Incident_C": ["CA-X-Alpha", "CA-Y-Beta", "CA-Z-Gamma"],
            "year": [2020] * 3,
        }
    )
    groups, mapping, _ = make_groups(data)
    assert len(groups) == 2 and mapping["A"]["group_id"] == mapping["B"]["group_id"]
    assert mapping["A"]["split"] == mapping["B"]["split"]
    assert not any("IRWIN:00000000000000000000000000000000" in g["identifier_tokens"] for g in groups)


def test_timestamp_not_date_only_and_irregular_runs():
    values = parse_acquisition(["2024-06-01 05:12:30", "2024-06-02", "not a timestamp"])
    assert values.notna().tolist() == [True, False, False]
    assert values[0].hour == 5 and str(values[0].tz) == "UTC"
    assert list(_runs(np.array([0, 6, 30, 110, 134, 158]) * 3600)) == [(0, 3), (3, 6)]


def test_archive_rejects_path_traversal(tmp_path):
    path = tmp_path / "bad.zip"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("../escape.shp", "bad")
    with pytest.raises(ValueError, match="unsafe"):
        inspect_zip(path)
    assert not (tmp_path / "escape.shp").exists()


def test_archive_rejects_ambiguous_duplicate_members(tmp_path):
    path = tmp_path / "duplicate.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("same.shp", "first")
        with pytest.warns(UserWarning, match="Duplicate name"):
            archive.writestr("same.shp", "second")
    with pytest.raises(ValueError, match="duplicate"):
        inspect_zip(path)


def test_fallback_identity_is_conservative_and_annual_numbers_do_not_leak():
    rows = pd.DataFrame(
        {
            "component_id": ["A", "B", "C", "D"],
            "IRWINID": ["missing"] * 4,
            "Inc Number": ["UNKNOWN", "UNKNOWN", "CA-TST-001", "CA-TST-001"],
            "Inc Name": ["Alpha", "Alpha", "Beta", "Beta"],
            "Incident_C": ["CA-A", "CA-B", "CA-C", "CA-D"],
            "year": [2024, 2024, 2023, 2024],
        }
    )
    groups, mapping, _ = make_groups(rows)
    assert len(groups) == 3
    assert mapping["A"]["group_id"] == mapping["B"]["group_id"]
    assert mapping["A"]["quality_flags"] == ["fallback_identity_ambiguous"]
    assert mapping["C"]["group_id"] != mapping["D"]["group_id"]


def test_explicit_complex_parent_links_distinct_child_irwin_and_incident_numbers():
    # Regression: DiamondComplex child IDs differ; HappyCamp/Titus does too.
    rows = pd.DataFrame(
        {
            "component_id": ["LEMOLO", "LOAFER", "HAPPYCAMP", "TITUS", "NEXTYEAR"],
            "IRWINID": [f"00000000-0000-0000-0000-{i:012x}" for i in range(1, 6)],
            "Inc Number": [
                "OR-UPF-240258",
                "OR-UPF-240283",
                "CA-KNF-007022",
                "CA-KNF-006950",
                "OR-UPF-250258",
            ],
            "Inc Name": ["Lemolo", "Loafer", "Happy Camp Complex", "Titus", "Different annual incident"],
            "Incident_C": [
                "OR-UPF-000303_DiamondComplex_Lemolo",
                "OR-UPF-000303_DiamondComplex_Loafer",
                "CA-KNF-007022_HappyCampEast",
                "CA-KNF-007022_Titus",
                "OR-UPF-000303_NewFire",
            ],
            "year": [2024, 2024, 2023, 2023, 2025],
        }
    )
    groups, mapping, _ = make_groups(rows)
    assert len(groups) == 3
    assert mapping["LEMOLO"]["group_id"] == mapping["LOAFER"]["group_id"]
    assert mapping["HAPPYCAMP"]["group_id"] == mapping["TITUS"]["group_id"]
    assert mapping["LEMOLO"]["canonical_group_key"] == "PARENT:2024:ORUPF000303"
    assert mapping["LEMOLO"]["group_id"] != mapping["NEXTYEAR"]["group_id"]
    for (_, _), linked in rows.groupby(["year", rows.Incident_C.str.split("_").str[0]]):
        assert len({mapping[c]["group_id"] for c in linked.component_id}) == 1


def test_placeholder_parent_number_does_not_merge_distinct_child_fires():
    rows = pd.DataFrame(
        {
            "component_id": ["A", "B"],
            "IRWINID": ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"],
            "Inc Number": ["MT-FNF-000535", "MT-FNF-000536"],
            "Inc Name": ["Alpha", "Beta"],
            "Incident_C": ["MT-FHF-000000_Alpha", "MT-FHF-000000_Beta"],
            "year": [2023, 2023],
        }
    )
    groups, _, _ = make_groups(rows)
    assert len(groups) == 2
    assert all(not t.startswith("PARENT:") for g in groups for t in g["identifier_tokens"])


def test_analysis_sidecar_distinguishes_jurisdiction_and_date_disagreement():
    frame = pd.DataFrame(
        {
            "Incident_C": ["OR-UPF-000303_Lemolo", "CA_SLU_009866_Pond", "ZZ-NOT-ASTATE"],
            "UTC": ["2024-01-01 23:45:00", "2024-01-02 00:15:00", "missing"],
            "DateUTC": ["2024-01-01", "2024-01-01", "2024-01-03"],
        }
    )
    before = frame.copy(deep=True)
    result = source_annotations(frame, "frozen-hash")
    quality = result["dateutc_fullutc_quality"]
    assert quality["dates_agree"] == quality["dates_disagree"] == quality["unknown_comparison"] == 1
    assert quality["disagreement_rows"][0]["source_fid"] == 1
    assert result["components"]["CASLU009866POND"]["source_jurisdiction"] == "source_jurisdiction:CA"
    assert result["components"]["ZZNOTASTATE"]["source_jurisdiction"] == "unknown"
    assert all(r["official_usfs_region"] == "unknown" for r in result["components"].values())
    pd.testing.assert_frame_equal(frame, before)


def test_frozen_pairs_select_globally_across_parent_components():
    records = []
    for name, times in [("A", [0, 8, 16]), ("B", [2, 10, 18])]:
        records.append(
            {
                "sequence_id": name,
                "group_id": "parent",
                "component_id": name,
                "split": "test",
                "acquisition_s": times,
                "source_row_ids": [name + str(i) for i in range(3)],
                "year": 2024,
                "region": "unknown",
            }
        )
    selected = select_test_pairs(records)
    assert [pair["issue_s"] for pair in selected] == [0, 8, 10]
    assert len({p["pair_id"] for p in selected}) == 3
    assert {p["group_id"] for p in selected} == {"parent"}


def test_projected_grid_south_up_roundtrip_and_fixed_domain():
    geom = box(-121.01, 38.99, -121.0, 39.0)
    grid = initial_domain(geom)
    mask, coverage, area = raster_geometry(geom, grid)
    assert grid.rows == 128 and grid.cols == 128 and mask.any() and coverage == pytest.approx(1)
    for cell in [0, 127, 128, 16383, 8129]:
        assert grid.locate(*grid.center(cell)) == cell
    lat_s, _ = grid.center(0)
    lat_n, _ = grid.center(127 * 128)
    assert lat_n > lat_s and grid.affine.e > 0 and area > 0
    assert grid_from_record(grid.__dict__) == grid
    assert exported_grid_from_record(grid.__dict__) == grid
    assert 0 <= coverage <= 1
    before = grid.__dict__.copy()
    _, later_cover, _ = raster_geometry(box(-122, 38, -120, 40), grid)
    assert later_cover < 1 and grid.__dict__ == before


def _fixture_archive(tmp_path):
    import geopandas as gpd

    directory = tmp_path / "shape"
    directory.mkdir()
    # The repeated12h timestamp conflicts. Both are quarantined, leaving0/6/18h.
    geometries = [
        Polygon([(-121, 39), (-120.99, 39.01), (-121, 39.01), (-120.99, 39), (-121, 39)]),
        box(-120.998, 39.002, -120.997, 39.003),
        box(-121, 39, -120.99, 39.01),
        box(-121, 39, -120.985, 39.015),
        box(-121, 39, -120.98, 39.02),
    ]
    frame = gpd.GeoDataFrame(
        {
            "Incident_C": ["CA-TST-001_Alpha"] * 5,
            "UTC": [
                "2024-01-01 00:00:00",
                "2024-01-01 06:00:00",
                "2024-01-01 12:00:00",
                "2024-01-01 12:00:00",
                "2024-01-01 18:00:00",
            ],
            "DateUTC": ["2024-01-01"] * 5,
            "Acres": [1.0] * 5,
            "IRWINID": ["00112233-4455-6677-8899-aabbccddeeff"] * 5,
            "Inc Name": ["ALPHA"] * 5,
            "Inc Number": ["CA-TST-001"] * 5,
        },
        geometry=geometries,
        crs=4326,
    )
    frame.to_file(directory / "NIROPS_2020_2024_R1_R6.shp", engine="pyogrio")
    nested = tmp_path / "NIROPS_2020_2024_R1_R6.zip"
    with zipfile.ZipFile(nested, "w") as z:
        for p in directory.iterdir():
            z.write(p, "NIROPS_2020_2024_R1_R6/" + p.name)
    outer = tmp_path / "fixture.zip"
    with zipfile.ZipFile(outer, "w") as z:
        z.write(nested, "fixture/" + nested.name)
    return outer


def test_real_etl_contract_with_labeled_synthetic_geometry(tmp_path):
    import geopandas as gpd

    source = _fixture_archive(tmp_path)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    manifest = build_dataset(source, tmp_path / "data", tmp_path / "report")
    assert manifest["source_count"] == 5 and manifest["accepted_count"] == 3
    assert len(manifest["sequences"]) == 1
    sequence = load_sequence(manifest["sequences"][0])
    assert sequence["masks"].shape == (3, 128, 128) and sequence["valid"].shape == (128, 128)
    assert sequence["masks"][1].sum() < sequence["masks"][0].sum()  # no forced temporal union
    assert not sequence["masks"].flags.writeable
    assert sequence["acquisition_s"][1] - sequence["acquisition_s"][0] == 21600
    cleaned = gpd.read_parquet(next((tmp_path / "data" / "clean").glob("*.parquet")))
    assert cleaned.geometry.is_valid.all() and cleaned.geometry_repaired.sum() == 1
    assert cleaned.raw_geometry_wkb.notna().all()
    assert cleaned.information_release_s.isna().all()
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before
    assert (
        manifest["split_manifest_sha256"]
        == hashlib.sha256((tmp_path / "data" / "split_manifest.json").read_bytes()).hexdigest()
    )
    audit = json.loads((tmp_path / "report" / "dataset_audit.json").read_text())
    assert audit["counts"]["conflicting_same_time"] == 2


def test_interrupted_extraction_never_promotes_partial_companion(tmp_path):
    source = _fixture_archive(tmp_path)
    raw = tmp_path / "raw"
    raw.mkdir()
    partial = raw / "NIROPS_2020_2024_R1_R6.shp"
    partial.write_bytes(b"interrupted previous extraction")
    receipt = prepare_archive(source, raw)
    assert receipt["outer_crc"] == receipt["nested_crc"] == "passed"
    assert partial.stat().st_size > 100
    assert not list(raw.glob("*.partial"))
    partial.write_bytes(b"later corruption")
    with pytest.raises(ValueError, match="checksum"):
        prepare_archive(source, raw)
