"""Load a scenario into SpacetimeDB, ignite the fire, add synthetic residents.

    python scripts/seed_scenario.py scenarios/paradise_demo.json [--run] [--no-residents]

Acts as the `scenario` agent (allowed to load worlds and file synthetic
requests). Everything it creates is synthetic.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rescue import incidents  # noqa: E402
from rescue.config import settings  # noqa: E402
from rescue.core.geo import M_PER_DEG_LAT, Grid  # noqa: E402
from rescue.stdb import SpacetimeClient  # noqa: E402

NEEDS = ["", "", "", "mobility", "medical", "infant", "elderly", "pets", "mobility,medical"]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("scenario")
    ap.add_argument("--run", action="store_true", help="start the sim clock")
    ap.add_argument("--no-residents", action="store_true")
    ap.add_argument("--incident", help="incident key from incidents.json (overrides the scenario file's \"incident\")")
    a = ap.parse_args()
    sc = json.loads(Path(a.scenario).read_text())
    g = sc["grid"]
    grid = Grid(g["origin_lat"], g["origin_lon"], g["cell_size_m"], g["rows"], g["cols"])

    db = SpacetimeClient("scenario")
    await db.call("register_agent", settings.agent_join_key, "scenario", "scenario-loader", 0, "")
    await db.call(
        "load_scenario", sc["name"], grid.origin_lat, grid.origin_lon, grid.cell_size_m, grid.rows, grid.cols,
        sc["stations"], sc["units"], float(sc["speed"]), float(sc["wind"]["speed_mps"]), float(sc["wind"]["from_deg"]),
    )
    cells = [{"cell_id": grid.locate(p["lat"], p["lon"]), "ignited_s": 0.0, "intensity": 1.0} for p in sc["ignition"]]
    await db.call("upsert_fire_cells", [c for c in cells if c["cell_id"] is not None], True, "seed")
    print(f"loaded {sc['name']}: {len(sc['stations'])} stations, {len(sc['units'])} units, fire at {len(cells)} cells")

    inc_key = a.incident or sc.get("incident")
    if inc_key:
        inc = incidents.get(inc_key)
        await incidents.select(db, inc)
        print(f"incident: {inc.name} (news {inc.news_from:%Y-%m-%d} → {inc.news_to:%Y-%m-%d})")

    if not a.no_residents:
        res = sc["residents"]
        rnd = random.Random(res["seed"])
        lat0, lon0 = res["center"]["lat"], res["center"]["lon"]
        for i in range(res["count"]):
            dn, de = rnd.gauss(0, res["spread_m"]), rnd.gauss(0, res["spread_m"])
            lat = lat0 + dn / M_PER_DEG_LAT
            lon = lon0 + de / (M_PER_DEG_LAT * math.cos(math.radians(lat0)))
            if grid.locate(lat, lon) is None:
                continue
            await db.call("submit_help_request_for", f"synthetic:{i}", "synthetic", lat, lon,
                          rnd.choice([1, 1, 2, 2, 3, 4, 5]), rnd.choice(NEEDS), "", 120)
        print(f"filed {res['count']} synthetic help requests")

    if a.run:
        await db.call("set_sim", True, float(sc["speed"]))
        print(f"sim running at {sc['speed']}x")
    await db.close()


if __name__ == "__main__":
    asyncio.run(main())
