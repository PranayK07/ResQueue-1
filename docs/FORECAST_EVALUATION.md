# Supervised forecasting evaluation

Frozen parent-group partitions are458/111/107, with724/197/156 eligible sequences.
Training has7,095 real pairs. Validation uses316 predeclared pairs/109 groups.
The preserved test panel has303 earliest/middle/latest pairs/105 groups. Related
components and derived arrays stay together; no observation-level reshuffle occurs.

Inputs use actual UTC gaps. Targets are raw later footprints, including shrinkage
and revisions. No interpolated observations or midpoint arrival labels exist.
Initial-only UTM domains prevent future-bound leakage but clip later area, which
is reported separately. All-true valid masks describe the retained component grid;
they do not prove that cells outside an observed perimeter were surveyed and unburned.

Primary comparison uses0.5 for every method and incident-macro growth IoU on the
same actual-growth-positive pairs. Both-empty growth is undefined and counted;
no-growth false alarms remain reported. A separate U-Net operating point uses
the fixed validation-selected threshold, calculated from the same probability
maps. Test data never chooses a threshold or checkpoint.

Baselines are persistence, main physical simulation (nominal0.08m/s, zero
historical wind, synthetic fuel seed1,16 members), and growth extrapolation from
prior observations. All share cases/grids/information. The neural probability
head is deterministic, not a16-member ensemble.

Report accuracy, balanced accuracy, precision/recall/F1, probability ROC-AUC/AP,
Brier/log loss, ten-bin calibration, confusion/prevalence, growth/footprint IoU
and Dice, and spatial errors. Known-footprint retention can inflate overall
accuracy/AP; susceptible-domain and boundary analyses exclude current cells.
Single-class AUC/AP and zero-denominator metrics remain null.

Average within incidents before macro averaging.2,000 whole-incident bootstrap
draws use seed20261024 and preserve related pairs. Paired differences share exact
cases. Raw Parquet supports diagnostics/report regeneration without training.
Examples are fixed lexically before scoring, not selected by visual appeal.

The panel was inspected under the retired architecture. It is held-out from
supervised fitting but is **reused diagnostic evidence**, not a new confirmation
set. Future tuning should use training/validation and a fresh confirmation cohort.
Do not call303 observations independent fires or the PRD's200-fire rescue score.

Historical labels do not support exact arrival MAE/RMSE or rescue efficacy.
Fictional exposure/partial ordering/top-k/slack remain separate from route and
Lookahead contracts. Station stubs cannot establish completed handoffs or realized
vehicle availability.

## Frozen operating point requested after training

Seed 202, epoch 4 and its validation-selected **0.05** threshold are frozen.
The focused `frozen_operating_point` report treats 0.05 as the selected operating
point and 0.50 as a diagnostic. The original common-0.50 benchmark artifacts
remain unchanged for traceability. No new model inference, training, parameter
selection, threshold search or split changes occur in the focused analysis.

All methods use identical saved cases, current/target/valid masks and the same
threshold within each comparison. New-growth classification excludes currently
affected cells. All-defined growth IoU counts false positives on zero-growth
cases; both-empty cases are undefined. The original actual-growth-positive IoU
is also retained explicitly, with its narrower population. Probability-score
AUC/AP, Brier and calibration do not depend on the diagnostic threshold.

The predefined fire-front region is the valid, currently unburned raster cells
whose centers are within **1,000 meters** of the issue-time affected footprint.
It uses only the known current mask, grid resolution and validity; future
geometry never determines region eligibility. The protocol is written before
front metrics are calculated. Empty fronts and single-class slices remain
undefined where appropriate. Front prevalence and Brier supplement full-domain
metrics, with incident-macro and pooled quantities labeled separately.

The existing 105 test groups were already inspected in prior work. An untouched
test result cannot be recovered by re-evaluating or renaming them. The report
discloses that limitation; it does not create a new split or claim independent
confirmation. Retired forecasting predictions are unavailable for a matched
comparison, so no incompatible dispatcher or reconstructed score is included.

## Named fire progression example

The Airplane Lake fire (source `WA-OWF-000374`, 2023) has four observations and
three consecutive saved forecast windows from August 26–29 UTC. The visualization
uses those existing probabilities at the frozen 0.05 threshold. Every forecast
starts from the actual perimeter then available; predicted masks are never fed
forward as observations. The grid is unchanged at 128 × 128, 110 meters per cell.

This is an explicitly post hoc illustration selected using target growth size,
without reading model quality: require three saved pairs in one sequence and at
least ten observed growth cells in each, then select the median total growth
among the eleven eligible sequences. Its total is 627 cells. This visibility
rule does not change evaluation membership, training, model selection or any
threshold, and the example is not a representative statistical sample.
