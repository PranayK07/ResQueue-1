# Validation boundary audit

Saved validation predictions only. No weights were loaded; no inference, training, loss configuration change or threshold tuning occurred. Primary/final-test artifacts are unchanged. Source SHA-256: `dee0cd3a647efe358980e4bd6013440b3a338ef01c4627e47ba3dcbcf1f38774`.

Bands are fixed before scoring: 0–300 m, 300–1000 m, 1000–3000 m, and >3000 m outside the known footprint, inside valid cells. Distances use projected meters and native raster-cell centers. A 400 m pixel can leave the0–300m band empty; this is undefined evidence, not zero error. These are not exact polygon-front distances; spatial uncertainty is of order the meters-per-pixel value.

| Method | Pooled predicted / actual growth | Pooled FP / actual growth | Median PAIR predicted / actual | Mean INCIDENT pair-ratio | No-growth pairs with FP / all no-growth pairs |
|---|---:|---:|---:|---:|---:|
| Persistence | 0.000 | 0.000 | 0.000 | 0.000 | 0 / 90 |
| Physical ensemble | 68.166 | 67.167 | 262.264 | 1750.271 | 89 / 90 |
| Growth extrapolation | 0.338 | 0.287 | 0.000 | 2.659 | 2 / 90 |
| Time-conditioned U-Net | 0.058 | 0.038 | 0.007 | 0.760 | 9 / 90 |

Pooled ratios divide summed physical areas over all forecast pairs. Pairwise medians use positive-growth pairs. Incident-macro ratios first average eligible pair ratios within incident and then average incidents; tiny positive denominators can greatly inflate these means. Existing *_median JSON fields are medians of INCIDENT MEANS, not medians across pairs; explicit pairwise_*_median fields avoid ambiguity. Zero target growth gives an undefined individual ratio even when false growth is large; these pairs are counted separately.

Near-band U-Net AP: 0.3307 on 100 groups/213 AP-defined pairs. Near-band prevalence: 0.1262 on 105 groups. Their different undefined-slice populations prevent directly comparing those two means. AP-defined-population prevalence is 0.1765. All metric-defined pair/group counts are saved. One-class AP/AUC are never assigned invented values.

Confusions, prevalence, precision, recall, Brier, probability-score AP/AUC and 2,000 whole-incident bootstrap intervals are in `boundary_metrics.json`, separately for all four methods and bands. Known initial affected cells are excluded. The examples are the three lowest lexical validation pair IDs: ['00307d2e148387c651f6c8a6c6d765f5bbd7a6222c06b033519c3f0b30e9ebd2', '00a0cce8039eaece1ae8a83624f3a1ba69f346ae0d2fe9a8fcc53977ea62fb6b', '00f7d765ec66a93961139f0e9a64aa1c3392c3df69a7bbe0010a4ae627c30a12']. Each shows observed new growth, U-Net probability, false/missed growth and predicted-area comparisons on identical domains.

Large false-positive ratios quantify overprediction; they do not prove one root cause. Fixed-domain clipping, irregular raw labels and missing historical weather/fuel still limit interpretation. No new model selection follows this analysis.
