"""Station agent (one process per station): runs its units' missions.

Usage: python -m rescue.agents.station 1

TODO: for units in status 'assigned' -> unit_en_route(arrive_at, free_at);
  stream unit_position while driving; unit_on_scene at arrival;
  complete_mission after extract time; unit_available when back.
  Sees only its own queue (ops_request/ops_queue are station-scoped).
"""
import sys

from ._stub import StubAgent


class StationAgent(StubAgent):
    queries = ["SELECT * FROM sim_clock", "SELECT * FROM unit", "SELECT * FROM ops_queue", "SELECT * FROM ops_request"]
    watch = ["unit", "ops_queue", "sim_clock"]


if __name__ == "__main__":
    StationAgent(f"station-{sys.argv[1] if len(sys.argv) > 1 else 1}").run()
