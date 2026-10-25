"""Run the app's forecast and LOOKAHEAD engines without opening an HTTP agent port.

Uses the same SpacetimeDB subscriptions, trained U-Net, risk and policy engines
as the Fetch.ai mesh. It does not seed/reset the incident or fabricate scores.
"""
from __future__ import annotations
import asyncio
import logging
from types import SimpleNamespace

from rescue.config import settings
from rescue.stdb import SpacetimeClient
from rescue.agents.hazard import HazardAgent
from rescue.agents.commander import CommanderAgent
from rescue.forecast_ml.recorded import RecordedIncident
from rescue.hazard.fire import FireEngine
from rescue.hazard.forecast import ForecastEngine
from rescue.orchestrator.danger import DangerEngine
from rescue.orchestrator.planner import Planner
from rescue.orchestrator.reports import ReportsEngine

log = logging.getLogger('hosted-dispatch')


class Host:
    def __init__(self, name, role, queries):
        self.name, self.role, self.queries = name, role, queries
        self.db = SpacetimeClient(name)
        self.log = logging.getLogger(name)
        self.ready = asyncio.Event()
        self.parts = {}
        self.recorded = RecordedIncident.load(settings.recorded_incident_path)
        self.recorded_error = ''

    def sim_now(self):
        clock = self.db.table('sim_clock').one()
        return clock['sim_s'] if clock else 0.0

    def set_part(self, part, status, detail):
        self.parts[part] = status, detail

    async def connect(self):
        await self.db.call('register_agent', settings.agent_join_key, self.role, self.name, 0, '')
        await self.db.connect(self.queries, timeout=60)

    async def heartbeat(self):
        status = 'degraded' if any(s == 'degraded' for s, _ in self.parts.values()) else 'online'
        detail = ' | '.join(f'{name}: {detail}' for name, (_, detail) in sorted(self.parts.items()))
        await self.db.try_call('agent_heartbeat', status, detail[:200])


async def run():
    hazard = Host('hosted-hazard', 'hazard', HazardAgent.queries + ['SELECT * FROM forecast_meta'])
    command = Host('hosted-dispatch', 'commander', CommanderAgent.queries)
    hazard.fire, hazard.forecast = FireEngine(hazard), ForecastEngine(hazard)
    command.reports, command.planner = ReportsEngine(command), Planner(command)
    command.danger = DangerEngine(command)
    try:
        await hazard.connect()
        await command.connect()
        ctx = SimpleNamespace(logger=log)
        await hazard.fire.on_ready(ctx)
        hazard.ready.set()
        await hazard.forecast.on_ready(ctx)
        command.ready.set()
        command.danger.on_ready()
        command.planner.on_ready(ctx)
        log.info('Connected to %s on %s; existing incident preserved', settings.stdb_db, settings.stdb_http)
        tick = 0
        while True:
            try:
                await hazard.fire.tick()
                await hazard.forecast.recorded_tick()
                if tick % 5 == 0:
                    # Safety ticks also recover a failed callback or a missed initial forecast update.
                    metadata = hazard.db.table('forecast_meta').one()
                    versions = hazard.db.table('world_version').one()
                    if not metadata or any(metadata[key + '_version'] != versions[key] for key in ('fire', 'weather')):
                        await hazard.forecast.tick()
                    await command.danger.assess()
                    await command.planner.plan()
                    await asyncio.gather(hazard.heartbeat(), command.heartbeat())
            except Exception:
                log.exception('Worker cycle failed; retrying current database inputs')
            tick += 1
            await asyncio.sleep(1)
    finally:
        await hazard.db.close()
        await command.db.close()


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
    asyncio.run(run())
