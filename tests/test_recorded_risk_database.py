"""Opt-in test against a running recorded hazard/commander/intake mesh.

Requires an isolated loopback wrq-recorded-* database; never targets shared/cloud data.
See docs/RECORDED_RISK_PIPELINE.md. Normal CI skips this test.
"""

import asyncio
import os
import uuid
from urllib.parse import urlparse

import pytest


@pytest.mark.skipif(
    not os.environ.get("RISK_INTEGRATION_HTTP"), reason="requires isolated running recorded agent mesh"
)
def test_live_recorded_agents_transfer_predictions_evidence_and_private_views():
    pytest.importorskip("httpx")
    from rescue.stdb import SpacetimeClient, ReducerError
    from rescue.planning import risk_to_reducer_args

    async def run():
        http = os.environ["RISK_INTEGRATION_HTTP"]
        database = os.environ["RISK_INTEGRATION_DB"]
        assert urlparse(http).hostname in {"127.0.0.1", "localhost"}
        assert database.startswith("wrq-recorded-")
        prefix = "risk-integration-" + uuid.uuid4().hex[:8]
        clients = [
            SpacetimeClient(prefix + name, http=http, db=database)
            for name in ("-commander", "-resident", "-outsider", "-hazard", "-responder")
        ]
        command, resident, outsider, hazard, responder = clients
        rid = None

        async def until(check, timeout=45):
            stop = asyncio.get_running_loop().time() + timeout
            while asyncio.get_running_loop().time() < stop:
                result = await check()
                if result:
                    return result
                await asyncio.sleep(0.2)
            raise AssertionError("recorded agent propagation did not complete")

        try:
            await command.call(
                "claim_operator", os.environ["RISK_INTEGRATION_PASSCODE"], "commander", 0, "Test"
            )

            async def ready():
                rows = await command.sql("SELECT * FROM risk_pipeline")
                return rows and rows[0]["status"] == "ready"

            await until(ready)
            await command.call(
                "register_agent",
                os.environ["RISK_INTEGRATION_JOIN_KEY"],
                "commander",
                "Test commander",
                0,
                "",
            )
            req = next(r for r in await command.sql("SELECT * FROM ops_request") if not r["location_purged"])
            await resident.call(
                "submit_help_request", req["lat"], req["lon"], 1, "", "Integration fixture", 15
            )
            rid = (await resident.sql("SELECT * FROM my_requests"))[0]["request_id"]
            await resident.connect(["SELECT * FROM my_risk"])

            async def risk():
                rows = list(resident.table("my_risk"))
                return next((c for c in rows if c["current"] and c["assessment"]["probabilities"]), None)

            card = await until(risk)
            assert card["assessment"]["request_id"] == rid
            assert await outsider.sql("SELECT * FROM my_risk") == []
            await hazard.call(
                "register_agent", os.environ["RISK_INTEGRATION_JOIN_KEY"], "hazard", "Test hazard", 0, ""
            )
            assert await hazard.sql("SELECT * FROM ops_risk") == []
            # Verify every delivered probability matches the geographic layer, without rounding.
            from rescue.forecast_ml.bridge import product_from_rows

            meta = (await command.sql("SELECT * FROM fire_risk_meta"))[0]
            product = product_from_rows(meta, await command.sql("SELECT * FROM fire_risk_cell"))
            rc = product.grid.locate_rc(req["lat"], req["lon"])
            assert card["assessment"]["probabilities"] == [float(p[rc]) for p in product.probabilities]
            # A real resident report goes through intake messages, commander recording, weighing, and risk publication.
            await resident.call(
                "submit_report",
                rid,
                "",
                "text",
                "4 of us, grandma uses a wheelchair; my son is injured",
                "",
                "",
            )

            async def evidence():
                c = await risk()
                return c if c and c["assessment"]["headcount"] == 4 and c["assessment"]["injured"] else None

            updated = (await until(evidence))["assessment"]
            assert "medical" in updated["needs"] and "mobility" in updated["needs"]
            assert updated["extract_s"] > card["assessment"]["extract_s"]
            # A station sees exactly the assessments for its queue; a resident sees only their own.
            await responder.call(
                "claim_operator", os.environ["RISK_INTEGRATION_PASSCODE"], "responder", 1, "Test station"
            )
            station_risk = await responder.sql("SELECT * FROM ops_risk")
            station_queue = await responder.sql("SELECT * FROM ops_queue")
            assert {c["assessment"]["request_id"] for c in station_risk} <= {
                q["request_id"] for q in station_queue
            }
            # Snapshot captured before a wind update cannot be relabeled as a new assessment.
            snapshot_keys = (
                "scenario",
                "assessed_at_s",
                "units_stamp",
                "weather_version",
                "fire_version",
                "roads_version",
                "requests_version",
                "forecast_version",
                "risk_updated_at",
                "pipeline_updated_at",
            )
            snapshot = {k: updated[k] for k in snapshot_keys}
            row = {
                k: v for k, v in updated.items() if k not in (*snapshot_keys, "updated_at", "danger_version")
            }
            await command.call("set_sim", True, 1.0)
            await command.call("set_weather", 3.0, 90.0, 3.0, "test")
            with pytest.raises(ReducerError, match="stale risk assessment snapshot"):
                await command.call("publish_risk_assessments", *risk_to_reducer_args(snapshot, [row], []))

            async def refreshed():
                c = await risk()
                return c if c and c["assessment"]["weather_version"] > updated["weather_version"] else None

            await until(refreshed)
            await resident.call("close_my_request", rid, "", "revoked")
            rid = None

            async def purged():
                return not list(resident.table("my_risk"))

            assert await until(purged)
            await command.call("set_sim", False, 1.0)

            async def settled():
                cards = await command.sql("SELECT * FROM ops_risk")
                active = {
                    r["id"]
                    for r in await command.sql("SELECT * FROM ops_request")
                    if r["status"] in ("pending", "queued", "assigned", "en_route", "on_scene")
                    and not r["location_purged"]
                }
                current = {c["assessment"]["request_id"] for c in cards if c["current"]}
                return active <= current

            assert await until(settled)  # fractional paused clock and consent change must eventually settle
        finally:
            await command.try_call("set_sim", False, 1.0)
            if rid is not None:
                await resident.try_call("close_my_request", rid, "", "revoked")
            for c in clients:
                await c.close()

    asyncio.run(run())
