# Wildfire Rescue Queue — commander agent

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

Head agent: orchestrates the hazard, news and intake agents and builds the per-station rescue queues. Also the incident-command console in ASI:One.

**Try it in ASI:One:** "login <passcode>" → "status" → "reports" → "pin 12 to 2" → "wind 15 from 0".

It pools fire + weather (hazard agent), wildfire posts from trusted X accounts (news agent) and what residents report (intake agent), weighs residents' claims against the hazard model and each other, scores every request's slack, and runs the dispatch policy (heuristic, or a reinforcement-learning model) to place each request in a station's queue. Commanders see the pooled picture and residents' reports, and override assignments; the database makes the policy obey.

Part of a multi-agent system coordinating through a shared SpacetimeDB world state.
