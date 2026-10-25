# Airplane Lake 2023: saved observation windows

Frozen seed 202, epoch 4, threshold 0.05. Post hoc target-only illustrative choice: among 11 sequences with exactly 3 saved pairs and at least 10 observed new-growth cells in each, sort by summed observed growth and sequence ID and choose the median (627 observed growth cells). Prediction quality played no role in selection. This is descriptive, not a new independent test.

The rows are independent saved forecasts initialized from successive ACTUAL observations on Aug 26–29, 2023. They are not recursive/simulated generations; no predicted perimeter is fed into the next row and no model inference was rerun. The panel has 105 reused groups / 303 pairs. Current gray cells are reference context; the raw target outline/revisions are preserved, not silently unioned into truth.

| Window | Observed growth cells | Predicted growth cells | TP / FP / FN | Observed growth km² | Predicted growth km² |
|---|---:|---:|---:|---:|---:|
| 1 | 85 | 533 | 52 / 481 / 33 | 1.0285 | 6.4493 |
| 2 | 91 | 250 | 46 / 204 / 45 | 1.1011 | 3.0250 |
| 3 | 451 | 253 | 108 / 145 / 343 | 5.4571 | 3.0613 |

All panels share the same projected grid and 110 m cells. Target geometric coverage/outside area and UTC window durations are recorded in the JSON and map. Original aggregate metrics remain unchanged.
