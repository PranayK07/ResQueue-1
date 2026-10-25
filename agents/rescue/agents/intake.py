"""Intake agent: the user-facing subagent, one of the commander's three. Residents ping for help and show us what they see.

A resident presses the help button in the app (location shared with consent). The app files the ping
(submit_help_request) and whatever they add (submit_report: a message, a voice transcript, a photo, a video as
URL + sampled frames) into SpacetimeDB, which is this agent's inbox: it is subscribed and reacts on commit.

For every new ping and every new report it reads ALL of that request's reports (rescue/intake/analysis.py: an
open vision-language model on Hugging Face, or keywords offline) into one `Assessment`: people, needs, injured /
trapped, fire seen and how far, road blocked, whether the media back it up, confidence, urgency, a line for
firefighters and a reply for the resident, and SENDS it to the commander (uAgents message, acknowledged;
unacknowledged readings are re-sent). The commander records it, weighs the claims (rescue/core/reports.py) and
re-plans; this agent never queues anyone. The commander also asks it for an IntakeReport each synthesis cycle.

A responder can write to a resident (message_resident). This agent relays that to ASI:One residents, and an
ASI:One resident's reply goes back (reply_to_responder, which also becomes a text report). App residents read
and answer in the app.

ASI:One chat (a test harness for the pipeline, not how residents reach us):
  "I need help"        -> Interactive Card form (location, people, needs, consent)
  submit               -> submit_help_request_for(...) in SpacetimeDB
  any other message    -> submit_report (text) on the open request; the reply comes from the analysis
  "status"             -> queue position / unit / ETA / reason (live from the DB)
  "I'm safe" / "stop"  -> close_my_request (location and reports deleted immediately)
Plus proactive pushes when the resident's queue entry or unit changes.
"""
from __future__ import annotations

import asyncio
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
from ..config import settings
from ..core.slack import fmt_min
from ..intake.analysis import Analyzer, ReportIn
from ..messages import Assessment, AssessmentAck, IntakeReport, IntakeReportRequest
from ..stdb import ReducerError, Update
from .base import MeshAgent

NEEDS = ["mobility", "medical", "oxygen", "infant", "elderly", "pets"]
ACTIVE = ("pending", "queued", "assigned", "en_route", "on_scene")
_LATLON = re.compile(r"(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)")
SETTLE_S = 2.0  # wait this long after a report for the rest of a burst (photo + caption) before reading
RESEND_S = 10.0  # re-send readings the commander hasn't acknowledged


def ref_for(sender: str) -> str:
    return f"asi1:{sender}"


class IntakeAgent(MeshAgent):
    # The module lets the intake identity see every request and report: it reads all residents' reports.
    queries = [
        "SELECT * FROM sim_clock",
        "SELECT * FROM station",
        "SELECT * FROM unit",
        "SELECT * FROM ops_request",
        "SELECT * FROM ops_queue",
        "SELECT * FROM ops_report",
        "SELECT * FROM ops_assessment",
        "SELECT * FROM ops_risk",
        "SELECT * FROM ops_message",
    ]

    def __init__(self) -> None:
        super().__init__("intake")
        self.agent.include(build_chat_protocol(self.handle), publish_manifest=True)
        self.analyzer = Analyzer(settings.intake_analyzer, settings.intake_model, settings.hf_token)
        self._sem = asyncio.Semaphore(settings.intake_concurrency)
        self._read: dict[int, tuple] = {}  # request_id -> signature of the reports last analyzed
        self._pending: dict[int, asyncio.Task] = {}
        self._unacked: dict[int, dict] = {}  # request_id -> latest reading the commander hasn't confirmed
        self._sent = 0
        self._last_pushed: dict[int, tuple] = {}
        self._relayed: set[int] = set()
        self._ctx: Context | None = None

        @self.agent.on_message(IntakeReportRequest, replies=IntakeReport)
        async def _report(ctx: Context, sender: str, _msg: IntakeReportRequest):
            if await self.when_ready(ctx):
                await ctx.send(sender, IntakeReport(
                    analyzer=self.analyzer.name, requests_read=len(self._read), awaiting_ack=len(self._unacked),
                    summary=f"{len(self._read)} requests read with {self.analyzer.name}"
                            + (f", {len(self._unacked)} readings waiting for the commander" if self._unacked else "")))

        @self.agent.on_interval(period=RESEND_S)
        async def _resend(ctx: Context):
            for rid, a in list(self._unacked.items()):
                req = self.db.table("ops_request").get(rid)
                if not req or req["status"] not in ACTIVE:
                    self._unacked.pop(rid, None)  # closed meanwhile: nothing left to tell
                    continue
                await self.deliver(ctx, a)

    async def on_ready(self, ctx: Context) -> None:
        self._ctx = ctx
        ctx.logger.info(f"analyzer: {self.analyzer.name}")
        self.db.on_update(["ops_request", "ops_report"], self._changed)
        self.db.on_update(["ops_queue", "ops_request", "ops_assessment"], self._maybe_push)
        self.db.on_update(["ops_message"], self._relay_messages)
        self._relayed = {m["id"] for m in self.db.table("ops_message")}  # already seen before this start
        self._scan(settle=0.0)  # anything that arrived while we were down

    # ── analysis ────────────────────────────────────────────────────────────

    def _signature(self, rid: int) -> tuple:
        return tuple(sorted(r["id"] for r in self.db.table("ops_report") if r["request_id"] == rid))

    def _changed(self, upd: Update) -> None:
        if upd.resync:
            return
        self._scan(settle=SETTLE_S)

    def _scan(self, settle: float) -> None:
        """Schedule a reading for every active request whose reports changed since the last one."""
        assessed = {a["request_id"]: a["report_count"] for a in self.db.table("ops_assessment")}
        for r in self.db.table("ops_request"):
            if r["status"] not in ACTIVE or r["location_purged"]:
                continue
            sig = self._signature(r["id"])
            if self._read.get(r["id"]) == sig:
                continue
            if r["id"] in assessed and assessed[r["id"]] == len(sig) and r["id"] not in self._read:
                self._read[r["id"]] = sig  # read before a restart
                continue
            if r["id"] in self._pending and not self._pending[r["id"]].done():
                self._pending[r["id"]].cancel()  # more reports arrived: read them all together
            self._pending[r["id"]] = asyncio.create_task(self._analyze(r["id"], settle))
            self._read[r["id"]] = sig  # scheduled; a reading that ends stale or fails resets this below

    async def _analyze(self, rid: int, settle: float) -> None:
        try:
            await asyncio.sleep(settle)
        except asyncio.CancelledError:
            return
        async with self._sem:
            req = self.db.table("ops_request").get(rid)
            if not req or req["status"] not in ACTIVE:
                return
            rows = sorted((r for r in self.db.table("ops_report") if r["request_id"] == rid), key=lambda r: r["id"])
            sig = tuple(r["id"] for r in rows)
            assessment = await self.analyzer.assess(req, [ReportIn.from_row(r) for r in rows])
            if self._signature(rid) != tuple(sorted(sig)):
                return  # more reports landed while reading; the newer reading covers them all
            claims = [k for k in ("trapped", "injured", "fire_seen", "road_blocked") if assessment[k]]
            self.log.info("request #%d read (%s, %d reports): %s", rid, assessment["analyzer"], len(rows), ", ".join(claims) or "no hazards stated")
            self._unacked[rid] = assessment
            if self._ctx:
                await self.deliver(self._ctx, assessment)
            self.set_status("online", f"{len(self._read)} requests read ({self.analyzer.name})"
                            + (f"; {len(self._unacked)} awaiting the commander" if self._unacked else ""))

    async def deliver(self, ctx: Context, a: dict) -> None:
        """Send a reading to the commander and wait for its acknowledgement (kept for re-send if none)."""
        ack = await self.ask(ctx, "commander", Assessment(**a), AssessmentAck, timeout=10)
        if ack and ack.ok and self._unacked.get(a["request_id"]) is a:
            del self._unacked[a["request_id"]]
            self._sent += 1
        elif ack and not ack.ok:
            self.log.warning("commander did not record request #%d: %s", a["request_id"], ack.detail)

    # ── state helpers ───────────────────────────────────────────────────────

    def active_request(self, sender: str) -> dict | None:
        ref = ref_for(sender)
        mine = [r for r in self.db.table("ops_request") if r["external_ref"] == ref]
        active = [r for r in mine if r["status"] in ACTIVE]
        return max(active, key=lambda r: r["id"]) if active else None

    def status_text(self, r: dict) -> str:
        q = self.db.table("ops_queue").get(r["id"])
        now = self.sim_now()
        card = next((c for c in self.db.table("ops_risk") if c["assessment"]["request_id"] == r["id"]), None)
        risk_text = ""
        if card:
            risk = card["assessment"]
            if not card["current"]:
                risk_text = " Your risk estimate is being refreshed."
            elif risk["probabilities"]:
                hours = max(0, risk["forecast_issue_s"] + risk["horizons_s"][-1] - now) / 3600
                risk_text = (f" Forecast exposure estimate: {risk['probabilities'][-1]:.0%} chance of this area being affected"
                             f" by fire within about {hours:.1f} hours. Actual timing may differ.")
            else:
                risk_text = " A current fire-exposure estimate is unavailable; your request and reports remain with responders."
        if r["status"] == "pending" or not q:
            return f"Request #{r['id']} received. We're assessing your location against the fire forecast." + risk_text
        station = (self.db.table("station").get(q["station_id"]) or {}).get("name", "a station")
        if q["unit_id"]:
            unit = (self.db.table("unit").get(q["unit_id"]) or {}).get("callsign", "A unit")
            return f"{unit} from {station} is assigned to you, ETA about {fmt_min(q['eta_s'] - now)}. {q['resident_reason']}" + risk_text
        return f"{q['resident_reason']} Estimated arrival in about {fmt_min(q['eta_s'] - now)}." + risk_text

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
                          options=[FormFieldOption(value=v, label=l) for v, l in (("1440", "24 hours"), ("240", "4 hours"), ("60", "1 hour"))]),
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
        if active and (not body.strip() or re.fullmatch(r"\s*(status|update|where.*|eta\??)\s*", low)):
            return [text(self.status_text(active))]
        if active:  # anything else they tell us is context for the rescue
            asked = self.latest_message(active["id"])
            try:
                if asked and asked["from"] != "resident":  # answering a responder's question
                    await self.db.call("reply_to_responder", active["id"], ref_for(sender), body[:1000])
                    return [text("Sent to the responder. They'll read it and may write back here.")]
                await self.db.call("submit_report", active["id"], ref_for(sender), "text", body[:4000], "", "")
            except ReducerError as e:
                return [text(f"I couldn't add that to your request: {e.message}")]
            return [text("Got it, I've added that to your request and passed it to the firefighters. "
                         "Tell me anything else that changes (fire getting closer, a road blocked, someone hurt). "
                         "Say 'status' anytime, or 'I'm safe' to close it.")]
        if m := _LATLON.search(body):  # power-user shortcut: "help at 39.76, -121.62 for 3"
            n = re.search(r"\bfor (\d+)\b|\b(\d+) (?:people|of us|persons?)\b", low)
            hc = int(next(g for g in n.groups() if g)) if n else 1
            needs = [x for x in NEEDS if x in low]
            return await self.submit(sender, {"location": m.group(0), "headcount": hc, "consent": True, "note": body,
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
                headcount, needs, str(sel.get("note", ""))[:500], int(sel.get("consent_minutes", 1440)),
            )
        except ReducerError as e:
            return [text(f"I couldn't file that request: {e.message}")]
        return [text("Your request is in. Tell me what you see (fire nearby, roads blocked, anyone hurt or unable to "
                     "walk): it goes straight to the firefighters. I'll message you when you're placed in a station's "
                     "queue and when a unit is on the way. Say 'status' anytime, or 'I'm safe' to close it.")]

    def latest_message(self, rid: int) -> dict | None:
        msgs = [m for m in self.db.table("ops_message") if m["request_id"] == rid]
        return max(msgs, key=lambda m: m["id"]) if msgs else None

    async def _relay_messages(self, upd: Update) -> None:
        """A responder wrote to an ASI:One resident: pass it on. (App residents see it in their app.)"""
        if self._ctx is None or upd.resync:
            return
        for m in self.db.table("ops_message"):
            if m["id"] in self._relayed:
                continue
            self._relayed.add(m["id"])
            r = self.db.table("ops_request").get(m["request_id"])
            if m["from"] == "resident" or not r or not r["external_ref"].startswith("asi1:"):
                continue
            await push(self._ctx, r["external_ref"][5:], text(f"Message from the {m['from']}" + (f" ({m['author']})" if m["author"] else "") + f": {m['text']}\n(Reply here.)"))

    # ── proactive updates ───────────────────────────────────────────────────

    async def _maybe_push(self, upd: Update) -> None:
        if self._ctx is None or upd.resync:
            return
        for r in self.db.table("ops_request"):
            if not r["external_ref"].startswith("asi1:"):
                continue
            q = self.db.table("ops_queue").get(r["id"])
            a = self.db.table("ops_assessment").get(r["id"])
            key = (r["status"], q and q["station_id"], q and q["unit_id"], a and a["report_count"])
            prev = self._last_pushed.get(r["id"])
            if prev == key:
                continue
            self._last_pushed[r["id"]] = key
            if prev is None and r["status"] == "pending":
                continue
            to = r["external_ref"][5:]
            if a and a["report_count"] and (prev is None or prev[3] != a["report_count"]) and a["resident_reply"]:
                await push(self._ctx, to, text(a["resident_reply"]))
            if r["status"] in ("queued", "assigned", "en_route", "on_scene") and (prev is None or prev[:3] != key[:3]):
                await push(self._ctx, to, text("Update: " + self.status_text(r)))


if __name__ == "__main__":
    IntakeAgent().run()
