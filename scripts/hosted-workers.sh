#!/usr/bin/env bash
# Keep the hosted app's calculations and routes live; does not publish, seed or reset data.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "${HOSTED_ENV_FILE:-.env}" ] && set -a && source "${HOSTED_ENV_FILE:-.env}" && set +a
export STDB_SERVER="${1:-${STDB_SERVER:-maincloud}}"
export STDB_DB="${2:-${STDB_DB:-wildfire-rescue-75xb9}}"
if [ "$STDB_SERVER" = maincloud ]; then export STDB_HTTP=https://maincloud.spacetimedb.com; fi
: "${AGENT_JOIN_KEY:?set AGENT_JOIN_KEY in .env}"
export FIRE_SOURCE=recorded FIRE_FORECAST_BACKEND=learned POLICY=lookahead
export RECORDED_INCIDENT_PATH="${RECORDED_INCIDENT_PATH:-runs/recorded-integration/incident.json}"
export FIRE_FORECAST_CHECKPOINT="${FIRE_FORECAST_CHECKPOINT:-runs/recorded-integration/model.pt}"
export FIRE_FORECAST_METADATA="${FIRE_FORECAST_METADATA:-runs/recorded-integration/model_metadata.json}"
PY="${PYTHON:-.venv-risk/bin/python}"
PY="$("$PY" -c 'import sys; print(sys.executable)')"
cd agents
"$PY" -m scripts.hosted_dispatch &
dispatch_pid=$!
"$PY" -m scripts.route_worker &
route_pid=$!
trap 'kill "$dispatch_pid" "$route_pid" 2>/dev/null || true' EXIT INT TERM
wait "$dispatch_pid" "$route_pid"
