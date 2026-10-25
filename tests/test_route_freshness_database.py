"""Opt-in loopback test: expired routing must invalidate cards and reject publication."""
import asyncio
import os
import uuid

import pytest


@pytest.mark.skipif(not os.environ.get("ROUTE_INTEGRATION_DB"), reason="requires isolated local module")
def test_expired_routing_is_not_a_current_no_route_assessment():
    from rescue.config import settings
    from rescue.core.danger import assess_requests
    from rescue.core.geo import Grid
    from rescue.core.risk import compose_risks, risk_snapshot
    from rescue.planning import risk_to_reducer_args
    from rescue.stdb import ReducerError, SpacetimeClient

    async def run():
        database = os.environ["ROUTE_INTEGRATION_DB"]
        assert database.startswith("wrq-route-")
        prefix = "route-test-" + uuid.uuid4().hex[:8]
        command, hazard, caller = [SpacetimeClient(prefix + name, http="http://127.0.0.1:3000", db=database)
                                   for name in ("command", "hazard", "caller")]
        try:
            await command.call("register_agent", settings.agent_join_key, "scenario", "Route test", 0, "")
            await command.call("load_scenario", "route-test", 35.6, -112.8, 100.0, 10, 10,
                               [{"id": 1, "name": "Station", "lat": 35.6005, "lon": -112.7995}],
                               [{"id": 1, "station_id": 1, "callsign": "R1", "kind": "ambulance", "capacity": 8}],
                               1.0, 0.0, 0.0)
            await command.call("register_agent", settings.agent_join_key, "commander", "Route test", 0, "")
            await hazard.call("register_agent", settings.agent_join_key, "hazard", "Route hazard", 0, "")
            await caller.call("submit_app_request", 35.602, -112.798, 1, "", "", "", 60)

            async def forecast(now):
                versions = (await command.sql("SELECT * FROM world_version"))[0]
                await hazard.call("publish_forecast", versions["weather"], versions["fire"], now, 60.0, 16, [])

            async def assessment():
                versions = (await command.sql("SELECT * FROM world_version"))[0]
                units = await command.sql("SELECT * FROM unit")
                clock = (await command.sql("SELECT * FROM sim_clock"))[0]
                pipelines = await command.sql("SELECT * FROM risk_pipeline")
                snap = risk_snapshot(clock["sim_s"], clock["scenario"], versions, units,
                                     pipeline=pipelines[0] if pipelines else None)
                requests = await command.sql("SELECT * FROM ops_request")
                grid = Grid.from_row((await command.sql("SELECT * FROM grid"))[0])
                dangers, travel = assess_requests(grid, clock["sim_s"],
                    [(r["id"], r["lat"], r["lon"], r["headcount"], r["needs"]) for r in requests],
                    [(1, 35.6005, -112.7995)], {}, set(), [])
                return risk_to_reducer_args(snap, compose_risks(snap, requests, dangers, travel, units, {}), travel)

            await forecast(0.0)
            await command.call("publish_risk_assessments", *await assessment())
            assert (await caller.sql("SELECT * FROM my_risk"))[0]["current"]
            await command.call("set_replay_schedule", [0.0, 60.0])
            await command.call("advance_replay")
            expired = (await caller.sql("SELECT * FROM my_risk"))[0]
            assert not expired["current"] and "Routing forecast expired" in expired["stale_reason"]
            with pytest.raises(ReducerError, match="routing forecast expired"):
                await command.call("publish_risk_assessments", *await assessment())
            # A newly issued valid forecast restores a current assessment.
            await forecast(60.0)
            await command.call("publish_risk_assessments", *await assessment())
            assert (await caller.sql("SELECT * FROM my_risk"))[0]["current"]
        finally:
            for client in (command, hazard, caller):
                await client.close()

    asyncio.run(run())
