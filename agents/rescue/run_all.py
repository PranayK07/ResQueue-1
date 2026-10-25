"""Launch the whole agent mesh, one process per agent (a crash in one agent
never takes down the others). Ctrl-C stops everything.

    python -m rescue.run_all                 # all agents, plus the simulated crews unless SIM_CREWS=0
    python -m rescue.run_all hazard intake   # just these
    python -m rescue.run_all crews           # just the simulated crews (scripts/sim_crews.py)
"""
from __future__ import annotations

import signal
import subprocess
import sys
import time

from .config import AGENTS_ROOT, settings
from .mesh import ROSTER

MODULES = {
    "hazard": ["rescue.agents.hazard"],
    "news": ["rescue.agents.news"],
    "intake": ["rescue.agents.intake"],
    "commander": ["rescue.agents.commander"],
    # Not a uAgent: stands in for the station crews, so dispatched units go en route, on scene and back.
    "crews": ["scripts.sim_crews"],
    "routes": ["scripts.route_worker"],
}


def main() -> None:
    names = sys.argv[1:] or [a.name for a in ROSTER] + (["routes"] if settings.recorded_incident_path else []) + (["crews"] if settings.sim_crews else [])
    if unknown := [n for n in names if n not in MODULES]:
        sys.exit(f"unknown agent(s) {', '.join(unknown)}; choose from {', '.join(MODULES)}")
    procs: dict[str, subprocess.Popen] = {}
    for name in names:
        mod, *args = MODULES[name]
        procs[name] = subprocess.Popen([sys.executable, "-m", mod, *args], cwd=AGENTS_ROOT)
        time.sleep(0.3)  # stagger SpacetimeDB registrations / port binds
    print(f"started: {', '.join(names)}", flush=True)

    def stop(*_):
        for p in procs.values():
            p.terminate()
        for p in procs.values():
            p.wait(timeout=10)
        sys.exit(0)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    while True:
        for name, p in procs.items():
            if p.poll() is not None:
                print(f"[run_all] {name} exited with {p.returncode}", flush=True)
                mod, *args = MODULES[name]
                procs[name] = subprocess.Popen([sys.executable, "-m", mod, *args], cwd=AGENTS_ROOT)
        time.sleep(2)


if __name__ == "__main__":
    main()
