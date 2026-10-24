"""Danger agent: slack + level for every active request.

TODO: on forecast/request/road/unit changes:
  1. per station: core.routing.GridRouter.travel_times(station, now, p10 grid, blocked)
  2. per request: fire_eta = arrival_early_s of its cell (or now+horizon),
     slack = core.slack.slack_s(...), level = core.slack.level_for(slack)
  3. publish_danger(assessments, travel)
"""
from ._stub import StubAgent


class DangerAgent(StubAgent):
    queries = [
        "SELECT * FROM sim_clock", "SELECT * FROM grid", "SELECT * FROM station", "SELECT * FROM unit",
        "SELECT * FROM fire_cell", "SELECT * FROM forecast_cell", "SELECT * FROM road_closure",
        "SELECT * FROM ops_request", "SELECT * FROM world_version",
    ]
    watch = ["forecast_cell", "ops_request", "road_closure", "unit"]


if __name__ == "__main__":
    DangerAgent("danger").run()
