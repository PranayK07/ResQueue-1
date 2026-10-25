# Supervised forecasting cleanup audit

Status: **PASSED**. Read-only inspection of branch `rl-fixed-codex`; no source edit, deletion, training, inference, Git fetch/reset/push or merge was performed.

| Check | Result |
|---|---|
| package_AST_has_no_forbidden_imports | PASS |
| old_experiment_paths_absent | PASS |
| only_native_supervised_UNet_checkpoints | PASS |
| requirements_have_no_controller_runtime_dependencies | PASS |
| core_and_legacy_files_unchanged | PASS |
| local_main_matches_starting_baseline | PASS |
| local_main_ref_unchanged_during_audit | PASS |
| no_scoped_PPO_trainer_process | PASS |
| no_scoped_known_training_process | PASS |
| only_permitted_PPO_word_mentions | PASS |
| all_historical_data_and_original_archive_unchanged | PASS |

Parsed 22 active forecasting modules and 239 import nodes: no Stable-Baselines3, Gym/Gymnasium or controller imports. Old package/output paths are absent. The seven remaining model files are six native supervised U-Net `best.pt`/`latest.pt` checkpoints for seeds 101/202/303 plus their native deployment export, each with width 16/depth 3, eight inputs and the supervised v2 feature schema. Loading state dictionaries performed zero optimizer updates and changed no checkpoint bytes.

## Preserved main and legacy files

Local `main` remains `dcaaf5baa1f8ab8150bf94f49132284e41a54e24` and did not change during this audit. Working core fire/routing/slack/policy, the existing rescue hook and legacy RL integration guide have the same Git blob IDs as HEAD and the requested starting baseline. Exact blob IDs and SHA256 checks are in the JSON. The read-only remote-tracking `origin/main` ref is `23ae53800e497f0058f5613c9709a2b324704cc7`; it was not fetched or changed by this audit.

## Process and data checks

Scoped Python process count excluding this audit: 0; matching PPO trainer commands: 0. This point-in-time inventory does not inspect or alter unrelated worktrees.

The final complete hash recheck passed against the pre-migration snapshot: all 1,828 files, all 1,077 NPZs, all 737 cleaned GeoParquets, original archive, dataset bytes, split bytes and fixed-pair membership are unchanged. Added/removed/changed files: 0/0/0. See `data_immutability_final.json` and `data_immutability_comparison.json`.

## Allowed historical wording

- `docs/ML_MIGRATION_SUMMARY.md:1` — permitted historical migration/legacy reference or negative-import assertion.
- `docs/ML_MIGRATION_SUMMARY.md:3` — permitted historical migration/legacy reference or negative-import assertion.
- `docs/ML_MIGRATION_SUMMARY.md:6` — permitted historical migration/legacy reference or negative-import assertion.

Frozen data salt/schema spellings retain historical text solely for byte-compatible membership preservation; they select no runtime model. No first-party controller checkpoint or experiment directory remains in this worktree.

Full evidence and point-in-time refs are in `cleanup_audit.json`.

The new export `runs/supervised/export/model.pt` has the same file hash as `runs/supervised/seed-202/best.pt`. It was loaded as a native state dictionary with the supervised v2 feature schema, not an algorithm-specific archive.
