"""Delegation agent: per-station queues via the policy in core.policy.

TODO: when world_version.danger or unit availability changes, build a
  core.policy.PlanInput from ops_request + ops_travel + unit + station,
  run LearnedPolicy (falls back to LookaheadPolicy) and call
  publish_plan(policy, entries, unreachable). Answer ComparePolicies /
  ExplainRequest messages from the commander.
"""
from ._stub import StubAgent


class DelegationAgent(StubAgent):
    queries = [
        "SELECT * FROM sim_clock", "SELECT * FROM station", "SELECT * FROM unit", "SELECT * FROM ops_request",
        "SELECT * FROM ops_travel", "SELECT * FROM ops_queue", "SELECT * FROM world_version",
    ]
    watch = ["world_version", "unit"]


if __name__ == "__main__":
    DelegationAgent("delegation").run()
