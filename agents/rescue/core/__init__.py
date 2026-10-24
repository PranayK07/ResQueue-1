"""Pure, dependency-light models shared by the live agents and the RL simulator.

Keep this package free of network / uAgents imports so the Gym environment
can train against exactly the same fire, routing and slack math the live
system uses.
"""
