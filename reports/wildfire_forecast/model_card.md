# Time-conditioned U-Net model card

wildfire-supervised-known-perimeters-v2 · checkpoint 40dff57a49da752513f51ec8bbe27c1f85d3725c9e4098a08f8bb9e9f5a997ca

# Supervised wildfire forecast benchmark

**Current frozen operating point: 0.05 selected (seed 202, epoch 4); 0.50 is diagnostic.** [Open the focused operating-point report](frozen_operating_point/index.html). The tables below retain the original common-0.50 comparison and its original positive-growth population; metrics.json is unchanged.

Model family: time-conditioned U-Net. Split: test; 105 incident groups / 303 observed pairs. **previously inspected; reused diagnostic panel**. Model selection uses validation only. Reused test results are diagnostic, not pristine unseen evidence.

| Method | New-growth IoU | New-growth Dice | Full-footprint Brier | Full-footprint AP |
|---|---:|---:|---:|---:|
| Persistence | 0.0000 | 0.0000 | 0.0134 | 0.9158 |
| Physical ensemble | 0.0313 | 0.0538 | 0.7565 | 0.1783 |
| Growth extrapolation | 0.0186 | 0.0293 | 0.0169 | 0.9042 |
| Time-conditioned U-Net | 0.0323 | 0.0538 | 0.0121 | 0.9715 |

The original common-protocol growth metric uses the SAME actual-growth-positive pairs for every method, averages pairs within incident, then averages incidents. Empty growth never earns perfect credit. The focused operating-point report separately names its all-defined and original conditional growth populations. Raw perimeter regressions remain in full-footprint metrics. Probability-score AUC/AP are undefined for one-class slices. 2,000 whole-incident paired bootstrap intervals are in confidence_intervals.json; pixels are not independent fires.

The original comparison uses 0.50 for every method. The frozen validation-selected threshold is 0.050; its separately saved conditional growth IoU is 0.1508. Both views reuse exactly the same frozen probabilities. The current focused readout emphasizes 0.05 and retains 0.50 as a diagnostic without rewriting the original comparison.

## Growth probability diagnostic

Full-footprint AP includes already known affected cells and does not establish new-spread skill. The following secondary analysis excludes the starting footprint; it does not change model selection or the primary score.

| Method | Growth-only AP | Growth-only Brier |
|---|---:|---:|
| Persistence | 0.0269 | 0.0152 |
| Physical ensemble | 0.0324 | 0.8756 |
| Growth extrapolation | 0.0385 | 0.0212 |
| Time-conditioned U-Net | 0.3065 | 0.0136 |

## Precision, recall and F1 at both saved thresholds

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


## Learning, outputs and use

Historical observed masks and elapsed acquisition times create input/target pairs. Train-only normalization and a U-Net with architecture {'depth': 3, 'grid_shape': [128, 128], 'input_channels': 8, 'width': 16} predict new-growth probabilities while preserving the observed footprint. A later raw observation supplies supervised segmentation loss. Weighted-BCE logits receive a train-prior correction before probabilities are exposed. The Dice auxiliary and finite training make that correction approximate; calibration is measured empirically, not asserted. Calibration metadata: {'approximate_because': 'fixed 0.2 soft Dice auxiliary and finite model optimization; assess empirical Brier/ECE', 'fit_partition': 'train', 'fitted_calibration_parameters': False, 'logit_subtraction': 3.912023005428146, 'method': 'analytic_weighted_bce_logit_prior_correction', 'pos_weight': 50.0}. The model does not assign rescue resources: danger/slack remains separate and Lookahead dispatch remains unchanged. Simulation stays the default until explicit compatibility/quality activation succeeds. There is no live learning or operational safety assurance.

Actual completed epochs: 9; optimizer updates: 3996; processed historical pairs: 63855; training seconds: 236.2266584589379. Checkpoint: 40dff57a49da752513f51ec8bbe27c1f85d3725c9e4098a08f8bb9e9f5a997ca. Frozen normalization, configuration and dependency versions are in training_runs.json. No training or inference occurs when rebuilding reports.

The preceding epoch/update/time values describe the selected seed, not the entire campaign. Across all supervised seeds there were 11544 updates and 184470 historical-pair exposures (repeated training exposures, not independent observations).

## Actual compute budget and cleanup

The supervised campaign consumed 703.786 s. Prior consumed compute: 1623.397 s. Combined: 2327.183 s (38.79 min) of the 4500 s (75 min) authorized cap. Cap respected: True. Training finished: True; new training planned: False.

| Seed | Completed epochs | Selected epoch | Updates | Elapsed seconds | Complete |
|---|---:|---:|---:|---:|---|
| 101 | 9 | 4 | 3996 | 246.11 | True |
| 202 | 9 | 4 | 3996 | 236.23 | True |
| 303 | 8 | 3 | 3552 | 221.45 | True |

The cleanup receipt records 22 retired owned paths. The current forecaster is exclusively supervised. Original archives, normalized historical observations, frozen grouping/split and shared live application were preserved. Data-immutability audit status: passed; files before/after: 1828 / 1828; NPZ arrays: 1077; cleaned GeoParquet files: 737. Exact hashes and changed/added/removed-file lists remain in data_immutability_comparison.json; no data-preservation claim is inferred when the receipt is absent.

## Native export and empirical calibration gate

```json
{
  "activation_scope": "supplementary historical risk with compatible known history only",
  "app_settings_changed": false,
  "fallback_reasons": [],
  "inference_timing_passed": true,
  "validation_quality_passed": true
}
```

This status is read from the saved export receipt, not inferred from training completion, ordinary pixel accuracy or a successful file save. The analytic class-prior correction remains approximate with Dice; empirical Brier/ECE and the recorded gate determine whether measured calibration requirements passed. Simulation remains the default and activation requires explicit compatible configuration. No model prediction certifies resident safety.

## Executed integration and verification evidence

```json
{
  "isolated_loopback_database": {
    "status": "passed",
    "server": "http://127.0.0.1:3143",
    "synthetic_requests": 24,
    "initial_queue_entries": 23,
    "queue_after_wind_change": 23,
    "completed_handoffs": null,
    "handoff_reason": "station agents are stubs; no execution/handoff simulator on this main baseline",
    "consent_expiry_timer": "source inspected; fifteen-minute timer not wall-clock waited",
    "full_uagents_asi1_frontend": "not launched; uagents dependency/Agentverse credentials/frontend unavailable",
    "check_records": 15
  },
  "exported_backend_smoke": {
    "active": "learned",
    "reason": "supplementary historical risk only",
    "elapsed_s": 0.03576062503270805,
    "optimizer_updates": 0,
    "output_shape": [
      1,
      128,
      128
    ],
    "checkpoint_unchanged": true,
    "default": "configured simulation; short-horizon physical timing remains active",
    "missing_history": "timestamped historical observation history unavailable in live simulation"
  },
  "verification": {
    "base_commit": "dcaaf5baa1f8ab8150bf94f49132284e41a54e24",
    "branch": "rl-fixed-codex",
    "broader_lint_limitation": "Ruff over the modified legacy delegation.py also finds a pre-existing E702 at line160. The forecast CI scope and new modules/tests pass. Unrelated teammate code was not reformatted.",
    "checks": [
      {
        "command": "python -m ruff check agents/rescue/forecast_ml tests",
        "exit_code": 0,
        "result": "passed"
      },
      {
        "command": "python -m ruff format --check agents/rescue/forecast_ml tests",
        "exit_code": 0,
        "result": "36 files already formatted"
      },
      {
        "command": "PYTHONPATH=agents python agents/scripts/test_planning.py",
        "exit_code": 0,
        "result": "planning and validate_plan checks passed"
      },
      {
        "command": "npm run typecheck --prefix spacetimedb",
        "exit_code": 0,
        "result": "TypeScript compiler passed"
      },
      {
        "command": "git diff --check",
        "exit_code": 0,
        "result": "passed"
      }
    ],
    "data": {
      "archive_unchanged": true,
      "data_files_unchanged": 1828,
      "receipt": "data_immutability_comparison.json",
      "status": "passed"
    },
    "evaluation": {
      "forecast_pairs": 303,
      "incident_groups": 105,
      "new_model_inference_for_threshold_comparison": false,
      "split": "test",
      "status": "previously inspected; reused diagnostic holdout",
      "thresholds": [
        0.05,
        0.5
      ]
    },
    "latest_frozen_request": {
      "diagnostics": "frozen_operating_point/metrics.json",
      "freeze_hashes_unchanged": {
        "dataset_manifest_file_sha256": true,
        "export_checkpoint_sha256": true,
        "native_model_source_sha256": true,
        "saved_prediction_sha256": true,
        "selected_checkpoint_sha256": true,
        "split_manifest_file_sha256": true,
        "test_pair_manifest_file_sha256": true,
        "trainer_source_sha256": true,
        "training_config_sha256": true
      },
      "illustrative_selection": "post hoc target-size-only; eleven eligible sequences, median627observedgrowthcells",
      "independent_bootstrap_verification": "all280macro/paired entries and intervals reproduced",
      "local_loopback_server": "stopped after isolated contract test",
      "named_fire": "AIRPLANE LAKE,2023,WA-OWF-000374",
      "named_windows": 3,
      "new_historical_model_inference": false,
      "new_training": false,
      "untouched_test_claim": false
    },
    "live_limitations": [
      "Full Fetch.ai/ASI:One/frontend not launched",
      "station execution is a stub; completed handoffs undefined",
      "consent expiration timer inspected but not wall-clock waited",
      "no production settings changed",
      "simulated synthetic residents; no real emergency dispatch"
    ],
    "main_modified": false,
    "merged": false,
    "native_inference": {
      "random_weights_live": false,
      "reload_receipt": "native_reload_verification.json",
      "serving_receipt": "serving_smoke.json",
      "trained_export_forward": "passed",
      "training_dependency_in_ci": false
    },
    "pushed": false,
    "pytest": {
      "actual_counts": {
        "errors": 0,
        "failures": 0,
        "skipped": 0,
        "tests": 105
      },
      "command": "PYTHONPATH=agents python -m pytest -q --junitxml=runs/supervised/pytest.xml",
      "elapsed_s": 7.19,
      "warning_detail": "Shapely ops.transform deprecation; no failed assertions",
      "warnings": 7
    },
    "schema_version": "supervised-final-verification-v1",
    "spacetimedb": {
      "contract_checks_failed": 0,
      "contract_checks_passed": 15,
      "database": "wrq-codex-supervised",
      "module_build_publish": "passed on isolated loopback only",
      "receipt": "integration_demo.json",
      "server": "http://127.0.0.1:3143"
    },
    "training_budget": {
      "cap_respected": true,
      "cap_seconds": 4500,
      "combined_seconds": 2327.1827980428934,
      "new_training_planned": false,
      "prior_consumed_seconds": 1623.3970930420328,
      "seeds": [
        {
          "best_epoch": 4,
          "complete": true,
          "epochs": 9,
          "seconds": 246.10992824996356,
          "seed": 101,
          "updates": 3996
        },
        {
          "best_epoch": 4,
          "complete": true,
          "epochs": 9,
          "seconds": 236.2266584589379,
          "seed": 202,
          "updates": 3996
        },
        {
          "best_epoch": 3,
          "complete": true,
          "epochs": 8,
          "seconds": 221.44911829195917,
          "seed": 303,
          "updates": 3552
        }
      ],
      "supervised_seconds": 703.7857050008606,
      "training_finished": true
    }
  }
}
```

The database exercise used synthetic requests in isolated local state. It is not evidence of a production emergency deployment or a fully launched agent/frontend stack. The receipts distinguish exercised checks from source-only inspection, including the consent timer and unavailable station handoff execution. The serving smoke loaded the exported artifact with compatible validation history, checked unchanged checkpoint bytes, and exercised visible fallbacks; it did not train the model.

## Limits and traceability

Missing historical weather/fuel, irregular/reconstructed acquisitions, unknown information release, raw perimeter revisions and fixed initial-domain clipping limit interpretation. Daily/irregular labels do not validate minute-level arrival times. Coverage: {'clipped_pairs': 58, 'interpretation': 'pixel scores exclude outside-grid target geometry', 'known_pairs': 303, 'mean_geometric_coverage': 0.9324164033467923}. Source archive: 2eee127eb733696deab8657bd6fb95560f380c696c0cd8b5901512b947fa6c21; split manifest: 4371e4cf785c4472bf4f08b79ff09aa6692d3d2b34c19eeacc79de7dc7a48707. The frozen 303-pair/105-group test panel was previously inspected and remains disclosed as reused; no thresholds/loss weights are selected against it.

Fictional resident metrics, when supplied, use the same placements across forecasts and bootstrap whole incidents. Exposure probability is separate from assistance needs, arrival intervals and feasible rescue slack. Unknown routes/arrival windows require review, never a claim that someone is safe or unreachable. Historical fire labels do not validate real rescues. The application is simulated and does not replace 911.

Boundary diagnostics under diagnostics/ use saved validation outputs only, fixed meter bands outside the initial mask, and explicit zero-denominator handling. Raster-center distances have spatial resolution uncertainty; narrow bands can be empty. No model or loss change follows inspection of the reused test panel.

Rebuild: `PYTHONPATH=agents python -m rescue.forecast_ml.reports --report-dir reports/wildfire_forecast`.
