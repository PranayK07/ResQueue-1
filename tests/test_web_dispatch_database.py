"""Opt-in, isolated loopback regression for the actual caller -> command -> crew contract.

Publish the module to a wrq-web-flow-* database, set WEB_FLOW_DB and run this
test. It never reads or resets a shared/cloud incident.
"""
import asyncio
import os
import uuid

import pytest


@pytest.mark.skipif(not os.environ.get("WEB_FLOW_DB"), reason="requires isolated local module")
def test_caller_receipt_dispatch_location_updates_and_privacy():
    from rescue.config import settings
    from rescue.stdb import ReducerError, SpacetimeClient

    async def run():
        database = os.environ["WEB_FLOW_DB"]
        assert database.startswith("wrq-web-flow-")
        prefix = "web-flow-" + uuid.uuid4().hex[:8]
        clients = [SpacetimeClient(prefix + name, http="http://127.0.0.1:3000", db=database)
                   for name in ("command", "caller", "other", "crew", "other-crew")]
        command, caller, other, crew, other_crew = clients
        try:
            await command.call("register_agent", settings.agent_join_key, "scenario", "Web flow test", 0, "")
            await command.call("load_scenario", "web-flow", 35.6, -112.8, 100.0, 100, 100,
                               [{"id": 1, "name": "West", "lat": 35.61, "lon": -112.79},
                                {"id": 2, "name": "East", "lat": 35.62, "lon": -112.78}],
                               [{"id": 1, "station_id": 1, "callsign": "R1", "kind": "ambulance", "capacity": 8}],
                               1.0, 0.0, 0.0)
            await crew.call("claim_operator", settings.operator_passcode, "responder", 1, "Crew")
            await other_crew.call("claim_operator", settings.operator_passcode, "responder", 2, "Other crew")
            args = (35.63, -112.77, 1, "mobility", "Front gate", "Side entrance", 60)
            await caller.call("submit_app_request", *args)
            await caller.call("submit_app_request", *args)  # retry is idempotent
            cards = await caller.sql("SELECT * FROM my_requests")
            assert len(cards) == 1 and cards[0]["status"] == "pending"
            rid = cards[0]["request_id"]
            assert cards[0]["entrance"] == "Side entrance"
            assert await other.sql("SELECT * FROM my_requests") == []
            assert await crew.sql("SELECT * FROM ops_request") == []
            assert any(r["id"] == rid for r in await command.sql("SELECT * FROM ops_request"))
            with pytest.raises(ReducerError):
                await caller.call("assign_request_to_unit", rid, 1)
            await command.call("assign_request_to_unit", rid, 1)
            assert (await caller.sql("SELECT * FROM my_requests"))[0]["unit_id"] == 1
            assert (await crew.sql("SELECT * FROM ops_queue"))[0]["request_id"] == rid
            assert (await crew.sql("SELECT * FROM ops_request"))[0]["lat"] == 35.63
            assert await other_crew.sql("SELECT * FROM ops_request") == []
            with pytest.raises(ReducerError):
                await other.call("update_my_request", rid, 35.64, -112.76, 2, "", "", "")
            before = (await caller.sql("SELECT * FROM world_version"))[0]["requests"]
            await caller.call("update_my_request", rid, 35.64, -112.76, 2, "medical", "Updated", "Front entrance")
            row = (await crew.sql("SELECT * FROM ops_request"))[0]
            assert (row["lat"], row["lon"], row["headcount"], row["entrance"]) == (35.64, -112.76, 2, "Front entrance")
            assert (await caller.sql("SELECT * FROM world_version"))[0]["requests"] > before
            await other.call("submit_app_request", 35.65, -112.75, 1, "", "Second", "", 60)
            other_id = (await other.sql("SELECT * FROM my_requests"))[0]["request_id"]
            with pytest.raises(ReducerError, match="unit is not available"):
                await command.call("assign_request_to_unit", other_id, 1)
            assert (await other.sql("SELECT * FROM my_requests"))[0]["unit_id"] == 0
            versions = (await command.sql("SELECT * FROM world_version"))[0]
            await command.call("publish_unit_route", 1, rid, 35.64, -112.76,
                [dict(lat=35.61,lon=-112.79,name='Fixture road'), dict(lat=35.64,lon=-112.76,name='Fixture road')],
                600.0, "ready", "Isolated route fixture", "web-flow-route", versions["fire"], versions["roads"])
            await crew.call("unit_en_route", 1, 600.0, 1500.0)
            assert (await caller.sql("SELECT * FROM my_requests"))[0]["status"] == "en_route"
            await crew.call("unit_on_scene", 1)
            await crew.call("complete_mission", 1, "rescued")
            closed = (await caller.sql("SELECT * FROM my_requests"))[0]
            assert closed["status"] == "rescued" and closed["lat"] == closed["lon"] == 0
            assert closed["entrance"] == "" and await crew.sql("SELECT * FROM ops_request") == []
            await command.call("set_replay_schedule", [0.0, 600.0, 1200.0])
            with pytest.raises(ReducerError):
                await caller.call("advance_replay")
            await command.call("advance_replay")
            clock = (await caller.sql("SELECT * FROM sim_clock"))[0]
            assert clock["sim_s"] == 600.0 and not clock["running"]
        finally:
            for client in clients:
                await client.close()

    asyncio.run(run())
