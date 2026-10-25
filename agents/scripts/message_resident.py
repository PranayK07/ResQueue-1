"""Play the responder console's chat: write to a resident and read their answers. Same reducers a frontend calls.

    python scripts/message_resident.py --station 1 --message 25 "Is the road really blocked? Can you send a photo?"
    python scripts/message_resident.py --station 1 --thread 25          # the conversation with the resident
    python scripts/message_resident.py --commander --thread 25          # the incident commander (any request)

Signs in with claim_operator (OPERATOR_PASSCODE from .env) as a human operator: the module refuses message_resident
from any agent. A responder can write to residents in their own station's queue; the commander to anyone. The resident
answers in their app or in ASI:One (the intake agent relays); their answer also becomes a text report.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rescue.config import settings  # noqa: E402
from rescue.stdb import ReducerError, SpacetimeClient  # noqa: E402


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    who = ap.add_mutually_exclusive_group(required=True)
    who.add_argument("--station", type=int, help="sign in as a responder of this station")
    who.add_argument("--commander", action="store_true", help="sign in as the incident commander")
    ap.add_argument("--name", default="", help="your name for the audit log")
    ap.add_argument("--message", nargs=2, metavar=("REQUEST_ID", "TEXT"), help="write to the resident of this request")
    ap.add_argument("--thread", type=int, metavar="REQUEST_ID", help="show the conversation with the resident")
    a = ap.parse_args()
    if not (a.message or a.thread):
        ap.error("give --message or --thread")

    role = "commander" if a.commander else "responder"
    name = a.name or (f"responder-{a.station}" if a.station else "commander")
    db = SpacetimeClient(f"operator-{name}")
    try:
        await db.call("claim_operator", settings.operator_passcode, role, a.station or 0, name)
    except ReducerError as e:
        sys.exit(f"sign-in rejected: {e.message}")
    await db.connect(["SELECT * FROM ops_message"])

    if a.message:
        try:
            await db.call("message_resident", int(a.message[0]), a.message[1])
            print(f"request #{a.message[0]}: message sent to the resident")
        except ReducerError as e:
            print(f"rejected by the database: {e.message}")
    else:
        msgs = sorted((m for m in db.table("ops_message") if m["request_id"] == a.thread), key=lambda m: m["id"])
        print("\n".join(f"[{m['from']}{' ' + m['author'] if m['author'] else ''}] {m['text']}" for m in msgs) or "no messages yet")
    await db.close()


if __name__ == "__main__":
    asyncio.run(main())
