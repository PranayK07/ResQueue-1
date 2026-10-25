# Reproduce supervised wildfire forecasting

Commands run from this branch's root. Python3.12 and the optional forecasting
requirements are separate from the original application's requirements.

```bash
python3.12 -m venv .venv-forecast
.venv-forecast/bin/pip install -r agents/requirements-forecast.lock
export PYTHONPATH="$PWD/agents"
.venv-forecast/bin/python -m pytest -q
.venv-forecast/bin/python agents/scripts/test_planning.py
npm ci --prefix spacetimedb
npm run typecheck --prefix spacetimedb
```

The lock records measured macOS/arm64 versions. Other platforms can use the `.in`
file and appropriate PyTorch wheel, recording their resolved versions/hardware.
CPU is supported by an explicitly named config with `device=cpu`; measured
training uses AppleM4Pro/MPS,24GiB RAM. No paid compute is required.

## Frozen historical data

`data/codex` already holds the clean immutable dataset. Reuse it. Do not rerun
ingestion, change its salt, move arrays or rewrite splits during an experiment.
All1,828 files and the original archive are proven byte-identical across the
architecture migration. Native inference itself accepts arrays and reloads
without training. Dataset manifests currently bind local absolute paths; transfer
artifacts with a separately verified relocation rather than editing hashes.

For a new clean machine only, the existing read-only archive may be processed
using the same builder; no duplicate download is needed:

```bash
.venv-forecast/bin/python -m rescue.forecast_ml.data \
  --archive "$HOME/Downloads/A high spatial resolution daily fire perimeter pro.zip" \
  --output data/codex --report reports/wildfire_forecast
```

This executes no training or bundled notebooks and fetches no weather. Preserve
the resulting source, geometry, timestamp and group receipts.

## Explicit bounded training

Training is never a dependency of ingestion, tests, inference or normal CI.
A new training invocation needs its own authorization and hard cap. This task
uses only2,876.603seconds remaining from the existing4,500second authorization.
The fixed seeds are101/202/303, max20epochs, patience5, batch16, AdamW0.001,
weight decay0.01, weighted BCE plus0.2Dice. The model and threshold are selected
using validation only. Early stopping is intentional completion, not silently
lowered evaluation standards.

```bash
.venv-forecast/bin/python -m rescue.forecast_ml.train_supervised \
  --dataset data/codex/dataset.json --output runs/supervised/seed-101 \
  --config agents/configs/wildfire_unet.json --max-seconds 2820 --seed 101
```

Additional seeds use the **remaining cumulative** cap, not a fresh45minute cap
each. `--resume latest.pt` is explicit, checks data/schema/config and retains
optimizer, cursor and RNG state. Cap interruption can replay an interrupted
batch; only complete validation epochs can become selected checkpoints. No
resume or training job runs automatically.

## Frozen evaluation and plots

The campaign receipt binds the validation-selected seed/epoch/threshold. The
preserved test panel was already inspected, so reuse must be acknowledged.

```bash
.venv-forecast/bin/python -m rescue.forecast_ml.evaluation \
  --dataset data/codex/dataset.json --training runs/supervised/campaign.json \
  --output reports/wildfire_forecast --split test --acknowledge-reused-test
.venv-forecast/bin/python -m rescue.forecast_ml.resident_eval \
  --dataset data/codex/dataset.json --report-dir reports/wildfire_forecast
.venv-forecast/bin/python -m rescue.forecast_ml.growth_diagnostics \
  --report-dir reports/wildfire_forecast
.venv-forecast/bin/python -m rescue.forecast_ml.reports \
  --report-dir reports/wildfire_forecast
```

Primary comparison uses0.5 for all methods; validation-selected threshold results
are labeled separately. Reports rebuild from saved predictions without fitting.
Large raw Parquet/JSON, data and native weights stay local and gitignored; retain
them with their hashes before moving/removing the worktree. Static figures,
summary metrics, split/data-quality receipts and native metadata are reviewable.

## Application integration

Keep `FIRE_FORECAST_BACKEND=simulation` and `POLICY=lookahead`. Explicit learned
configuration requires compatible native export metadata and measured gates;
checkpoint presence alone does not activate it. The6–72h historical model adds
coarse risk only, while existing physics supplies short-horizon route timing.

The local demo uses synthetic requests and a new loopback database only. Install
the original app dependencies for HTTP/WebSocket integration. Full Agentverse,
ASI:One and frontend flows need their owners' credentials/application work; an
isolated database contract test is not a claim that those flows were deployed.
Maincloud/shared state must not be reset. Existing station stubs do not support
measured completed-handoff outcomes.

## Recorded agent integration

The current recorded-incident agent/app path is documented in [RECORDED_RISK_PIPELINE.md](RECORDED_RISK_PIPELINE.md).
It prepares portable bundles, runs validated forecasts through the hazard agent and publishes complete, scoped
resident risk with routing/slack/evidence through the commander. The earlier isolated demo is retained separately.
