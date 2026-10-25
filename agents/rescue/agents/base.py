"""Common scaffolding for every agent in the mesh.

A MeshAgent is a Fetch.ai uAgent that is ALSO a SpacetimeDB client:

  startup:  register_agent(join key, role) -> subscribe(queries) -> on_ready()
  running:  on_update(...) callbacks fire on every relevant committed
            transaction; heartbeat every 10 s; answers StatusQuery messages
  shutdown: close the socket (the module marks the agent offline)
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from uagents import Agent, Context, Model, Protocol

from ..config import AGENTS_ROOT, settings
from ..mesh import MeshResolver, address_of, spec
from ..messages import StatusQuery, StatusReply
from ..stdb import SpacetimeClient

ASK_TIMEOUT_S = 8
READY_WAIT_S = 6.0

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
        # Set once this agent's copy of the world is loaded. Message handlers must wait for it:
        # answering earlier would report an empty world (fire 0, wind 0) as if it were real.
        self.ready = asyncio.Event()
        self.status = "starting"
        self.detail = ""
        self.parts: dict[str, tuple[str, str]] = {}
        self._ask_locks: dict[str, asyncio.Lock] = {}

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
        self.ready.set()

    async def on_ready(self, ctx: Context) -> None:
        """Override: subscriptions are live and the replica is populated."""

    async def when_ready(self, ctx: Context, wait: float = READY_WAIT_S) -> bool:
        """For message handlers: True once the world is loaded; False (so don't reply) if it isn't within `wait` s.
        The asker times out and treats us as silent, which is correct: better no answer than an empty one."""
        if self.ready.is_set():
            return True
        try:
            await asyncio.wait_for(self.ready.wait(), wait)
            return True
        except asyncio.TimeoutError:
            ctx.logger.warning("message received before startup finished; not answering")
            return False

    def set_status(self, status: str, detail: str = "") -> None:
        self.status, self.detail = status, detail

    def set_part(self, part: str, status: str, detail: str) -> None:
        """Agents made of engines report each engine's health; the agent's status is the worst of them."""
        self.parts[part] = (status, detail)
        bad = [s for s, _ in self.parts.values() if s == "degraded"]
        self.set_status("degraded" if bad else "online", " | ".join(f"{p}: {d}" for p, (_, d) in sorted(self.parts.items())))

    async def ask(self, ctx: Context, agent: str, req: Model, resp_type: type[Model], timeout: int = ASK_TIMEOUT_S) -> Model | None:
        """Ask another mesh agent a question and wait for its typed reply (None if it doesn't answer).
        uAgents keys pending replies by (sender, destination, session), so two concurrent requests to the SAME
        agent collide: they are serialized here. Different agents in parallel are fine."""
        lock = self._ask_locks.setdefault(agent, asyncio.Lock())
        try:
            async with lock:
                reply, status = await ctx.send_and_receive(address_of(agent), req, response_type=resp_type, timeout=timeout)
        except Exception as e:  # noqa: BLE001
            ctx.logger.warning(f"asking {agent} failed: {e}")
            return None
        if reply is None:
            ctx.logger.warning(f"{agent} did not answer: {status.detail if status else 'timeout'}")
        return reply if isinstance(reply, resp_type) else None

    # Convenience accessors for singletons every agent reads.
    def sim_now(self) -> float:
        c = self.db.tables.get("sim_clock")
        row = c.one() if c else None
        return row["sim_s"] if row else 0.0

    def run(self) -> None:
        self.agent.run()


def readme_path(name: str) -> Path:
    return AGENTS_ROOT / "agent_readmes" / f"{name}.md"
