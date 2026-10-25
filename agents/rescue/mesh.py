"""The agent roster: names, roles, ports, seeds and addresses.

Every agent's Fetch address is derived from AGENT_SEED_PREFIX + its name, so
any agent can compute any other agent's address offline. `MeshResolver`
routes messages between our own agents straight to their local endpoints
(no round-trip through Agentverse) and falls back to the global Almanac for
everyone else (ASI:One, users' agents).
"""
from __future__ import annotations

from dataclasses import dataclass

from uagents.crypto import Identity
from uagents.resolver import GlobalResolver, Resolver

from .config import settings


@dataclass(frozen=True)
class AgentSpec:
    name: str
    role: str
    port_offset: int
    station_id: int = 0
    description: str = ""

    @property
    def port(self) -> int:
        return settings.base_port + self.port_offset

    @property
    def seed(self) -> str:
        return f"{settings.seed_prefix}:{self.name}"

    @property
    def address(self) -> str:
        return Identity.from_seed(self.seed, 0).address

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self.port}/submit"


ROSTER: list[AgentSpec] = [
    AgentSpec("hazard", "hazard", 0, description="Owns the hazard picture: fire perimeter (NASA FIRMS / simulated spread), live NWS wind, and the ensemble fire-arrival forecast."),
    AgentSpec("news", "news", 1, description="Follows trusted wildfire accounts on X near the incident (fire agencies, sheriffs, NWS, Caltrans, Red Cross) via Bright Data and extracts evacuation orders, road closures, shelters, containment and acreage for the commander."),
    AgentSpec("danger", "danger", 3, description="Time-dependent routing + slack scoring for every help request."),
    AgentSpec("delegation", "delegation", 4, description="Builds per-station rescue queues with the learned/heuristic policy."),
    AgentSpec("station-1", "station", 5, station_id=1, description="Station 1 dispatcher: runs its units' missions."),
    AgentSpec("station-2", "station", 6, station_id=2, description="Station 2 dispatcher: runs its units' missions."),
    AgentSpec("station-3", "station", 7, station_id=3, description="Station 3 dispatcher: runs its units' missions."),
    AgentSpec("intake", "intake", 8, description="ASI:One resident help desk: request rescue, check queue status, mark safe."),
    AgentSpec("commander", "commander", 9, description="ASI:One incident-commander console: situation, escalations, overrides."),
]
BY_NAME = {a.name: a for a in ROSTER}


def spec(name: str) -> AgentSpec:
    return BY_NAME[name]


def address_of(name: str) -> str:
    return BY_NAME[name].address


class MeshResolver(Resolver):
    def __init__(self) -> None:
        # Every agent (mailbox ones too) serves /submit on its local port, so
        # mesh-internal traffic never leaves the machine.
        self._local = {a.address: a.endpoint for a in ROSTER}
        self._global = GlobalResolver()

    async def resolve(self, destination: str) -> tuple[str | None, list[str]]:
        if destination in self._local:
            return destination, [self._local[destination]]
        return await self._global.resolve(destination)


if __name__ == "__main__":  # python -m rescue.mesh  -> table for the README
    print("| Agent | Role | Port | Address |\n|---|---|---|---|")
    for a in ROSTER:
        print(f"| wildfire-{a.name} | {a.role} | {a.port} | `{a.address}` |")
