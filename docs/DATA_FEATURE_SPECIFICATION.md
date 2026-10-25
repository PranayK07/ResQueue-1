# Supervised wildfire forecasting: data and feature specification

The active model is a supervised time-conditioned U-Net. Historical NIROPS
perimeters supply observed input/target pairs; the model predicts geographic
footprint growth. Resident exposure and deterministic rescue scheduling consume
forecast products separately. Neither resident demand nor rescue outcomes are
training features or historical labels.

## Immutable historical records

`data/codex/dataset.json` and its source archive, GeoParquet observations, masks
and group split remain unchanged. The before/after byte proof is
`reports/wildfire_forecast/data_immutability_comparison.json`; it covers all 1,828
data files, including 1,077 NPZ arrays and 737 cleaned GeoParquet files, plus the
original downloaded archive. No data rebuild occurs during this migration.

| Asset | Definition |
|---|---|
| Accepted observations | 12,704 original observations after two conflicting rows are quarantined |
| Parent groups | 676 conservative source-parent/year and credible-identifier groups |
| Split | 458 training / 111 validation / 107 test groups |
| Adjacent pairs | 7,095 training / 1,809 validation / 1,785 test |
| Selected test panel | 303 fixed pairs across 105 eligible test groups |
| Stored masks | Raw observed component footprint, `bool[T,128,128]` |
| Stored validity | Fixed modeled-domain mask, `bool[128,128]` |
| Stored time | UTC Unix seconds, `float64[T]` |
| Position | Explicit local UTM CRS, southwest projected origin, meters per pixel |

The frozen salt `NIROPS-FIRE-RL-BENCHMARK-V1` and dataset schema
`fire-rl-dataset-v1` remain compatibility identifiers only. They are not model
choices or training authorization. Their original spelling preserves manifest
hashes and incident-group memberships.

All components, observations and samples from a parent share its partition.
Normalization, class counts and any fitted preprocessing use training records
only. Validation selects checkpoints and a declared decision threshold. The
fixed held-out panel has been inspected during earlier project work; preserving
its bytes does not make a later evaluation an untouched new experiment. Reports
must disclose reuse and must not adjust the split or targets to improve scores.

## One example at issue time

For accepted consecutive observations at actual times `T_i < T_j`, where
`j = i + 1` and `6h <= T_j - T_i <= 72h`:

- Input is the observed mask at `T_i`, an optional prior observed mask at
  `T_(i-1)`, their actual preceding gap, requested future horizon, grid and
  availability mask.
- Target is the raw observed mask at `T_j`. New-growth truth is
  `target & ~current & valid`.
- The target mask, future environmental measurements and final fire bounds do
  not enter feature construction. The requested horizon is a retrospective
  query; actual future flight timing would not necessarily be known operationally.

No intermediate polygons are interpolated and labeled as observations. The
stored sequence requirement of at least three observations is preserved for
compatibility; a supervised sample uses one adjacent observed pair and optional
known prior context. Sampling does not turn derived pairs into independent fires.

## Exact current feature schema

`rescue.forecast_ml.unet.FEATURE_SCHEMA` is
`wildfire-supervised-known-perimeters-v2`. `known_features` is the shared pure
feature builder used by `ForecastPairDataset` and frozen inference. It has **no
target argument**. Output is `float32[8,128,128]`, channel first, row zero south
and column zero west.

| Channel | Name | Definition and units |
|---:|---|---|
| 0 | `current` | Last observed affected footprint intersected with valid domain; 0 or 1 |
| 1 | `previous` | Prior observed footprint intersected with valid domain; zero when absent |
| 2 | `observed_growth` | `current & ~previous` when prior history exists; zero when absent |
| 3 | `valid` | Fixed modeled-domain membership; 0 or 1 |
| 4 | `horizon_hours` | Requested elapsed seconds divided by 3,600, then train-standardized and broadcast spatially |
| 5 | `previous_gap_hours` | Actual preceding observed gap divided by 3,600; zero raw gap when history is absent; train-standardized |
| 6 | `meters_per_pixel` | Projected cell size in meters, train-standardized and broadcast spatially |
| 7 | `history_available` | Explicit 0/1 spatial plane indicating whether prior context exists |

Binary channels are already in [0,1]. The three continuous values use pair-weighted
means and standard deviations computed on eligible training pairs only. Scale
floors are 1 hour, 1 hour and 10 meters, respectively; standardized values are
clipped to [-10,10]. Frozen inference reloads those exact means/scales. Absence
is not encoded as a fabricated prior perimeter: previous and recent-growth
channels are zero and the availability plane is zero.

The current network is width 16, depth 3, with eight input channels. Its training
configuration is separate from these immutable observations; architecture or
feature-schema changes require a new model artifact and do not rewrite data.

## Targets, loss domain and output semantics

The model produces a new-growth logit per cell. The supervised loss domain is
`valid & ~current`: weighted binary classification plus a fixed spatial growth
overlap term. Positive-class weighting is calculated from training labels only.
The model owner documents optimizer/loss configuration and validation selection
in the model run receipt; no fitting is performed by the data loader.

Cumulative inference retains the observed footprint. An analytic weighted-BCE
prior correction is applied to logits using the frozen train class weight. This
is only approximate with an auxiliary overlap loss, so calibration must be
evaluated rather than assumed. The result is a probability head, not an ensemble
of independently simulated fires.

Raw observed footprints may shrink or be revised. The target is never changed
to a temporal union. Previously positive cells that disappear remain errors in
full-footprint evaluation even though they are outside the growth-head loss.
New-growth metrics must be reported separately from retention of known cells.

Supported requested horizons are 6–72 hours, with 12–36 hours the primary analysis
bucket. A cumulative-max projection across requested horizons enforces logical
monotonicity; it does not establish a calibrated joint arrival distribution.
One horizon supplies a coarse issue-to-horizon window or censoring, never a
precise historical minute of fire arrival.

## Spatial and label-quality limitations

The fixed 128×128 domain uses only the sequence's first visible observation.
Local UTM meters, bounded initial margin and `all_touched=True` rasterization
are preserved. Later target extent never chooses a convenient grid. Geographic
resident lookup must use the same declared CRS, origin and resolution; incoming
degree-valued or inconsistent origins must be rejected, not treated as meters.

All stored valid cells are modeled footprint-membership cells. An exterior
negative does not certify surveyed absence of fire or complete complex coverage.
Later observed area outside the initial grid is recorded separately; in-domain
scores must be presented with clipping counts and geometric coverage. Original
geometry and raw WKB remain available for audit.

Acquisition time is distinct from information-release time. Release is unknown,
source reconstruction confidence is unknown, and acquisition-time availability
is an explicitly idealized assumption. First observed affected membership gives
interval-censored information. Initially affected cells are left-censored;
never-observed-affected cells are right-censored within the observed sequence.

## Optional modalities and missingness

The present dataset/model is perimeter-only. No time-matched historical weather,
vegetation, fuel moisture or terrain measurements are supplied as learned inputs.
Source attributes and feature names establish this explicitly. Source maps or
archive code are not interpreted as measured environmental arrays.

The preserved analysis sidecar contains source-jurisdiction labels and date
quality annotations for reporting, not model channels. Jurisdiction is an
incident identifier prefix, not an authoritative USFS region or an actual
polygon/state intersection. Adding a modality in future requires an explicit
feature schema, release-time availability checks and missingness indicators.
It cannot be silently filled with invented measurements.

## Loader and integrity APIs

```python
from rescue.forecast_ml.data import load_dataset, load_sequences, load_sequence
from rescue.forecast_ml.provenance import freeze_inputs, assert_inputs_unchanged

dataset = load_dataset("data/codex/dataset.json")
snapshot = freeze_inputs("data/codex/dataset.json", dataset)
record = load_sequences("data/codex", split="train")[0]
sequence = load_sequence(record)  # all metadata retained; arrays read-only
assert_inputs_unchanged(snapshot)
```

The integrity guard verifies canonical manifest identity, exact file/split/NPZ
hashes, component/source/group isolation and selected pair source IDs. The
separate full-asset snapshot also verifies raw and cleaned files and the source
archive. Neither helper updates model parameters, rewrites labels or grants
permission to train.
