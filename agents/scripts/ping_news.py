"""Point the news pipeline at a place and a time, then watch what the news agent pulls. These are the same
reducer calls any component makes (the web app signed in as an operator, the commander, another agent):

    ping_news(lat, lon, label)              WHERE
    set_incident(...) / clear_incident()    WHEN: a past window / live

    python scripts/ping_news.py 38.578 -122.579 --label Calistoga                                # where (time unchanged)
    python scripts/ping_news.py 38.578 -122.579 --label Calistoga --live                         # ... now
    python scripts/ping_news.py 38.578 -122.579 --label Calistoga --from 2020-09-27 --to 2020-10-20   # ... in 2020
    python scripts/ping_news.py --incident glass-fire-2020          # a catalog fire: its window and center
    python scripts/ping_news.py --clear                             # drop the ping
    python scripts/ping_news.py --show                              # just print the focus and top posts

--wait N (default 90) watches the news agent's status for up to N seconds and prints the top posts."""
from __future__ import annotations

import argparse
import asyncio
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rescue import incidents  # noqa: E402
from rescue.config import settings  # noqa: E402
from rescue.news.focus import resolve  # noqa: E402
from rescue.stdb import SpacetimeClient  # noqa: E402


async def show(db: SpacetimeClient, top: int) -> None:
    inc = (await db.sql("SELECT * FROM incident") or [None])[0]
    entry = incidents.load_catalog().get(inc["key"]) if inc else None
    f = resolve((await db.sql("SELECT * FROM news_focus") or [None])[0], inc, entry.center if entry else None,
                await db.sql("SELECT lat, lon FROM station"), now_micros=int(time.time() * 1e6),
                live_lookback_h=settings.news_live_lookback_h)
    print(f"\nfocus ({f.where}): {f.describe()}   scope: {f.scope or 'live'}")
    rows = [r for r in await db.sql("SELECT * FROM news_article") if r["incident"] == f.scope and f.contains(r["published_at"] or 0)]
    rows.sort(key=lambda r: r["relevance"], reverse=True)
    print(f"{len(rows)} posts stored for it, {sum(r['relevance'] >= 0.5 for r in rows)} relevant (>= 0.5)")
    for r in rows[:top]:
        day = datetime.fromtimestamp(r["published_at"] / 1e6, timezone.utc).strftime("%Y-%m-%d %H:%M")
        sig = ", ".join(s for s in ("EVAC" if r["evacuation"] else "", "CLOSURES" if r["closures"] else "",
                                    "RELIEF" if r["relief"] else "") if s)
        print(f"  [{r['relevance']:.2f}] {day} {r['source']}{' (official)' if r['official'] else ''}: {r['title'][:90]}"
              + (f"  <{sig}>" if sig else ""))


async def watch(db: SpacetimeClient, wait_s: float) -> None:
    """Print the news agent's status as it changes (heartbeats land every ~10 s) until a pull finishes."""
    start = time.time()
    end, last, fetched = start + wait_s, None, False
    while time.time() < end:
        r = (await db.sql("SELECT status, detail FROM agent WHERE name = 'news'") or [None])[0]
        if r is None:
            print("the news agent never registered: is the mesh running (scripts/dev.sh)?")
            return
        if (r["status"], r["detail"]) != last:
            last = (r["status"], r["detail"])
            print(f"  news agent: {r['status']}: {r['detail']}")
        fetched |= r["status"] == "fetching"
        if fetched and r["status"] != "fetching":
            return
        if not fetched and time.time() - start > 30:
            print("  no pull started within 30 s: the place and time were already on file, the focus didn't change, "
                  "NEWS_FETCH_ON_PING=0, or (NEWS_SOURCE=file) it finished between heartbeats")
            return
        await asyncio.sleep(3)
    print(f"  (stopped watching after {wait_s:.0f}s; the agent may still be working)")


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lat", type=float, nargs="?")
    ap.add_argument("lon", type=float, nargs="?")
    ap.add_argument("--label", default="", help="place name, e.g. Calistoga (also counts as a place for relevance)")
    when = ap.add_mutually_exclusive_group()
    when.add_argument("--live", action="store_true", help="time = now (clears any incident / window)")
    when.add_argument("--from", dest="start", help="past window start, YYYY-MM-DD (with --to)")
    when.add_argument("--incident", help="catalog key from incidents.json (its window and center)")
    ap.add_argument("--to", dest="end", help="past window end, YYYY-MM-DD")
    ap.add_argument("--clear", action="store_true", help="drop the location ping")
    ap.add_argument("--show", action="store_true", help="only print the current focus and top posts")
    ap.add_argument("--wait", type=float, default=90, help="seconds to watch the news agent (0 = don't)")
    ap.add_argument("--top", type=int, default=8)
    a = ap.parse_args()
    if (a.lat is None) != (a.lon is None) or bool(a.start) != bool(a.end):
        ap.error("give both lat and lon, and both --from and --to")

    db = SpacetimeClient("scenario")
    if a.show:
        await show(db, a.top)
        return await db.close()
    await db.call("register_agent", settings.agent_join_key, "scenario", "scenario-loader", 0, "")
    if a.live:
        await db.call("clear_incident")
        print("time: live")
    elif a.start:
        inc = incidents.adhoc(a.start, a.end, location=a.label)
        await db.call("set_incident", *inc.reducer_args())
        print(f"time: {inc.name}")
    elif a.incident:
        inc = incidents.get(a.incident)
        await incidents.select(db, inc)
        print(f"time + place: {inc.name}" + (f", center {inc.center}" if inc.center else ""))
    if a.clear:
        await db.call("clear_news_focus")
        print("ping cleared")
    if a.lat is not None:
        await db.call("ping_news", a.lat, a.lon, a.label)
        print(f"ping: {a.label or 'location'} ({a.lat}, {a.lon})")
    if a.wait > 0:
        await watch(db, a.wait)
    await show(db, a.top)
    await db.close()


if __name__ == "__main__":
    asyncio.run(main())
