# Migration from forecasting PPO to supervised U-Net

The user explicitly stopped forecasting PPO. Its controller environment,
policy CNN, action/rollout simulator adapter, trainer/loader/exporter, reward
diagnostics, comparison contract, checkpoints and generated experiments were
removed. No PPO job is active. `stable-baselines3` and `gymnasium` are absent
from the new dependency files/workflow. `fire_rl` was replaced by `forecast_ml`.

Preserved unchanged:

- Original NIROPS ZIP and all1,828 files under `data/codex`.
- All1,077 arrays,737 cleaned GeoParquets, source IDs, geometries, grids,
  timestamps, dataset hashes and frozen group/test manifests.
- Data-quality/grouping reports and the data-only correction history.
- Main's fire model, router, slack, Lookahead, Fetch.ai, situation/news context,
  consent, pins and role-scoped database views.
- Unrelated assignment hooks in `agents/rescue/rl_policy.py`, `core/policy.py`
  and the original `docs/RL_INTEGRATION.md` guide.

Immutable dataset schema/salt strings retain their historical `fire-rl` spelling;
changing them would alter provenance and partitions. They identify data versions,
not an executable model dependency. `rl-fixed-codex` is retained as requested.

Replacement is a width16/depth3 eight-input supervised U-Net, weighted BCE/Dice,
native checkpoints/resume, shared causal preprocessing, train-only normalization
and class weights, and validation-only epoch/threshold selection. Persistence,
existing physical16-member forecasting and historical growth extrapolation use
identical frozen observations. A common0.5 threshold and the selected operating
point are reported separately. Geographic risk remains supplementary; simulation
and Lookahead stay defaults.

Previous work consumed 1,623.397 seconds of the 4,500 second authorization. The
three supervised seeds consumed 703.786 seconds, completing 9, 9 and 8 epochs
with configured early stopping. Combined training used 2,327.183 seconds
(38.79 of 75 minutes); no further training is planned. The frozen test panel was previously inspected. It is held-out
from training but is a **reused diagnostic holdout**, not a pristine confirmation
cohort. Replacement selection uses validation only.

Main, remotes, shared environments and unrelated teammate work were not reset.
Cleanup paths and byte-preservation proof are under `reports/wildfire_forecast`.
