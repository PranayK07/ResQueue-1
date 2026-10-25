"""The commander agent's orchestration engines. The commander is the one head agent: it pools its three
subagents (hazard, news, intake) and turns the pooled picture into per-station queues.

  reports   weighs residents' field reports from the intake agent (core/reports.py): how much of each claim
            moves the automatic queue order
  danger    slack + level + travel time per request (core/danger.py), with the accepted report adjustments
  planner   synthesis (hazard + news + reports -> Situation) and the dispatch policy (heuristic or RL)

They live in one agent because they share one picture and run in sequence on every change; separate agents
are kept for separate data sources (hazard: fire + weather, news: X posts, intake: residents)."""
