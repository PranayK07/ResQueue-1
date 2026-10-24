"""Shared skeleton for agents whose domain logic is still TODO."""
from __future__ import annotations

from uagents import Context

from ..stdb import Debouncer, Update
from .base import MeshAgent


class StubAgent(MeshAgent):
    """Subscribes to `queries`, logs what changed, and calls `tick()` (debounced)
    whenever any of `watch` tables change. Override `tick()` to do real work."""

    watch: list[str] = []

    async def on_ready(self, ctx: Context) -> None:
        self._debounce = Debouncer(self.tick)
        self.db.on_update(self.watch or None, self._changed)
        ctx.logger.info(f"ready; replica: { {k: len(v) for k, v in self.db.tables.items()} }")

    def _changed(self, upd: Update) -> None:
        self._debounce.trigger()

    async def tick(self) -> None:
        pass
