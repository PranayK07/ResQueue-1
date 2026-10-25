"""Play the resident app: ping for help, send what you see, watch what comes back. Same reducers the frontend calls.

    python scripts/send_report.py 39.765 -121.60 --people 3 --needs mobility \
        --text "flames about 200 feet behind the house, tree down across the road"
    python scripts/send_report.py 39.765 -121.60 --image https://.../photo.jpg --text "this is our street"
    python scripts/send_report.py --resident alice --text "my son is hurt"     # add to alice's open request
    python scripts/send_report.py --resident alice --reply "yes, the road is blocked at Skyway"   # answer a responder

Each --resident name is its own SpacetimeDB identity (a different phone). The request is filed with
submit_help_request (channel "app"), reports with submit_report; the script then watches the resident's own view
(my_requests): the intake agent's reply, queue position, station, unit and ETA.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rescue.stdb import ReducerError, SpacetimeClient  # noqa: E402

ACTIVE = ("pending", "queued", "assigned", "en_route", "on_scene")


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lat", type=float, nargs="?")
    ap.add_argument("lon", type=float, nargs="?")
    ap.add_argument("--resident", default="demo", help="which simulated phone (default: demo)")
    ap.add_argument("--people", type=int, default=1)
    ap.add_argument("--needs", default="", help="comma list: mobility,medical,oxygen,infant,elderly,pets")
    ap.add_argument("--note", default="")
    ap.add_argument("--text", help="a text report")
    ap.add_argument("--voice", help="a voice transcript")
    ap.add_argument("--image", action="append", default=[], help="photo URL (https), repeatable")
    ap.add_argument("--video", help="video URL (https); pass its sampled frames with --frame")
    ap.add_argument("--frame", action="append", default=[], help="video still frame URL (https), repeatable")
    ap.add_argument("--reply", help="answer a responder's message (reply_to_responder)")
    ap.add_argument("--wait", type=float, default=60, help="seconds to watch for the reply / queue placement")
    a = ap.parse_args()

    db = SpacetimeClient(f"resident-{a.resident}")
    await db.connect(["SELECT * FROM my_requests", "SELECT * FROM ops_message"])
    mine = lambda: [r for r in db.table("my_requests") if r["status"] in ACTIVE]  # noqa: E731
    if not mine():
        if a.lat is None or a.lon is None:
            sys.exit(f"resident '{a.resident}' has no open request: give lat lon to ping")
        try:
            await db.call("submit_help_request", a.lat, a.lon, a.people, a.needs, a.note, 1440)
        except ReducerError as e:
            sys.exit(f"ping rejected: {e.message}")
        for _ in range(50):
            if mine():
                break
            await asyncio.sleep(0.1)
    req = max(mine(), key=lambda r: r["request_id"])
    rid = req["request_id"]
    print(f"request #{rid} ({req['status']})")

    reports = ([("text", a.text, "", "")] if a.text else []) + ([("voice", a.voice, "", "")] if a.voice else [])
    reports += [("image", "", u, "") for u in a.image]
    if a.video or a.frame:
        reports.append(("video", "", a.video or "", "\n".join(a.frame)))
    for kind, txt, url, frames in reports:
        try:
            await db.call("submit_report", rid, "", kind, txt, url, frames)
            print(f"  sent {kind} report")
        except ReducerError as e:
            print(f"  {kind} report rejected: {e.message}")

    if a.reply:
        try:
            await db.call("reply_to_responder", rid, "", a.reply)
            print("  reply sent")
        except ReducerError as e:
            print(f"  reply rejected: {e.message}")

    seen = None
    loop = asyncio.get_running_loop()
    end = loop.time() + a.wait
    while loop.time() < end:
        r = db.table("my_requests").get(rid)
        if r:
            view = (r["status"], r["level"], r["queue_position"], r["station_name"], r["unit_callsign"], r["intake_reply"])
            if view != seen:
                seen = view
                where = f"#{r['queue_position']} at {r['station_name']}" if r["station_name"] else "not queued yet"
                print(f"  [{r['status']}/{r['level']}] {where}" + (f", unit {r['unit_callsign']}" if r["unit_callsign"] else "")
                      + (f"\n    intake: {r['intake_reply']}" if r["intake_reply"] else "") + (f"\n    reason: {r['reason']}" if r["reason"] else ""))
            if r["station_name"] and r["intake_reply"]:
                break
        await asyncio.sleep(0.5)
    for m in sorted(db.table("ops_message"), key=lambda m: m["id"]):
        if m["request_id"] == rid:
            print(f"  [{m['from']}{' ' + m['author'] if m['author'] else ''}] {m['text']}")
    await db.close()


if __name__ == "__main__":
    asyncio.run(main())
