# Frozen supervised operating-point diagnostics

Seed 202 / epoch 4 / threshold 0.05 is frozen from validation. Threshold 0.50 is a fixed diagnostic only. Both thresholds apply to every method. The same 303 pairs / 105 incident groups and saved probability maps are reused; no model was loaded or rerun. This panel was previously inspected and is diagnostic evidence.

Growth means valid cells outside the CURRENT issue-time affected footprint. The single predefined front additionally requires center-to-current-affected-center EDT distance≤1000m. Empty fronts remain empty; large cells are never forced into the band. No target selects the region.

Values below are incident macros with 95% percentile CIs from 2,000 whole-group bootstrap draws. Pair means precede group means. Undefined metrics stay null and have explicit counts in JSON. Pooled metrics/calibration bins and raw pair/group sufficient statistics are saved separately in this folder.

Paired differences first intersect metric-specific common-defined PAIRS, then average within incidents. They need not equal subtraction of the displayed per-model all-defined macros. For example, persistence's both-empty no-growth pairs have undefined IoU/F1, so their exclusion narrows the paired population while each model's own all-defined macro still counts its no-growth false alarms. Defined pair and group counts accompany every comparison.

## Threshold 0.05: front_1000m

| Method | Precision | Recall | F1 | ROC-AUC | AP | Brier | ECE | Growth prevalence | IoU all defined | IoU positive-target |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| persistence | undefined | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.5000 [0.5000, 0.5000] | 0.1050 [0.0816, 0.1314] | 0.0635 [0.0502, 0.0774] | 0.0635 [0.0502, 0.0774] | 0.0635 [0.0502, 0.0774] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] |
| existing_physical | 0.0635 [0.0502, 0.0774] | 1.0000 [1.0000, 1.0000] | 0.0989 [0.0807, 0.1180] | 0.4999 [0.4998, 0.5000] | 0.1050 [0.0816, 0.1314] | 0.9365 [0.9226, 0.9498] | 0.9365 [0.9226, 0.9498] | 0.0635 [0.0502, 0.0774] | 0.0635 [0.0502, 0.0774] | 0.1050 [0.0816, 0.1314] |
| growth_extrapolation | 0.2492 [0.1589, 0.3479] | 0.0597 [0.0368, 0.0865] | 0.0298 [0.0169, 0.0446] | 0.5192 [0.5108, 0.5288] | 0.1127 [0.0887, 0.1386] | 0.0758 [0.0603, 0.0926] | 0.0758 [0.0603, 0.0926] | 0.0635 [0.0502, 0.0774] | 0.0194 [0.0107, 0.0296] | 0.0202 [0.0111, 0.0307] |
| unet | 0.1615 [0.1376, 0.1858] | 0.6137 [0.5718, 0.6568] | 0.1829 [0.1598, 0.2074] | 0.8500 [0.8276, 0.8719] | 0.3229 [0.2840, 0.3619] | 0.0545 [0.0442, 0.0656] | 0.0555 [0.0453, 0.0665] | 0.0635 [0.0502, 0.0774] | 0.1182 [0.1021, 0.1354] | 0.1741 [0.1513, 0.1972] |

| Method | Pooled prevalence | Pooled Brier | Pooled ECE | Cells | Positive cells | TP / FP / FN / TN | Empty / no-growth / both-empty pairs |
|---|---:|---:|---:|---:|---:|---|---|
| persistence | 0.0547 | 0.0547 | 0.0547 | 784319 | 42871 | 0 / 0 / 42871 / 741448 | 1 / 91 / 91 |
| existing_physical | 0.0547 | 0.9453 | 0.9453 | 784319 | 42871 | 42871 / 741448 / 0 / 0 | 1 / 91 / 0 |
| growth_extrapolation | 0.0547 | 0.0734 | 0.0734 | 784319 | 42871 | 8343 / 23065 / 34528 / 718383 | 1 / 91 / 87 |
| unet | 0.0547 | 0.0468 | 0.0281 | 784319 | 42871 | 23623 / 64299 / 19248 / 677149 | 1 / 91 / 2 |

| U-Net minus baseline | Metric | Paired macro difference [95% CI] | Defined groups / pairs |
|---|---|---:|---:|
| persistence | precision | undefined | 0 of 105 groups; 0 of 303 pairs |
| persistence | recall | 0.6137 [0.5718, 0.6568] | 102 of 105 groups; 211 of 303 pairs |
| persistence | f1 | 0.2687 [0.2373, 0.3008] | 102 of 105 groups; 211 of 303 pairs |
| persistence | roc_auc | 0.3500 [0.3276, 0.3719] | 102 of 105 groups; 211 of 303 pairs |
| persistence | average_precision | 0.2179 [0.1864, 0.2523] | 102 of 105 groups; 211 of 303 pairs |
| persistence | brier | -0.0090 [-0.0128, -0.0058] | 105 of 105 groups; 302 of 303 pairs |
| persistence | calibration_ece | -0.0081 [-0.0129, -0.0035] | 105 of 105 groups; 302 of 303 pairs |
| persistence | prevalence | 0.0000 [0.0000, 0.0000] | 105 of 105 groups; 302 of 303 pairs |
| persistence | iou_all_defined | 0.1741 [0.1513, 0.1972] | 102 of 105 groups; 211 of 303 pairs |
| persistence | iou_positive_target | 0.1741 [0.1513, 0.1972] | 102 of 105 groups; 211 of 303 pairs |
| existing_physical | precision | 0.0973 [0.0788, 0.1166] | 105 of 105 groups; 298 of 303 pairs |
| existing_physical | recall | -0.3863 [-0.4282, -0.3432] | 102 of 105 groups; 211 of 303 pairs |
| existing_physical | f1 | 0.0827 [0.0633, 0.1027] | 105 of 105 groups; 300 of 303 pairs |
| existing_physical | roc_auc | 0.3500 [0.3277, 0.3720] | 102 of 105 groups; 211 of 303 pairs |
| existing_physical | average_precision | 0.2179 [0.1864, 0.2523] | 102 of 105 groups; 211 of 303 pairs |
| existing_physical | brier | -0.8820 [-0.9054, -0.8569] | 105 of 105 groups; 302 of 303 pairs |
| existing_physical | calibration_ece | -0.8810 [-0.9041, -0.8560] | 105 of 105 groups; 302 of 303 pairs |
| existing_physical | prevalence | 0.0000 [0.0000, 0.0000] | 105 of 105 groups; 302 of 303 pairs |
| existing_physical | iou_all_defined | 0.0538 [0.0402, 0.0680] | 105 of 105 groups; 300 of 303 pairs |
| existing_physical | iou_positive_target | 0.0690 [0.0492, 0.0896] | 102 of 105 groups; 211 of 303 pairs |
| growth_extrapolation | precision | 0.0236 [-0.0284, 0.0821] | 22 of 105 groups; 27 of 303 pairs |
| growth_extrapolation | recall | 0.5540 [0.5051, 0.6031] | 102 of 105 groups; 211 of 303 pairs |
| growth_extrapolation | f1 | 0.2340 [0.2054, 0.2643] | 102 of 105 groups; 215 of 303 pairs |
| growth_extrapolation | roc_auc | 0.3308 [0.3067, 0.3551] | 102 of 105 groups; 211 of 303 pairs |
| growth_extrapolation | average_precision | 0.2102 [0.1799, 0.2433] | 102 of 105 groups; 211 of 303 pairs |
| growth_extrapolation | brier | -0.0213 [-0.0309, -0.0131] | 105 of 105 groups; 302 of 303 pairs |
| growth_extrapolation | calibration_ece | -0.0203 [-0.0301, -0.0113] | 105 of 105 groups; 302 of 303 pairs |
| growth_extrapolation | prevalence | 0.0000 [0.0000, 0.0000] | 105 of 105 groups; 302 of 303 pairs |
| growth_extrapolation | iou_all_defined | 0.1513 [0.1308, 0.1731] | 102 of 105 groups; 215 of 303 pairs |
| growth_extrapolation | iou_positive_target | 0.1539 [0.1334, 0.1756] | 102 of 105 groups; 211 of 303 pairs |

## Threshold 0.05: growth

| Method | Precision | Recall | F1 | ROC-AUC | AP | Brier | ECE | Growth prevalence | IoU all defined | IoU positive-target |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| persistence | undefined | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.5000 [0.5000, 0.5000] | 0.0269 [0.0180, 0.0378] | 0.0152 [0.0108, 0.0203] | 0.0152 [0.0108, 0.0203] | 0.0152 [0.0108, 0.0203] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] |
| existing_physical | 0.0171 [0.0122, 0.0226] | 0.9981 [0.9945, 1.0000] | 0.0299 [0.0219, 0.0386] | 0.5555 [0.5353, 0.5760] | 0.0324 [0.0214, 0.0456] | 0.8756 [0.8377, 0.9115] | 0.8834 [0.8466, 0.9181] | 0.0152 [0.0108, 0.0203] | 0.0170 [0.0121, 0.0224] | 0.0304 [0.0199, 0.0430] |
| growth_extrapolation | 0.2341 [0.1517, 0.3272] | 0.0580 [0.0354, 0.0845] | 0.0282 [0.0159, 0.0420] | 0.5255 [0.5152, 0.5374] | 0.0385 [0.0270, 0.0517] | 0.0212 [0.0138, 0.0304] | 0.0212 [0.0138, 0.0304] | 0.0152 [0.0108, 0.0203] | 0.0178 [0.0099, 0.0270] | 0.0186 [0.0103, 0.0280] |
| unet | 0.1604 [0.1364, 0.1848] | 0.5640 [0.5170, 0.6123] | 0.1676 [0.1446, 0.1917] | 0.9622 [0.9522, 0.9719] | 0.3065 [0.2701, 0.3443] | 0.0136 [0.0096, 0.0181] | 0.0149 [0.0111, 0.0191] | 0.0152 [0.0108, 0.0203] | 0.1061 [0.0904, 0.1227] | 0.1508 [0.1314, 0.1716] |

| Method | Pooled prevalence | Pooled Brier | Pooled ECE | Cells | Positive cells | TP / FP / FN / TN | Empty / no-growth / both-empty pairs |
|---|---:|---:|---:|---:|---:|---|---|
| persistence | 0.0157 | 0.0157 | 0.0157 | 4275930 | 66992 | 0 / 0 / 66992 / 4208938 | 0 / 92 / 92 |
| existing_physical | 0.0157 | 0.8734 | 0.8812 | 4275930 | 66992 | 66663 / 3887414 / 329 / 321524 | 0 / 92 / 0 |
| growth_extrapolation | 0.0157 | 0.0199 | 0.0199 | 4275930 | 66992 | 8992 / 27251 / 58000 / 4181687 | 0 / 92 / 88 |
| unet | 0.0157 | 0.0141 | 0.0072 | 4275930 | 66992 | 24357 / 66250 / 42635 / 4142688 | 0 / 92 / 2 |

| U-Net minus baseline | Metric | Paired macro difference [95% CI] | Defined groups / pairs |
|---|---|---:|---:|
| persistence | precision | undefined | 0 of 105 groups; 0 of 303 pairs |
| persistence | recall | 0.5640 [0.5170, 0.6123] | 102 of 105 groups; 211 of 303 pairs |
| persistence | f1 | 0.2392 [0.2108, 0.2682] | 102 of 105 groups; 211 of 303 pairs |
| persistence | roc_auc | 0.4622 [0.4522, 0.4719] | 102 of 105 groups; 211 of 303 pairs |
| persistence | average_precision | 0.2796 [0.2469, 0.3150] | 102 of 105 groups; 211 of 303 pairs |
| persistence | brier | -0.0016 [-0.0026, -0.0008] | 105 of 105 groups; 303 of 303 pairs |
| persistence | calibration_ece | -0.0003 [-0.0016, 0.0010] | 105 of 105 groups; 303 of 303 pairs |
| persistence | prevalence | 0.0000 [0.0000, 0.0000] | 105 of 105 groups; 303 of 303 pairs |
| persistence | iou_all_defined | 0.1508 [0.1314, 0.1716] | 102 of 105 groups; 211 of 303 pairs |
| persistence | iou_positive_target | 0.1508 [0.1314, 0.1716] | 102 of 105 groups; 211 of 303 pairs |
| existing_physical | precision | 0.1431 [0.1219, 0.1652] | 105 of 105 groups; 299 of 303 pairs |
| existing_physical | recall | -0.4341 [-0.4806, -0.3854] | 102 of 105 groups; 211 of 303 pairs |
| existing_physical | f1 | 0.1373 [0.1151, 0.1600] | 105 of 105 groups; 301 of 303 pairs |
| existing_physical | roc_auc | 0.4067 [0.3851, 0.4286] | 102 of 105 groups; 211 of 303 pairs |
| existing_physical | average_precision | 0.2741 [0.2403, 0.3093] | 102 of 105 groups; 211 of 303 pairs |
| existing_physical | brier | -0.8621 [-0.8997, -0.8227] | 105 of 105 groups; 303 of 303 pairs |
| existing_physical | calibration_ece | -0.8685 [-0.9042, -0.8315] | 105 of 105 groups; 303 of 303 pairs |
| existing_physical | prevalence | 0.0000 [0.0000, 0.0000] | 105 of 105 groups; 303 of 303 pairs |
| existing_physical | iou_all_defined | 0.0889 [0.0736, 0.1043] | 105 of 105 groups; 301 of 303 pairs |
| existing_physical | iou_positive_target | 0.1204 [0.0980, 0.1425] | 102 of 105 groups; 211 of 303 pairs |
| growth_extrapolation | precision | 0.0350 [-0.0259, 0.1134] | 22 of 105 groups; 27 of 303 pairs |
| growth_extrapolation | recall | 0.5060 [0.4538, 0.5578] | 102 of 105 groups; 211 of 303 pairs |
| growth_extrapolation | f1 | 0.2072 [0.1812, 0.2330] | 102 of 105 groups; 215 of 303 pairs |
| growth_extrapolation | roc_auc | 0.4367 [0.4207, 0.4511] | 102 of 105 groups; 211 of 303 pairs |
| growth_extrapolation | average_precision | 0.2680 [0.2365, 0.3015] | 102 of 105 groups; 211 of 303 pairs |
| growth_extrapolation | brier | -0.0077 [-0.0147, -0.0027] | 105 of 105 groups; 303 of 303 pairs |
| growth_extrapolation | calibration_ece | -0.0063 [-0.0133, -0.0012] | 105 of 105 groups; 303 of 303 pairs |
| growth_extrapolation | prevalence | 0.0000 [0.0000, 0.0000] | 105 of 105 groups; 303 of 303 pairs |
| growth_extrapolation | iou_all_defined | 0.1305 [0.1126, 0.1481] | 102 of 105 groups; 215 of 303 pairs |
| growth_extrapolation | iou_positive_target | 0.1322 [0.1141, 0.1503] | 102 of 105 groups; 211 of 303 pairs |

## Threshold 0.50: front_1000m

| Method | Precision | Recall | F1 | ROC-AUC | AP | Brier | ECE | Growth prevalence | IoU all defined | IoU positive-target |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| persistence | undefined | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.5000 [0.5000, 0.5000] | 0.1050 [0.0816, 0.1314] | 0.0635 [0.0502, 0.0774] | 0.0635 [0.0502, 0.0774] | 0.0635 [0.0502, 0.0774] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] |
| existing_physical | 0.0635 [0.0502, 0.0774] | 1.0000 [1.0000, 1.0000] | 0.0989 [0.0807, 0.1180] | 0.4999 [0.4998, 0.5000] | 0.1050 [0.0816, 0.1314] | 0.9365 [0.9226, 0.9498] | 0.9365 [0.9226, 0.9498] | 0.0635 [0.0502, 0.0774] | 0.0635 [0.0502, 0.0774] | 0.1050 [0.0816, 0.1314] |
| growth_extrapolation | 0.2492 [0.1589, 0.3479] | 0.0597 [0.0368, 0.0865] | 0.0298 [0.0169, 0.0446] | 0.5192 [0.5108, 0.5288] | 0.1127 [0.0887, 0.1386] | 0.0758 [0.0603, 0.0926] | 0.0758 [0.0603, 0.0926] | 0.0635 [0.0502, 0.0774] | 0.0194 [0.0107, 0.0296] | 0.0202 [0.0111, 0.0307] |
| unet | 0.4325 [0.3581, 0.5126] | 0.0511 [0.0352, 0.0687] | 0.0537 [0.0395, 0.0689] | 0.8500 [0.8276, 0.8719] | 0.3229 [0.2840, 0.3619] | 0.0545 [0.0442, 0.0656] | 0.0555 [0.0453, 0.0665] | 0.0635 [0.0502, 0.0774] | 0.0325 [0.0235, 0.0425] | 0.0338 [0.0242, 0.0435] |

| Method | Pooled prevalence | Pooled Brier | Pooled ECE | Cells | Positive cells | TP / FP / FN / TN | Empty / no-growth / both-empty pairs |
|---|---:|---:|---:|---:|---:|---|---|
| persistence | 0.0547 | 0.0547 | 0.0547 | 784319 | 42871 | 0 / 0 / 42871 / 741448 | 1 / 91 / 91 |
| existing_physical | 0.0547 | 0.9453 | 0.9453 | 784319 | 42871 | 42871 / 741448 / 0 / 0 | 1 / 91 / 0 |
| growth_extrapolation | 0.0547 | 0.0734 | 0.0734 | 784319 | 42871 | 8343 / 23065 / 34528 / 718383 | 1 / 91 / 87 |
| unet | 0.0547 | 0.0468 | 0.0281 | 784319 | 42871 | 2928 / 2892 / 39943 / 738556 | 1 / 91 / 80 |

| U-Net minus baseline | Metric | Paired macro difference [95% CI] | Defined groups / pairs |
|---|---|---:|---:|
| persistence | precision | undefined | 0 of 105 groups; 0 of 303 pairs |
| persistence | recall | 0.0511 [0.0352, 0.0687] | 102 of 105 groups; 211 of 303 pairs |
| persistence | f1 | 0.0560 [0.0409, 0.0712] | 102 of 105 groups; 211 of 303 pairs |
| persistence | roc_auc | 0.3500 [0.3276, 0.3719] | 102 of 105 groups; 211 of 303 pairs |
| persistence | average_precision | 0.2179 [0.1864, 0.2523] | 102 of 105 groups; 211 of 303 pairs |
| persistence | brier | -0.0090 [-0.0128, -0.0058] | 105 of 105 groups; 302 of 303 pairs |
| persistence | calibration_ece | -0.0081 [-0.0129, -0.0035] | 105 of 105 groups; 302 of 303 pairs |
| persistence | prevalence | 0.0000 [0.0000, 0.0000] | 105 of 105 groups; 302 of 303 pairs |
| persistence | iou_all_defined | 0.0338 [0.0242, 0.0435] | 102 of 105 groups; 211 of 303 pairs |
| persistence | iou_positive_target | 0.0338 [0.0242, 0.0435] | 102 of 105 groups; 211 of 303 pairs |
| existing_physical | precision | 0.3313 [0.2638, 0.4030] | 86 of 105 groups; 126 of 303 pairs |
| existing_physical | recall | -0.9489 [-0.9648, -0.9313] | 102 of 105 groups; 211 of 303 pairs |
| existing_physical | f1 | -0.0957 [-0.1302, -0.0633] | 104 of 105 groups; 222 of 303 pairs |
| existing_physical | roc_auc | 0.3500 [0.3277, 0.3720] | 102 of 105 groups; 211 of 303 pairs |
| existing_physical | average_precision | 0.2179 [0.1864, 0.2523] | 102 of 105 groups; 211 of 303 pairs |
| existing_physical | brier | -0.8820 [-0.9054, -0.8569] | 105 of 105 groups; 302 of 303 pairs |
| existing_physical | calibration_ece | -0.8810 [-0.9041, -0.8560] | 105 of 105 groups; 302 of 303 pairs |
| existing_physical | prevalence | 0.0000 [0.0000, 0.0000] | 105 of 105 groups; 302 of 303 pairs |
| existing_physical | iou_all_defined | -0.0654 [-0.0924, -0.0410] | 104 of 105 groups; 222 of 303 pairs |
| existing_physical | iou_positive_target | -0.0712 [-0.0993, -0.0454] | 102 of 105 groups; 211 of 303 pairs |
| growth_extrapolation | precision | 0.2108 [0.1295, 0.3012] | 22 of 105 groups; 27 of 303 pairs |
| growth_extrapolation | recall | -0.0086 [-0.0324, 0.0137] | 102 of 105 groups; 211 of 303 pairs |
| growth_extrapolation | f1 | 0.0254 [0.0117, 0.0399] | 102 of 105 groups; 215 of 303 pairs |
| growth_extrapolation | roc_auc | 0.3308 [0.3067, 0.3551] | 102 of 105 groups; 211 of 303 pairs |
| growth_extrapolation | average_precision | 0.2102 [0.1799, 0.2433] | 102 of 105 groups; 211 of 303 pairs |
| growth_extrapolation | brier | -0.0213 [-0.0309, -0.0131] | 105 of 105 groups; 302 of 303 pairs |
| growth_extrapolation | calibration_ece | -0.0203 [-0.0301, -0.0113] | 105 of 105 groups; 302 of 303 pairs |
| growth_extrapolation | prevalence | 0.0000 [0.0000, 0.0000] | 105 of 105 groups; 302 of 303 pairs |
| growth_extrapolation | iou_all_defined | 0.0140 [0.0046, 0.0238] | 102 of 105 groups; 215 of 303 pairs |
| growth_extrapolation | iou_positive_target | 0.0137 [0.0040, 0.0235] | 102 of 105 groups; 211 of 303 pairs |

## Threshold 0.50: growth

| Method | Precision | Recall | F1 | ROC-AUC | AP | Brier | ECE | Growth prevalence | IoU all defined | IoU positive-target |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| persistence | undefined | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.5000 [0.5000, 0.5000] | 0.0269 [0.0180, 0.0378] | 0.0152 [0.0108, 0.0203] | 0.0152 [0.0108, 0.0203] | 0.0152 [0.0108, 0.0203] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] |
| existing_physical | 0.0178 [0.0125, 0.0235] | 0.9972 [0.9919, 1.0000] | 0.0309 [0.0227, 0.0398] | 0.5555 [0.5353, 0.5760] | 0.0324 [0.0214, 0.0456] | 0.8756 [0.8377, 0.9115] | 0.8834 [0.8466, 0.9181] | 0.0152 [0.0108, 0.0203] | 0.0176 [0.0125, 0.0232] | 0.0313 [0.0205, 0.0441] |
| growth_extrapolation | 0.2341 [0.1517, 0.3272] | 0.0580 [0.0354, 0.0845] | 0.0282 [0.0159, 0.0420] | 0.5255 [0.5152, 0.5374] | 0.0385 [0.0270, 0.0517] | 0.0212 [0.0138, 0.0304] | 0.0212 [0.0138, 0.0304] | 0.0152 [0.0108, 0.0203] | 0.0178 [0.0099, 0.0270] | 0.0186 [0.0103, 0.0280] |
| unet | 0.4325 [0.3581, 0.5126] | 0.0492 [0.0334, 0.0668] | 0.0516 [0.0378, 0.0665] | 0.9622 [0.9522, 0.9719] | 0.3065 [0.2701, 0.3443] | 0.0136 [0.0096, 0.0181] | 0.0149 [0.0111, 0.0191] | 0.0152 [0.0108, 0.0203] | 0.0311 [0.0222, 0.0408] | 0.0323 [0.0231, 0.0418] |

| Method | Pooled prevalence | Pooled Brier | Pooled ECE | Cells | Positive cells | TP / FP / FN / TN | Empty / no-growth / both-empty pairs |
|---|---:|---:|---:|---:|---:|---|---|
| persistence | 0.0157 | 0.0157 | 0.0157 | 4275930 | 66992 | 0 / 0 / 66992 / 4208938 | 0 / 92 / 92 |
| existing_physical | 0.0157 | 0.8734 | 0.8812 | 4275930 | 66992 | 66509 / 3783851 / 483 / 425087 | 0 / 92 / 0 |
| growth_extrapolation | 0.0157 | 0.0199 | 0.0199 | 4275930 | 66992 | 8992 / 27251 / 58000 / 4181687 | 0 / 92 / 88 |
| unet | 0.0157 | 0.0141 | 0.0072 | 4275930 | 66992 | 2928 / 2892 / 64064 / 4206046 | 0 / 92 / 81 |

| U-Net minus baseline | Metric | Paired macro difference [95% CI] | Defined groups / pairs |
|---|---|---:|---:|
| persistence | precision | undefined | 0 of 105 groups; 0 of 303 pairs |
| persistence | recall | 0.0492 [0.0334, 0.0668] | 102 of 105 groups; 211 of 303 pairs |
| persistence | f1 | 0.0538 [0.0391, 0.0686] | 102 of 105 groups; 211 of 303 pairs |
| persistence | roc_auc | 0.4622 [0.4522, 0.4719] | 102 of 105 groups; 211 of 303 pairs |
| persistence | average_precision | 0.2796 [0.2469, 0.3150] | 102 of 105 groups; 211 of 303 pairs |
| persistence | brier | -0.0016 [-0.0026, -0.0008] | 105 of 105 groups; 303 of 303 pairs |
| persistence | calibration_ece | -0.0003 [-0.0016, 0.0010] | 105 of 105 groups; 303 of 303 pairs |
| persistence | prevalence | 0.0000 [0.0000, 0.0000] | 105 of 105 groups; 303 of 303 pairs |
| persistence | iou_all_defined | 0.0323 [0.0231, 0.0418] | 102 of 105 groups; 211 of 303 pairs |
| persistence | iou_positive_target | 0.0323 [0.0231, 0.0418] | 102 of 105 groups; 211 of 303 pairs |
| existing_physical | precision | 0.4051 [0.3341, 0.4807] | 86 of 105 groups; 126 of 303 pairs |
| existing_physical | recall | -0.9480 [-0.9641, -0.9300] | 102 of 105 groups; 211 of 303 pairs |
| existing_physical | f1 | 0.0012 [-0.0217, 0.0232] | 104 of 105 groups; 222 of 303 pairs |
| existing_physical | roc_auc | 0.4067 [0.3851, 0.4286] | 102 of 105 groups; 211 of 303 pairs |
| existing_physical | average_precision | 0.2741 [0.2403, 0.3093] | 102 of 105 groups; 211 of 303 pairs |
| existing_physical | brier | -0.8621 [-0.8997, -0.8227] | 105 of 105 groups; 303 of 303 pairs |
| existing_physical | calibration_ece | -0.8685 [-0.9042, -0.8315] | 105 of 105 groups; 303 of 303 pairs |
| existing_physical | prevalence | 0.0000 [0.0000, 0.0000] | 105 of 105 groups; 303 of 303 pairs |
| existing_physical | iou_all_defined | 0.0016 [-0.0134, 0.0159] | 104 of 105 groups; 222 of 303 pairs |
| existing_physical | iou_positive_target | 0.0010 [-0.0143, 0.0158] | 102 of 105 groups; 211 of 303 pairs |
| growth_extrapolation | precision | 0.2260 [0.1384, 0.3282] | 22 of 105 groups; 27 of 303 pairs |
| growth_extrapolation | recall | -0.0088 [-0.0322, 0.0133] | 102 of 105 groups; 211 of 303 pairs |
| growth_extrapolation | f1 | 0.0250 [0.0114, 0.0388] | 102 of 105 groups; 215 of 303 pairs |
| growth_extrapolation | roc_auc | 0.4367 [0.4207, 0.4511] | 102 of 105 groups; 211 of 303 pairs |
| growth_extrapolation | average_precision | 0.2680 [0.2365, 0.3015] | 102 of 105 groups; 211 of 303 pairs |
| growth_extrapolation | brier | -0.0077 [-0.0147, -0.0027] | 105 of 105 groups; 303 of 303 pairs |
| growth_extrapolation | calibration_ece | -0.0063 [-0.0133, -0.0012] | 105 of 105 groups; 303 of 303 pairs |
| growth_extrapolation | prevalence | 0.0000 [0.0000, 0.0000] | 105 of 105 groups; 303 of 303 pairs |
| growth_extrapolation | iou_all_defined | 0.0141 [0.0053, 0.0235] | 102 of 105 groups; 215 of 303 pairs |
| growth_extrapolation | iou_positive_target | 0.0138 [0.0047, 0.0232] | 102 of 105 groups; 211 of 303 pairs |

All-defined IoU/F1 include no-observed-growth false positives as 0. Both-empty pairs are undefined. Positive-target IoU uses only pairs with actual growth in that declared domain, preserving traceability to the original conditional metric. A positive difference favors U-Net for overlap/discrimination metrics; negative favors it for Brier/ECE. Prevalence is descriptive and should match methods.

The neural head retains current cells, so full-footprint classification is deliberately absent here. No baseline or neural output was retrained, recalibrated or selected using these results. These diagnostics do not establish rescue outcomes or precise arrival times.

Inspect `protocol.json`, `metrics.json`, `pair_metrics.json`, and `per_incident_metrics.json` for hashes, populations, undefined counts, pooled calibration statistics and all paired intervals.
