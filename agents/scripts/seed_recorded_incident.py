"""Load a prepared replay bundle into the configured database. Replaces the active scenario.

Stations, units and residents in a prepared bundle are synthetic. Discovery of
real emergency stations is a separate future integration.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rescue.config import REPO_ROOT, settings  # noqa: E402
from rescue.forecast_ml.recorded import RecordedIncident  # noqa: E402
from rescue.stdb import SpacetimeClient  # noqa: E402


async def seed(path, run=False, speed=30.0, no_residents=False, demo=False):
    path = Path(path).expanduser()
    path = path if path.is_absolute() else REPO_ROOT / path
    source = RecordedIncident.load(path)
    manifest = json.loads(Path(path).read_text())
    if demo:
        from rescue.demo import demo_fixture
        stations, units, residents = await demo_fixture(source, manifest)
        manifest = {**manifest, 'stations': stations, 'units': units, 'residents': residents}
    g = source.routing_grid
    db = SpacetimeClient("recorded-scenario")
    try:
        await db.call("register_agent", settings.agent_join_key, "scenario", "recorded-loader", 0, "")
        await db.call(
            "load_scenario",
            source.scenario,
            g.origin_lat,
            g.origin_lon,
            g.cell_size_m,
            g.rows,
            g.cols,
            manifest["stations"],
            manifest["units"],
            speed,
            0.0,
            0.0,
        )
        await db.call("upsert_fire_cells", source.fire_cells(0), True, "perimeter")
        await db.call(
            "set_incident",
            source.source_id,
            'Arizona wildfire · July 2020',
            int(source.start_utc_s * 1e6),
            int(source.start_utc_s * 1e6),
            int(source.times_s[-1] * 1e6),
            "Northern Arizona · NIROPS aerial infrared perimeters",
            "",
            "",
        )
        if not no_residents:
            for r in manifest["residents"]:
                await db.call(
                    "submit_help_request_for",
                    f"recorded-demo:{r['request_id']}",
                    "synthetic",
                    r["lat"],
                    r["lon"],
                    r["headcount"],
                    r["needs"],
                    r.get('note', 'Recorded-fire response exercise'),
                    120,
                )
        if run:
            await db.call("set_sim", True, speed)
        print(f"Loaded {source.scenario}; T+0 = UTC {source.start_utc_s}; stations/residents are synthetic")
    finally:
        await db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--speed", type=float, default=30.0)
    parser.add_argument("--no-residents", action="store_true")
    parser.add_argument("--demo", action="store_true", help="three road-access requests chosen from current model/urgency inputs")
    args = parser.parse_args()
    asyncio.run(seed(args.manifest, args.run, args.speed, args.no_residents, args.demo))
