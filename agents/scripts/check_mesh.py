"""Read-only health check of the agent orchestration layer, against the database .env points at.

    cd agents && ../venv/bin/python scripts/check_mesh.py

What it proves, from the database's own contents:
  1. every agent is registered, online and heart-beating
  2. the head (delegation) agent is recording situations, i.e. its messages to the hazard and news agents work
  3. what it recorded matches the real world tables (fire area, wind, news), so the agents agree with each other
  4. no row in the log came from an empty world (fire 0 and wind 0)

Exit code 1 if anything FAILs (WARNs are advisory)."""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rescue.config import settings  # noqa: E402
from rescue.stdb import SpacetimeClient  # noqa: E402

EXPECTED = ["hazard", "news", "delegation", "commander", "intake", "danger", "station-1", "station-2", "station-3"]
HEAD_ROW_MAX_AGE_S = 360  # rows are written on material change, plus a heartbeat row every 300 s

results: list[tuple[str, str]] = []


def say(level: str, msg: str) -> None:
    results.append((level, msg))
    print(f"[{level}] {msg}")


def age_s(micros: int) -> float:
    return time.time() - micros / 1e6


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fresh-s", type=float, default=45, help="max seconds since an agent's last heartbeat")
    a = ap.parse_args()

    db = SpacetimeClient("check")
    print(f"Checking database {settings.stdb_db} @ {settings.stdb_http}\n")
    agents = {r["name"]: r for r in await db.sql("SELECT name, role, status, detail, last_seen FROM agent")}

    # 1. agents
    for name in EXPECTED:
        r = agents.get(name)
        if r is None:
            say("FAIL", f"agent {name}: never registered")
            continue
        seen = age_s(r["last_seen"])
        if seen > a.fresh_s:
            say("FAIL", f"agent {name}: last heartbeat {seen:.0f}s ago (is it running?)")
        elif r["status"] != "online":
            say("WARN", f"agent {name}: {r['status']}. {r['detail'][:90]}")
        else:
            say("PASS", f"agent {name}: online, heartbeat {seen:.0f}s ago")

    # 2. head agent is recording
    sits = await db.sql("SELECT * FROM situation")
    if not sits:
        say("FAIL", "head agent: no situation rows yet (is delegation running, and the module published?)")
        return finish()
    latest = max(sits, key=lambda r: r["id"])
    lat_age = age_s(latest["at"])
    if lat_age > HEAD_ROW_MAX_AGE_S:
        say("FAIL", f"head agent: newest situation row is {lat_age:.0f}s old (should be under {HEAD_ROW_MAX_AGE_S}s)")
    else:
        say("PASS", f"head agent: recording ({len(sits)} rows, newest {lat_age:.0f}s old)")

    # 3. empty-world rows
    bad = [r["id"] for r in sits if r["fire_area_sq_km"] == 0 and r["wind_speed_mps"] == 0]
    if latest["id"] in bad:
        say("FAIL", "head agent: newest row has fire 0 and wind 0 (recorded from an empty world)")
    elif bad:
        say("WARN", f"log has {len(bad)} empty-world row(s) (ids {bad[:8]}): filter them out of training data (fire_area_sq_km = 0 AND wind_speed_mps = 0)")
    else:
        say("PASS", "log: no empty-world rows")

    # 4. what the head recorded vs. the real world tables
    # A row stays valid until something material changes (area +2%, wind +1 m/s or 10 degrees), so the
    # world should still match it within those tolerances for as long as the head agent is recording.
    if lat_age <= HEAD_ROW_MAX_AGE_S:
        grid = (await db.sql("SELECT cell_size_m FROM grid"))[0]
        cells = (await db.sql("SELECT COUNT(*) AS n FROM fire_cell"))[0]["n"]
        truth_km2 = cells * grid["cell_size_m"] ** 2 / 1e6
        diff = abs(latest["fire_area_sq_km"] - truth_km2)
        if diff <= max(0.5, 0.15 * truth_km2):
            say("PASS", f"fire: head recorded {latest['fire_area_sq_km']:.1f} km², fire_cell table says {truth_km2:.1f} km²")
        else:
            say("WARN", f"fire: head recorded {latest['fire_area_sq_km']:.1f} km² but fire_cell says {truth_km2:.1f} km² (lagging, or hazard agent stale)")
        w = (await db.sql("SELECT wind_speed_mps, wind_from_deg FROM weather"))[0]
        ddir = abs((latest["wind_from_deg"] - w["wind_from_deg"] + 180) % 360 - 180)
        if abs(latest["wind_speed_mps"] - w["wind_speed_mps"]) <= 1.0 and ddir <= 10:
            say("PASS", f"wind: head recorded {latest['wind_speed_mps']:.1f} m/s from {latest['wind_from_deg']:.0f}°, weather table agrees")
        else:
            say("WARN", f"wind: head recorded {latest['wind_speed_mps']:.1f} m/s from {latest['wind_from_deg']:.0f}° but weather table says "
                        f"{w['wind_speed_mps']:.1f} from {w['wind_from_deg']:.0f}° (changed since the last row; re-run in a minute)")
        inc = await db.sql("SELECT key FROM incident")
        key = inc[0]["key"] if inc else ""
        arts = await db.sql("SELECT relevance, incident FROM news_article")
        relevant = min(20, sum(1 for x in arts if x["incident"] == key and x["relevance"] >= 0.5))  # head asks for the top 20
        if not latest["news_ok"]:
            say("WARN", "news: head recorded news_ok=false (news agent didn't answer that cycle)")
        elif latest["news_relevant"] == relevant:
            say("PASS", f"news: head counted {relevant} relevant article(s), news_article table agrees")
        else:
            say("WARN", f"news: head counted {latest['news_relevant']} relevant but the table has {relevant} (a scrape landed since, or incident changed)")
    else:
        say("WARN", "skipped the consistency checks: the head agent has not recorded recently")
    return finish()


def finish() -> int:
    n = {k: sum(1 for lv, _ in results if lv == k) for k in ("PASS", "WARN", "FAIL")}
    print(f"\n{n['PASS']} passed, {n['WARN']} warnings, {n['FAIL']} failed")
    return 1 if n["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
