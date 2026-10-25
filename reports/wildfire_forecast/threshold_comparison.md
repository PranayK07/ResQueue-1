# Saved-probability threshold comparison

These are two threshold views of the same frozen neural probability maps. No inference, optimization or new model selection occurred. previously inspected; reused diagnostic panel.

## Full footprint, including known affected cells

| Threshold | Precision | Recall | F1 | Incident groups / pairs |
|---|---:|---:|---:|---:|
| 0.05 | 87.41% | 94.40% | 89.61% | 105 / 303 |
| 0.50 | 99.29% | 90.77% | 93.68% | 105 / 303 |

## New growth, excluding the starting footprint

| Threshold | Growth precision | Growth recall | Growth F1 (all defined) | Defined groups P / R / F1 | Original conditional growth IoU | Conditional growth Dice | Positive-target groups / pairs |
|---|---:|---:|---:|---:|---:|---:|---:|
| 0.05 | 16.04% | 56.40% | 16.76% | 105 / 102 / 105 | 15.08% | 23.92% | 102 / 211 |
| 0.50 | 43.25% | 4.92% | 5.16% | 86 / 102 / 104 | 3.23% | 5.38% | 102 / 211 |

The F1 column and conditional Dice have the same cell-level formula but different admitted pair populations. All-defined growth F1 includes false-positive predictions on no-observed-growth pairs; both-empty pairs are undefined. The original conditional IoU/Dice use the identical observed-growth-positive cases for both thresholds. The frozen operating-point report separately reports all-defined growth IoU and its confidence intervals. Metric-specific defined-group counts and raw confusion totals are in `threshold_comparison.json`.

High full-footprint precision/recall/F1 can be driven by retaining already known affected cells. They do not establish comparable new-growth accuracy. 0.50 remains the common primary threshold for every method; the other threshold was selected using validation and is reported separately.
