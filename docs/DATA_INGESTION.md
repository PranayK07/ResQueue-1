# Independent Codex NIROPS ingestion

This pipeline reads historical observations. It does not train a model, download
data, run code packaged in the archive, interpolate observation times, or alter
the source archive. All artifacts are isolated under `data/codex` in the Codex
worktree. Synthetic fixtures used by tests are explicitly separate.

## Reuse and verify the immutable dataset

The supervised forecaster reuses `data/codex` unchanged. Do not rebuild, relabel,
relocate or regenerate arrays, cleaned observations or partitions for this model
change. All source files remain read-only; receipts are written outside the data
folder. From the repository root:

```bash
PYTHONPATH=agents python -m rescue.forecast_ml.provenance \
  --data-root data/codex \
  --compare-with reports/wildfire_forecast/data_immutability_before.json \
  --output reports/wildfire_forecast/data_immutability_after.json
PYTHONPATH=agents python -m pytest -q \
  tests/test_forecast_data.py tests/test_forecast_data_guard.py
```

The verifier hashes every existing data file and the original ZIP, including all
1,077 NPZ arrays and 737 cleaned GeoParquet files. The comparison receipt lists
any changed, added or removed files and fails on a mismatch. It never invokes a
model, optimizer or parameter fitting. This migration does not rerun ETL.

`build_dataset` remains available for explicitly requested future dataset
versions. An existing completed manifest is returned unchanged. Absolute NPZ
paths form part of the frozen manifest, so relocation is a versioned data
operation, not an automatic part of installing or training a model.

## Actual source and audit

The original archive SHA-256 is
`2eee127eb733696deab8657bd6fb95560f380c696c0cd8b5901512b947fa6c21`.
Both outer and nested ZIP CRC checks were executed successfully. Preflight and
selected extraction took 522.383 seconds; the subsequent hash verification,
cleaning, grouping and raster preparation took 300.561 seconds. The combined
observed preparation time was 822.944 seconds, before any model training.
The parent-group correction subsequently rebuilt metadata and arrays in 287.319
seconds; unchanged NPZ hashes were independently checked afterward. Original
archive preflight is reused, not represented as a newly executed CRC check.

Only `NIROPS_2020_2024_R1_R6.zip` and its five shapefile companions are extracted.
The outer archive also contains maps, area progression material and code; these
are inventoried and not executed. ZIP traversal, absolute paths, Windows path
separators, symlinks, encrypted entries, duplicate entry names, excessive declared
expansion and suspicious compression ratios are rejected. Limits are 10,000
entries and 16 GiB expanded per archive. Extraction streams files rather than
loading the multi-gigabyte source into memory.

| Item | Observed result |
|---|---:|
| Original rows | 12,706 |
| Accepted rows | 12,704 |
| Quarantined conflicting same-component acquisition rows | 2 |
| Invalid geometries repaired | 288 |
| Exact duplicate rows removed | 0 |
| Components | 737 |
| Canonical parent incident groups after source-parent correction | 676 |
| Groups with multiple components | 38 |
| Train / validation / test groups after correction | 458 / 111 / 107 |
| Train / validation / test sequences | 724 / 197 / 156 |
| Train / validation / test adjacent transitions | 7,095 / 1,809 / 1,785 |
| Selected final-test transitions | 303 from 105 eligible groups |
| Accepted observations outside an admissible sequence | 938 |

The archive actually contains 12,706 rows, rather than the published 12,705. No
row was invented or dropped to force agreement with that publication. Source
observations by acquisition year are 2,333 (2020), 3,223 (2021), 2,030 (2022),
1,383 (2023), and 3,737 (2024). Region is **unknown** because no explicit region
field is supplied; geographic coordinates alone are not silently relabeled as
an authoritative region taxonomy.

For evaluation strata, the separate `analysis_metadata.json` sidecar derives
`source_jurisdiction:XX` from an explicit US state prefix in `Incident_C`, with
hyphen or underscore separators. It does not change the frozen dataset or
training features. Jurisdiction is not a USFS region or a polygon/state
intersection. All 737 components have such a jurisdiction prefix: AZ 71, CA 146,
CO 25, ID 119, MT 77, NM 37, NV 19, OR 150, UT 20, WA 64 and WY 9. A separate
comparison found all 12,706 `DateUTC` dates agree with the full `UTC` acquisition
date; date-only values were not substituted into acquisitions or used to remove
rows. The preserved sidecar is not rewritten during migration. If a separate analysis
receipt is needed, write it outside the immutable data directory:

```bash
PYTHONPATH=agents python -m rescue.forecast_ml.data_audit \
  --dataset data/codex --output reports/wildfire_forecast/analysis_metadata.json
```

The inspected layer is EPSG:4326 and has actual fields `Incident_C`, `UTC`,
`DateUTC`, `Acres`, `IRWINID`, `Inc Name`, and `Inc Number`. Field names with
spaces are handled explicitly. All actual IRWIN identifiers parsed as nonzero
UUIDs; no missing-identifier fallback was needed. Credible individual identifiers
do not establish parent-complex independence. The corrected graph joins 12 sets
with distinct child IRWIN IDs;
those sets retain an explicit multiple-identifier quality flag.

The [dataset description](https://data.mendeley.com/datasets/95rj5d379g/1)
describes interpreted active extents, reconstructed timestamps in some cases and
incomplete burned-area coverage. Its count of 737 source events is not proof of
737 independent parent complexes. The referenced research-paper full text could
not be retrieved through its publisher access redirect during this audit; no
paper-specific identifier definition is asserted without inspection.

## Observation cleaning and provenance

`UTC` must contain a full clock time and parse as UTC. `DateUTC` is retained as
a raw attribute, never substituted for an exact acquisition. Acquisition is
stored as absolute Unix seconds. Source timestamps may have been reconstructed;
row-specific timestamp confidence is unknown. Actual information-release times
are unavailable and stored separately as missing values. The benchmark assumes
an observation is available at its acquisition time. This idealized assumption
does not establish operational information availability. A later observed flight
gap is a requested prediction horizon, not a claim that the next flight time
would have been known operationally.

Each source row receives a stable SHA-256 ID from archive hash, layer name and
zero-based source feature ID. Component GeoParquet files retain original
attributes and original geometry WKB, alongside repaired geometry, acceptance,
quality flags, source IDs, parent group and split. Invalid geometries use
Shapely `make_valid`; polygonal pieces of a geometry collection are combined
spatially within that observation. No union across observation times occurs.
Conflicting geometries at one component/acquisition are quarantined together;
identical WKB duplicates retain one record with exclusions recorded separately.

`raw/inventory.json`, `exclusions.json`, `sequence_omissions.json`, and
`component_audit.json` preserve reasons and provenance. `dataset_audit.json` and
the six-panel audit PNG expose years, durations, gaps, raw area changes and
fixed-domain clipping. Negative area changes remain visible in both source and
targets; they are not repaired into monotone growth.

A read-only audit of all 1,077 arrays verified 11,766 sequence observations plus
938 recorded omissions equal 12,704 accepted rows. Of 10,689 adjacent transitions,
8,847 lie in the primary 12–36 hour bucket, 91 in [6,12) hours and 1,751 in
(36,72] hours. There are 2,161 transitions losing prior-positive raster cells
(34,707 lost cells in total), and 806 transitions with decreasing projected
polygon area. Initially affected cells are left-censored; 14,737,849 cells never
appear affected across their sequence and are right-censored. These cell counts
are per sequence grid, not unique geographic locations or independent samples.

## Canonical groups and fixed split

Identifiers normalize Unicode, capitalization and punctuation. Components are
connected by the original `Incident_C` parent prefix before the first underscore,
credible shared nonzero UUID IRWIN identifiers, or formatted incident numbers.
Source-parent and incident-number tokens are scoped by the component's earliest
acquisition year. All-zero source-parent placeholders are excluded. This avoids
connecting recurring annual incident numbers across years while retaining
complex children whose individual IRWIN and incident numbers differ.
A conservative fallback uses year, state prefix and normalized incident name
and receives an ambiguity flag. Multiple overarching IRWIN IDs connected through
other identifiers stay together with an ambiguity flag instead of being declared
independent.

The canonical key consistently prefers the lexicographically smallest valid
`PARENT:<year>:<normalized_source_prefix>` token for every group, including groups
currently having one component; otherwise it uses `IRWIN:<UUIDHEX>`, then
`INC:<year>:<normalizednumber>`, then fallback tokens. This decision does not
depend on observed performance or on the number of eligible sequences. The colon
separating salt from key is part of the protocol:

```python
payload = f"NIROPS-FIRE-RL-BENCHMARK-V1:{canonical_group_key}".encode("utf-8")
u = int.from_bytes(sha256(payload).digest()[:8], "big") / 2**64
split = "train" if u < 0.70 else "validation" if u < 0.85 else "test"
```

Compatibility exception: the frozen salt `NIROPS-FIRE-RL-BENCHMARK-V1` and
schema `fire-rl-dataset-v1` retain their original bytes solely to preserve data
hashes and memberships. They do not select a model, imply a simulator-controller
workflow or authorize training. Renaming them would alter the immutable data.

These are deterministic hash thresholds, not an enforced stratified ratio. All
components and derived sequences inherit the parent group split. The manifest
stores every source-row → component → group association and identifier-link
evidence. Shared annual numbers without credible identity and missing identifiers
remain limitations to inspect when processing other archive versions.

The frozen final-test panel selects up to three observed adjacent transitions per
eligible group: earliest, middle and latest after sorting all group transitions
by issue time, component ID, sequence ID and start index. Selection uses no model
performance. Transitions are not independent fires. Groups lacking an admissible
primary sequence remain in the split manifest with their eligibility limitation.
There are 303 selected transitions across 105 eligible test groups; two test
groups have no primary sequence. These exact counts are also recorded in the
corrected audit and split manifest.

### Preserved source-parent data-quality correction

An earlier data audit found 12 source-parent/year sets with distinct child
identifiers, eight crossing partition boundaries. Diamond Complex and
HappyCamp/Titus were concrete examples. The parent graph was corrected and the
resulting 676-group split was frozen before this supervised package migration.
Every shared source parent/year now belongs to one group. This migration changes
no group, split, source row, geometry, raster, timestamp or selected pair.

The evidence is preserved in
`reports/wildfire_forecast/grouping_residual_audit.json` and earlier data-quality
receipts in `reports/wildfire_forecast/data_quality_history`. These files document
historical grouping decisions; they are not runtime dependencies of a forecasting
algorithm. Source-prefix relations remain conservative identity evidence rather
than proof of complete complex observation coverage.

## Sequences, grids and targets

A component's accepted observations are chronologically ordered. A sequence
ends wherever an adjacent actual gap lies outside 6–72 hours. Each primary
sequence requires at least three usable observations. Gaps are not rounded or
interpolated. The primary analysis bucket is 12–36 hours; 6–12 and 36–72 hours
are secondary buckets. Exact elapsed seconds remain attached to every pair.

Every sequence has one fixed 128 × 128 grid. Its **first visible observation
alone** determines UTM zone, projected center and extent. Margin is half the
initial maximum extent, bounded to 2–10 km. Meters per pixel is the smallest
10 m multiple covering the initial extent plus both margins, with a 10 m floor.
Later geometries never resize or center the domain. Row 0 is south, column 0 is
west; the raster affine has a positive northing increment. Rasterio uses
`all_touched=True`. Geographic cell lookup and centers use exact PyProj
transforms, compatible with the existing core `Grid` interface.

Masks contain the **raw observed component footprint** at each time. No target
is used in constructing a prior input or grid. A simulator may maintain an
ever-affected prediction state, but evaluation must retain these raw targets
and report losses caused by perimeter shrinkage or revisions. Cumulative source
targets are not generated implicitly.

`valid` denotes the fixed modeled domain, not a surveyed geographic fire-absence
mask. Within this component-footprint task, outside-perimeter cells in that
domain are treated as negative. This assumption does **not** establish that a
whole fire complex was observed, that another component is absent, or that a
resident is safe. Component sequences do not claim complete complex coverage.
Unknown region, historical weather, timestamp confidence and release time are
preserved explicitly. No wind, terrain, vegetation or moisture measurements
are fabricated. A zero-wind simulator benchmark is an assumption, not a
historical weather observation.

Later footprints may extend beyond the initial domain. Exact projected area,
in-domain area fraction and outside area are recorded for every observation.
Coverage is clipped to [0,1] only to remove floating-point roundoff of about
1e-14. Grids and masks are unchanged by that numeric cleanup. In this dataset,
3,606 sequence observations lose some area outside their initial domain, with
worst coverage about 1.05%. Consequently in-domain scores alone are incomplete
and must be interpreted alongside coverage. An observation missing fire at a
cell does not identify an exact arrival time; previously affected cells are
left-censored, first observed changes support intervals, and never observed
affected cells are right-censored within the observed sequence.

## Artifact and Python API contracts

`dataset.json` records schema version, source/clean/split/pair hashes, spatial
rules, missing modality assumptions and sequence metadata. Each NPZ contains
`masks: bool[T,128,128]`, `valid: bool[128,128]`, and
`times_s: float64[T]` absolute Unix seconds. `source_row_ids`, `source_fids`,
`acquisition_s`, separately missing `information_release_s`, grid metadata,
coverage and quality flags live in the sequence record. Arrays are read-only
when returned by the loader.

```python
from rescue.forecast_ml.data import load_dataset, load_sequences, load_sequence, grid_from_record

dataset = load_dataset("data/codex/dataset.json")
records = load_sequences("data/codex", split="validation")
sequence = load_sequence(records[0])  # retains all record metadata
grid = grid_from_record(sequence["grid"])
cell = grid.locate(*grid.center(0))   # returns0; row0south/column0west
```

The clean hash is a canonical JSON composite of accepted source IDs and all
GeoParquet content hashes. The split hash is SHA-256 of the exact pretty-printed
split manifest bytes. Pair membership is canonical compact sorted JSON SHA-256.
The dataset hash uses canonical JSON of its manifest excluding its own hash
field. These definitions are intentionally distinct and must not be substituted
for one another in comparisons. Across independent implementations, different
effective groups, target semantics, fixed domains or test pairs must be reported
as **NOT DIRECTLY COMPARABLE**, regardless of aggregate performance.

## Tests and boundaries

Inputs, targets, feature availability and the supervised feature schema are
specified in `DATA_FEATURE_SPECIFICATION.md`.

The synthetic tests cover exact hash splits, parent isolation, rejection of
zero UUIDs and placeholder parents, full timestamps, irregular sequence breaks,
ZIP traversal, atomic recovery of interrupted extraction,
projected cell round trips, south-up orientation, fixed-domain clipping,
geometry repair, conflict quarantine, raw nonmonotone masks, read-only arrays,
source preservation, date consistency and manifest-byte hashes. Separate
integration tests cover geographic bridge round trips, UTC/simulation clock
separation, coarse windows, pin preservation and committed-request exclusion.
They perform no optimizer steps.

The source archive contains no operational resident data. Historical perimeter
labels and any later synthetic resident-impact experiment remain separate.
NIROPS daily/irregular observations do not validate minute-level emergency
forecasting or replace emergency services.
