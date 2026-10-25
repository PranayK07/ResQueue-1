#!/usr/bin/env bash
# Dev loop: (start local SpacetimeDB) -> publish module -> seed demo -> run agents.
#   scripts/dev.sh            # everything
#   scripts/dev.sh db         # publish only (running agents reconnect on their own)
#   scripts/dev.sh reset      # wipe data, republish, reseed
# Target is STDB_SERVER in .env: "local" (default) or "maincloud".
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
[ -f .env ] && set -a && . ./.env && set +a
: "${AGENT_JOIN_KEY:?set AGENT_JOIN_KEY in .env}" "${OPERATOR_PASSCODE:?set OPERATOR_PASSCODE in .env}"
SERVER="${STDB_SERVER:-local}"
DB="${STDB_DB:-wildfire-rescue}"
PY="${PYTHON:-venv/bin/python}"

if [ "$SERVER" = "local" ]; then
  if ! curl -sf http://127.0.0.1:3000/v1/ping >/dev/null; then
    echo "starting SpacetimeDB on :3000 (logs: .stdb-data/server.log)"
    mkdir -p .stdb-data
    spacetime start --listen-addr 127.0.0.1:3000 --data-dir .stdb-data --non-interactive > .stdb-data/server.log 2>&1 &
    until curl -sf http://127.0.0.1:3000/v1/ping >/dev/null; do sleep 0.5; done
  fi
fi

CLEAR=()
[ "${1:-}" = "reset" ] && CLEAR=(--delete-data=always) && rm -rf .agent-state
(cd spacetimedb && npm install --silent)
echo "publishing $DB to $SERVER"
spacetime publish --server "$SERVER" -y ${CLEAR[@]+"${CLEAR[@]}"} "$DB"
[ "${1:-}" = "db" ] && exit 0

if [ "${FIRE_SOURCE:-sim}" = "recorded" ]; then
  : "${RECORDED_INCIDENT_PATH:?set RECORDED_INCIDENT_PATH to a prepared bundle}"
  (cd agents && "../$PY" scripts/seed_recorded_incident.py "$RECORDED_INCIDENT_PATH" --run)
else
  (cd agents && "../$PY" scripts/seed_scenario.py scenarios/paradise_demo.json --run)
fi
cd agents && exec "../$PY" -m rescue.run_all
