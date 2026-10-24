"""Intake agent: the resident's help desk inside ASI:One.

Primary workflow, entirely in chat:
  "I need help"        -> Interactive Card form (location, people, needs, consent)
  submit               -> submit_help_request_for(...) in SpacetimeDB
  "status"             -> queue position / unit / ETA / reason (live from the DB)
  "I'm safe" / "stop"  -> close_my_request (location deleted immediately)
Plus proactive pushes: when the resident's queue entry or unit changes in
SpacetimeDB, this agent messages them without being asked.

TODO: free-text intake via ASI:One LLM ("3 of us, grandma uses a wheelchair,
  near 5th & Pine") -> structured fields; geocoding for addresses.
"""
from __future__ import annotations

import re
from typing import Any

from uagents import Context
from uagents_core.contrib.protocols.chat.cards import (
    CtaAction,
    FormCardPayload,
    FormField,
    FormFieldOption,
    create_card_content,
)

from ..chat import build_chat_protocol, push, text
from ..core.slack import fmt_min
from ..stdb import ReducerError, Update
from .base import MeshAgent

NEEDS = ["mobility", "medical", "oxygen", "infant", "elderly", "pets"]
_LATLON = re.compile(r"(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)")


def ref_for(sender: str) -> str:
    return f"asi1:{sender}"


class IntakeAgent(MeshAgent):
    # Scoped by the module: the intake identity only sees requests it submitted.
    queries = [
        "SELECT * FROM sim_clock",
        "SELECT * FROM station",
        "SELECT * FROM unit",
        "SELECT * FROM ops_request",
        "SELECT * FROM ops_queue",
    ]

    def __init__(self) -> None:
        super().__init__("intake")
        self.agent.include(build_chat_protocol(self.handle), publish_manifest=True)
        self._last_pushed: dict[int, tuple] = {}
        self._ctx: Context | None = None

    async def on_ready(self, ctx: Context) -> None:
        self._ctx = ctx
        self.db.on_update(["ops_queue", "ops_request"], self._maybe_push)

    # ── state helpers ───────────────────────────────────────────────────────

    def active_request(self, sender: str) -> dict | None:
        ref = ref_for(sender)
        mine = [r for r in self.db.table("ops_request") if r["external_ref"] == ref]
        active = [r for r in mine if r["status"] in ("pending", "queued", "assigned", "en_route", "on_scene")]
        return max(active, key=lambda r: r["id"]) if active else None

    def status_text(self, r: dict) -> str:
        q = self.db.table("ops_queue").get(r["id"])
        now = self.sim_now()
        if r["status"] == "pending" or not q:
            return f"Request #{r['id']} received. We're assessing your location against the fire forecast."
        station = (self.db.table("station").get(q["station_id"]) or {}).get("name", "a station")
        if q["unit_id"]:
            unit = (self.db.table("unit").get(q["unit_id"]) or {}).get("callsign", "A unit")
            return f"{unit} from {station} is assigned to you, ETA about {fmt_min(q['eta_s'] - now)}. {q['resident_reason']}"
        return f"{q['resident_reason']} Estimated arrival in about {fmt_min(q['eta_s'] - now)}."

    # ── chat ────────────────────────────────────────────────────────────────

    def request_form(self):
        return create_card_content(FormCardPayload(
            title="Request wildfire rescue",
            fields=[
                FormField(name="location", kind="text", label="Your location (lat, lon)", required=True,
                          placeholder="39.7596, -121.6219"),
                FormField(name="headcount", kind="number", label="How many people?", required=True, placeholder="1"),
                *[FormField(name=f"need_{n}", kind="checkbox", label=n.capitalize()) for n in NEEDS],
                FormField(name="consent_minutes", kind="select", label="Share my location for", required=True,
                          options=[FormFieldOption(value=v, label=f"{v} minutes") for v in ("30", "60", "120")]),
                FormField(name="consent", kind="checkbox", required=True,
                          label="I consent to share my location with incident command until I'm safe or it expires"),
            ],
            submit_cta=CtaAction(label="Request help", selection={"action": "submit_request"}, primary=True),
        ))

    async def handle(self, ctx: Context, sender: str, body: str, sel: dict[str, Any] | None) -> list:
        low = body.lower()
        active = self.active_request(sender)

        if sel and sel.get("action") == "submit_request" or (sel and "location" in sel):
            return await self.submit(sender, sel)
        if active and re.search(r"\b(safe|stop|revoke|cancel)\b", low):
            outcome = "safe" if "safe" in low else "revoked"
            await self.db.call("close_my_request", active["id"], ref_for(sender), outcome)
            return [text("Glad you're safe. Your request is closed and your location has been deleted."
                         if outcome == "safe" else "Done. Location sharing stopped and your location was deleted.")]
        if active:
            return [text(self.status_text(active))]
        if m := _LATLON.search(body):  # power-user shortcut: "help at 39.76, -121.62 for 3"
            n = re.search(r"\bfor (\d+)\b|\b(\d+) (?:people|of us|persons?)\b", low)
            hc = int(next(g for g in n.groups() if g)) if n else 1
            needs = [x for x in NEEDS if x in low]
            return await self.submit(sender, {"location": m.group(0), "headcount": hc, "consent": True,
                                              **{f"need_{x}": True for x in needs}})
        return [
            text("I'm the wildfire rescue intake agent. If you feel threatened by the fire, fill in this form "
                 "(or reply with your coordinates, e.g. 'help at 39.76, -121.62 for 3 people'). "
                 "This is a simulated demo, not 911 — in a real emergency call 911."),
            self.request_form(),
        ]

    async def submit(self, sender: str, sel: dict[str, Any]) -> list:
        if not sel.get("consent") in (True, "true", "on", "yes"):
            return [text("I can only request help after you consent to sharing your location."), self.request_form()]
        m = _LATLON.search(str(sel.get("location", "")))
        if not m:
            return [text("I couldn't read that location. Please send it as 'lat, lon'."), self.request_form()]
        try:
            headcount = max(1, min(50, int(float(sel.get("headcount", 1)))))
        except ValueError:
            headcount = 1
        needs = ",".join(n for n in NEEDS if sel.get(f"need_{n}") in (True, "true", "on", "yes"))
        try:
            await self.db.call(
                "submit_help_request_for", ref_for(sender), "asi1", float(m.group(1)), float(m.group(2)),
                headcount, needs, "", int(sel.get("consent_minutes", 60)),
            )
        except ReducerError as e:
            return [text(f"I couldn't file that request: {e.message}")]
        return [text("Your request is in. I'll message you here when you're placed in a station's queue and when "
                     "a unit is on the way. Say 'status' anytime, or 'I'm safe' to close it.")]

    # ── proactive updates ───────────────────────────────────────────────────

    async def _maybe_push(self, upd: Update) -> None:
        if self._ctx is None or upd.resync:
            return
        for r in self.db.table("ops_request"):
            if not r["external_ref"].startswith("asi1:"):
                continue
            q = self.db.table("ops_queue").get(r["id"])
            key = (r["status"], q and q["station_id"], q and q["unit_id"])
            if self._last_pushed.get(r["id"]) == key:
                continue
            first = r["id"] not in self._last_pushed
            self._last_pushed[r["id"]] = key
            if first and r["status"] == "pending":
                continue
            if r["status"] in ("queued", "assigned", "en_route", "on_scene"):
                await push(self._ctx, r["external_ref"][5:], text("Update: " + self.status_text(r)))


if __name__ == "__main__":
    IntakeAgent().run()
