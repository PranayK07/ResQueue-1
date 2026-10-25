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
    AgentSpec("intake", "intake", 8, description="Resident-facing: takes help pings and what residents send (text, voice, photos, video), reads them into structured claims (trapped, injured, fire nearby, road blocked) for the commander."),
    AgentSpec("commander", "commander", 9, description="Head agent: orchestrates the hazard, news and intake agents, scores danger and builds the per-station rescue queues (heuristic or RL policy); incident-command console in ASI:One."),
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
