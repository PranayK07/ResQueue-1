"""Read-only diagnostic for the configured agents/database. Prints trace IDs, never locations or raw reports."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rescue.config import settings  # noqa: E402
from rescue.stdb import SpacetimeClient  # noqa: E402


async def main():
    db = SpacetimeClient("risk-diagnostic")
    try:
        await db.call("claim_operator", settings.operator_passcode, "commander", 0, "Risk diagnostic")
        pipeline = await db.sql("SELECT * FROM risk_pipeline")
        cards = await db.sql("SELECT * FROM ops_risk")
        requests = await db.sql("SELECT * FROM ops_request")
        active = {
            r["id"]
            for r in requests
            if r["status"] in ("pending", "queued", "assigned", "en_route", "on_scene")
            and not r["location_purged"]
        }
        covered = {c["assessment"]["request_id"] for c in cards if c["current"]}
        print("pipeline:", pipeline[0]["status"] if pipeline else "absent")
        if pipeline:
            print("forecast:", pipeline[0]["forecast_id"], "reason:", pipeline[0]["reason"])
        print(f"current assessments: {len(active & covered)}/{len(active)} active requests")
        for c in cards:
            r = c["assessment"]
            print(
                f"request={r['request_id']} assessment={r['assessment_id']} forecast={r['forecast_id']} "
                f"state={r['forecast_state']} current={c['current']}"
            )
        return 0 if pipeline and pipeline[0]["status"] == "ready" and active <= covered else 1
    finally:
        await db.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
