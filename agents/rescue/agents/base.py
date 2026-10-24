"""Common scaffolding for every agent in the mesh.

A MeshAgent is a Fetch.ai uAgent that is ALSO a SpacetimeDB client:

  startup:  register_agent(join key, role) -> subscribe(queries) -> on_ready()
  running:  on_update(...) callbacks fire on every relevant committed
            transaction; heartbeat every 10 s; answers StatusQuery messages
  shutdown: close the socket (the module marks the agent offline)
"""
from __future__ import annotations

import logging
from pathlib import Path

from uagents import Agent, Context, Protocol

from ..config import AGENTS_ROOT, settings
from ..mesh import MeshResolver, spec
from ..messages import StatusQuery, StatusReply
from ..stdb import SpacetimeClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


class MeshAgent:
    #: SQL subscription queries this agent needs (tables or views)
    queries: list[str] = []

    def __init__(self, name: str):
        self.spec = spec(name)
        self.name = name
        self.role = self.spec.role
        self.log = logging.getLogger(name)
        mailbox = settings.uses_mailbox(name)
        readme = AGENTS_ROOT / "agent_readmes" / f"{name}.md"
        self.agent = Agent(
            name=f"wildfire-{name}",
            seed=self.spec.seed,
            port=self.spec.port,
            mailbox=mailbox,
            endpoint=None if mailbox else [self.spec.endpoint],
            resolve=MeshResolver(),
            readme_path=str(readme) if readme.exists() else None,
            description=self.spec.description,
            handle=f"{settings.handle_prefix}-{name}" if settings.handle_prefix else None,
            publish_agent_details=True,
        )
        self.db = SpacetimeClient(name)
        self.status = "starting"
        self.detail = ""

        status = Protocol(name="mesh-status", version="0.1.0")

        @status.on_message(StatusQuery, replies=StatusReply)
        async def _status(ctx: Context, sender: str, _msg: StatusQuery):
            await ctx.send(sender, StatusReply(name=self.name, role=self.role, status=self.status, detail=self.detail))

        self.agent.include(status)

        @self.agent.on_event("startup")
        async def _startup(ctx: Context):
            await self._join(ctx)

        @self.agent.on_event("shutdown")
        async def _shutdown(_ctx: Context):
            await self.db.close()

        @self.agent.on_interval(period=10.0)
        async def _heartbeat(_ctx: Context):
            if self.db.identity:
                await self.db.try_call("agent_heartbeat", self.status, self.detail)

    async def _join(self, ctx: Context) -> None:
        ctx.logger.info(f"{self.name} ({self.role}) address {self.agent.address}")
        await self.db.call(
            "register_agent", settings.agent_join_key, self.role, self.name, self.spec.station_id, self.agent.address
        )
        await self.db.connect(self.queries)
        self.status = "online"
        await self.on_ready(ctx)

    async def on_ready(self, ctx: Context) -> None:
        """Override: subscriptions are live and the replica is populated."""

    def set_status(self, status: str, detail: str = "") -> None:
        self.status, self.detail = status, detail

    # Convenience accessors for singletons every agent reads.
    def sim_now(self) -> float:
        c = self.db.tables.get("sim_clock")
        row = c.one() if c else None
        return row["sim_s"] if row else 0.0

    def run(self) -> None:
        self.agent.run()


def readme_path(name: str) -> Path:
    return AGENTS_ROOT / "agent_readmes" / f"{name}.md"
