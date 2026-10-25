#!/usr/bin/env bash
# One reproducible recorded-fire demo. Existing ordinary dev/cloud databases are not reset.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
if [ -f .env ]; then set -a; source .env; set +a; fi
: "${AGENT_JOIN_KEY:?set AGENT_JOIN_KEY in .env}" "${OPERATOR_PASSCODE:?set OPERATOR_PASSCODE in .env}"
export STDB_SERVER=local STDB_HTTP=http://127.0.0.1:3000 STDB_DB="${DEMO_STDB_DB:-wildfire-arizona-demo}"
export FIRE_SOURCE=recorded FIRE_FORECAST_BACKEND=learned POLICY=lookahead
export RECORDED_INCIDENT_PATH=runs/recorded-integration/incident.json
export FIRE_FORECAST_CHECKPOINT=runs/recorded-integration/model.pt FIRE_FORECAST_METADATA=runs/recorded-integration/model_metadata.json
export FIRE_FORECAST_HORIZONS_S=21600,43200,86400 WEATHER_SOURCE=scenario NEWS_SOURCE=off MAILBOX_AGENTS=none INTAKE_ANALYZER=keywords
export SIM_CREWS=1 AGENT_BASE_PORT=8300 AGENT_SEED_PREFIX="${DEMO_AGENT_SEED_PREFIX:-arizona-replay-local}"
PY="${PYTHON:-.venv-risk/bin/python}"
PY="$("$PY" -c 'import sys; print(sys.executable)')"
if ! curl -fsS "$STDB_HTTP/v1/ping" >/dev/null; then
  mkdir -p .stdb-data
  spacetime start --listen-addr 127.0.0.1:3000 --data-dir .stdb-data --non-interactive > .stdb-data/demo-server.log 2>&1 &
  for attempt in {1..20}; do curl -fsS "$STDB_HTTP/v1/ping" >/dev/null && break; sleep .5; done
fi
[ -d spacetimedb/node_modules ] || npm --prefix spacetimedb ci --silent
"$PY" agents/scripts/prepare_demo_roads.py
spacetime publish --server local --module-path spacetimedb -y "$STDB_DB"
if [ "${1:-}" != "run" ]; then
  (cd agents && "$PY" scripts/seed_recorded_incident.py "$RECORDED_INCIDENT_PATH" --demo --speed 30)
fi
cat > web/.env.local <<EOF
VITE_DATA_SOURCE=live
VITE_DEMO_MODE=true
VITE_STDB_URI=ws://127.0.0.1:3000
VITE_STDB_DB=$STDB_DB
EOF
cd agents
exec "$PY" -m rescue.run_all
