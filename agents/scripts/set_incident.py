"""Select (or clear) the incident whose news window the news agent uses.

    python scripts/set_incident.py glass-fire-2020
    python scripts/set_incident.py --list
    python scripts/set_incident.py --clear        # back to live mode

Run it AFTER seed_scenario.py (loading a scenario clears the incident)."""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rescue import incidents  # noqa: E402
from rescue.config import settings  # noqa: E402
from rescue.stdb import SpacetimeClient  # noqa: E402


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("key", nargs="?")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--clear", action="store_true")
    a = ap.parse_args()
    if a.list or not (a.key or a.clear):
        for k, i in incidents.load_catalog().items():
            print(f"{k:20s} {i.name}\n{'':20s} news {i.news_from:%Y-%m-%d} → {i.news_to:%Y-%m-%d}, {len(i.queries)} queries")
        return
    db = SpacetimeClient("scenario")
    await db.call("register_agent", settings.agent_join_key, "scenario", "scenario-loader", 0, "")
    if a.clear:
        await db.call("clear_incident")
        print("incident cleared (live mode)")
    else:
        inc = incidents.get(a.key)
        await db.call("set_incident", *inc.reducer_args())
        print(f"incident set: {inc.name} (news {inc.news_from:%Y-%m-%d} → {inc.news_to:%Y-%m-%d})")
    await db.close()


if __name__ == "__main__":
    asyncio.run(main())
