"""Opt-in regression for real resident -> command -> responder subscriptions.

Use an isolated local wrq-web-* database with WEB_FLOW_HTTP/DB/PASSCODE/JOIN_KEY.
No agent mesh or forecast model is needed to receive and manually dispatch a call.
"""
import asyncio
import json
import os
from pathlib import Path
import uuid
from urllib.parse import urlparse

import pytest


@pytest.mark.skipif(not os.environ.get("WEB_FLOW_HTTP"), reason="requires isolated local web-flow database")
def test_resident_dispatch_visibility_privacy_and_moved_pin():
    from rescue.stdb import ReducerError, SpacetimeClient

    async def run():
        http, database = os.environ["WEB_FLOW_HTTP"], os.environ["WEB_FLOW_DB"]
        assert urlparse(http).hostname in {"127.0.0.1", "localhost"}
        assert database.startswith("wrq-web-")
        prefix = "web-flow-" + uuid.uuid4().hex[:8]
        clients = [SpacetimeClient(prefix + role, http=http, db=database)
                   for role in ("command", "resident", "other", "crew", "wrong-station", "planner")]
        command, resident, other, crew, wrong_station, planner = clients

        async def until(check):
            stop = asyncio.get_running_loop().time() + 10
            while asyncio.get_running_loop().time() < stop:
                if value := check():
                    return value
                await asyncio.sleep(0.05)
            raise AssertionError("subscription did not receive the committed request")

        try:
            passcode = os.environ["WEB_FLOW_PASSCODE"]
            await command.call("claim_operator", passcode, "commander", 0, "Web regression")
            scenario = json.loads((Path(__file__).parents[1] / "agents/scenarios/paradise_demo.json").read_text())
            grid = scenario["grid"]
            await command.call("load_scenario", "web-flow-regression", grid["origin_lat"], grid["origin_lon"],
                               grid["cell_size_m"], grid["rows"], grid["cols"], scenario["stations"], scenario["units"], 1.0, 0.0, 0.0)
            await crew.call("claim_operator", passcode, "responder", 1, "Crew one")
            await wrong_station.call("claim_operator", passcode, "responder", 2, "Other station")
            await command.connect(["SELECT * FROM ops_request", "SELECT * FROM ops_queue"])
            await crew.connect(["SELECT * FROM ops_request", "SELECT * FROM ops_queue", "SELECT * FROM unit"])
            await resident.connect(["SELECT * FROM my_requests"])
            await resident.call("submit_help_request", 39.765, -121.60, 2, "medical", "Web regression", 60)
            card = (await until(lambda: next(iter(resident.table("my_requests")), None)))
            rid = card["request_id"]
            received = await until(lambda: next((r for r in command.table("ops_request") if r["id"] == rid), None))
            assert received["status"] == "pending"
            assert list(command.table("ops_queue")) == []  # reception never waits for a plan
            assert await other.sql("SELECT * FROM my_requests") == []
            assert await wrong_station.sql("SELECT * FROM ops_request") == []
            with pytest.raises(ReducerError, match="already have an active"):
                await resident.call("submit_help_request", 39.765, -121.60, 2, "", "retry", 60)
            with pytest.raises(ReducerError, match="requires commander"):
                await resident.call("assign_to_unit", rid, 1)

            await planner.call("register_agent", os.environ["WEB_FLOW_JOIN_KEY"], "commander", "Test planner", 0, "")
            blocked = [dict(request_id=rid, station_id=s, travel_s=1e9, reachable=False) for s in (1, 2, 3)]
            await planner.call("publish_danger", [dict(request_id=rid, level="unreachable", slack_s=-1e9,
                               fire_eta_s=3600.0, extract_s=300.0)], blocked)
            assert (await command.sql("SELECT * FROM ops_request"))[0]["slack_s"] is None
            await planner.call("publish_plan", "regression", [], [dict(request_id=rid, detail="no safe ground route", recommendation="Review")])
            assert any(not flag["resolved"] for flag in await command.sql("SELECT * FROM ops_flag"))
            reachable = [dict(request_id=rid, station_id=s, travel_s=100.0, reachable=True) for s in (1, 2, 3)]
            await planner.call("publish_danger", [dict(request_id=rid, level="moderate", slack_s=2900.0,
                               fire_eta_s=3600.0, extract_s=300.0)], reachable)
            await planner.call("publish_plan", "regression", [dict(request_id=rid, station_id=1, rank=1,
                               unit_id=0, eta_s=100.0, reason="Route recovered", resident_reason="Waiting for a crew")], [])
            assert all(flag["resolved"] for flag in await command.sql("SELECT * FROM ops_flag"))

            await command.call("assign_to_unit", rid, 1)
            await command.call("assign_to_unit", rid, 1)  # repeated dispatch is idempotent
            seen = await until(lambda: next((r for r in crew.table("ops_request") if r["id"] == rid), None))
            assert (seen["lat"], seen["lon"]) == (39.765, -121.60)
            queue = await until(lambda: next((q for q in crew.table("ops_queue") if q["request_id"] == rid), None))
            assert queue["unit_id"] == 1
            assert await wrong_station.sql("SELECT * FROM ops_request") == []
            await until(lambda: any(c["unit_callsign"] == "E81" for c in resident.table("my_requests")))
            with pytest.raises(ReducerError, match="committed"):
                await command.call("assign_to_unit", rid, 3)

            await other.call("submit_help_request", 39.766, -121.60, 1, "", "Second request", 60)
            second = (await other.sql("SELECT * FROM my_requests"))[0]["request_id"]
            with pytest.raises(ReducerError, match="not available"):
                await command.call("assign_to_unit", second, 1)
            with pytest.raises(ReducerError, match="not your request"):
                await other.call("update_my_request", rid, 39.766, -121.599, 2, "medical", "Hijack")
            await resident.call("update_my_request", rid, 39.766, -121.599, 3, "mobility", "Entrance: Front gate\nUpdated pin")
            moved = await until(lambda: next((r for r in crew.table("ops_request") if r["id"] == rid and r["lon"] == -121.599), None))
            assert moved["headcount"] == 3 and moved["needs"] == "mobility"

            await planner.call("publish_plan", "regression", [], [])
            assert (await crew.sql("SELECT * FROM ops_queue"))[0]["request_id"] == rid
            await resident.call("close_my_request", rid, "", "safe")
            closed = await until(lambda: next((c for c in resident.table("my_requests") if c["status"] == "safe"), None))
            assert closed["lat"] == 0 and closed["lon"] == 0 and closed["note"] == ""
            await until(lambda: not any(r["id"] == rid for r in crew.table("ops_request")))
            await command.call("assign_to_unit", second, 3)
            assert await crew.sql("SELECT * FROM ops_request") == []
            await wrong_station.call("unit_en_route", 3, 120.0, 300.0)
            assert (await other.sql("SELECT * FROM my_requests"))[0]["status"] == "en_route"
            await wrong_station.call("unit_on_scene", 3)
            assert (await other.sql("SELECT * FROM my_requests"))[0]["status"] == "on_scene"
            await wrong_station.call("complete_mission", 3, "rescued")
            rescued = (await other.sql("SELECT * FROM my_requests"))[0]
            assert rescued["status"] == "rescued" and rescued["lat"] == 0 and rescued["lon"] == 0
        finally:
            for client in clients:
                await client.close()

    asyncio.run(run())
