"""Commander agent: the head agent. It orchestrates three subagents and turns what they report into the
per-station rescue queues, and it is the incident-command console inside ASI:One.

  hazard  (subagent)  fire + weather + forecast: asked for a HazardReport (uAgents) every synthesis cycle
  news    (subagent)  wildfire posts from trusted X accounts: asked for a NewsReport (uAgents)
  intake  (subagent)  residents' pings + text / voice / photo / video: sends an Assessment (uAgents) for every
                      request it reads, which the commander records (publish_assessment) and acknowledges; asked
                      for an IntakeReport each cycle

Its own engines (rescue/orchestrator/) run on every change: reports (weigh residents' claims) -> danger (slack
per request) -> planner (Situation + dispatch policy, heuristic or RL -> publish_plan). Responders always see
residents' raw reports next to the assessment; the engines only decide how much moves the automatic queue order.

ASI:One console (for a human commander, and for testing the agents end to end):

  "login <passcode>"     link this ASI:One user as a commander
  "status"               pooled situation: hazard agent (fire + weather) + news agent + queues
  "fire" / "weather"     one specialist's full report
  "news"                 top posts from trusted wildfire accounts on X, with extracted signals (news agent)
  "refresh news"         ask the news agent to pull its X accounts now (costs Bright Data credits)
  "track <x.com post>"   collect and score one X post by URL (e.g. an evacuation order you saw)
  "incident"             show the selected incident and the catalog; "incident <key>" selects one
                         (e.g. glass-fire-2020: its window + center), "incident clear" returns to live mode
  "ping 38.58 -122.58 Calistoga"   point the news agent at a location (it pulls the accounts near it);
                         "ping clear" drops the ping
  "window 2020-09-27 2020-10-20"   look at a past time window instead of live ("window live" = back to now)
  "wind 12 from 0"       manual wind (locks out the live feed; the demo slider)
  "release wind"         hand wind back to the live NWS feed
  "pause" / "resume [x]" pause or run the simulation clock (x = speed)
  "pin 12 to 2"          override_assignment (the policy must obey)
  "unpin 12"
  "reports"              requests with field reports: what residents sent and how much of it is applied

TODO: Interactive Cards (critical-request carousel, escalation review card),
  push alerts on new escalations, planner/forecast queries
  (ExplainRequest, ComparePolicies, WhatIfWind), ASI:One LLM for free-form
  questions, Payment Protocol.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
import re
from collections import Counter
from typing import Any

from uagents import Context, Model

from ..chat import build_chat_protocol, text
from ..config import STATE_DIR, settings
from .. import incidents
from ..core.slack import fmt_min
from ..messages import (Assessment, AssessmentAck, FireReport, FireReportRequest, HazardReport, HazardReportRequest, NewsRefreshRequest,
                        NewsRefreshResult, NewsReport, NewsReportRequest, NewsTrackRequest, WeatherReport,
                        WeatherReportRequest)
from ..orchestrator.danger import DangerEngine
from ..orchestrator.planner import Planner
from ..orchestrator.reports import ReportsEngine
from ..stdb import ReducerError
from .base import MeshAgent

AUTH_FILE = STATE_DIR / "commanders.json"
LOGIN_HELP = ("To sign in, send the word login followed by the commander passcode, for example: "
              "login MYPASSCODE (the OPERATOR_PASSCODE value in the project's .env file).")
HELP = """Commands:
status: pooled picture (fire, weather, news, queues)
fire / weather / news: one specialist's full report
refresh news: pull new posts from the trusted X accounts near the incident (costs Bright Data credits)
track https://x.com/<account>/status/<id>: collect and score one X post
incident: show or list incidents; incident glass-fire-2020 selects one; incident clear returns to live mode
ping 38.58 -122.58 Calistoga: point the news agent at a location; ping clear drops it
window 2020-09-27 2020-10-20: news for a past window (keeps the location); window live: back to now
wind 12 from 0: manual wind (speed in m/s, direction in degrees it blows from); release wind: back to live NWS
pause / resume / resume 60: stop or run the simulation clock (optionally at 60x)
pin 12 to 2 / unpin 12: pin request 12 to station 2 (the dispatch policy must obey)
reports: what residents sent (text, voice, photos, video) and how much of it moves the queue order"""
ACTIVE = ("pending", "queued", "assigned", "en_route", "on_scene")


class CommanderAgent(MeshAgent):
    queries = [
        "SELECT * FROM sim_clock", "SELECT * FROM grid", "SELECT * FROM weather", "SELECT * FROM station", "SELECT * FROM unit",
        "SELECT * FROM fire_cell", "SELECT * FROM forecast_cell", "SELECT * FROM forecast_meta", "SELECT * FROM road_closure",
        "SELECT * FROM world_version", "SELECT * FROM incident",
        "SELECT * FROM ops_request", "SELECT * FROM ops_queue", "SELECT * FROM ops_travel", "SELECT * FROM ops_flag",
        "SELECT * FROM ops_assessment", "SELECT * FROM ops_risk", "SELECT * FROM ops_unit_route",
        "SELECT * FROM fire_risk_meta", "SELECT * FROM fire_risk_cell", "SELECT * FROM risk_pipeline",
    ]

    def __init__(self) -> None:
        super().__init__("commander")
        self.agent.include(build_chat_protocol(self.handle), publish_manifest=True)
        self.commanders: set[str] = set(json.loads(AUTH_FILE.read_text())) if AUTH_FILE.exists() else set()
        self.reports = ReportsEngine(self)
        self.danger = DangerEngine(self)
        self.planner = Planner(self)

        @self.agent.on_interval(period=settings.situation_period_s)
        async def _pool(ctx: Context):
            await self.planner.pool(ctx)

        @self.agent.on_message(Assessment, replies=AssessmentAck)
        async def _assessment(ctx: Context, sender: str, msg: Assessment):
            """The intake agent read a request's reports: record it; the engines re-weigh and re-plan on commit."""
            if not await self.when_ready(ctx):
                return
            ok, detail = True, "recorded"
            try:
                await self.db.call("publish_assessment", msg.dict())
            except ReducerError as e:
                ok, detail = False, e.message[:200]
            except Exception as e:  # noqa: BLE001 - transport: the intake agent re-sends
                ok, detail = False, f"{type(e).__name__}: {e}"[:200]
            await ctx.send(sender, AssessmentAck(request_id=msg.request_id, ok=ok, detail=detail))

    async def on_ready(self, ctx: Context) -> None:
        self.danger.on_ready()
        self.planner.on_ready(ctx)

    # ── asking the specialists ──────────────────────────────────────────────

    async def reports(self, ctx: Context) -> tuple[FireReport | None, WeatherReport | None]:
        r = await self.ask(ctx, "hazard", HazardReportRequest(), HazardReport)
        return (r.fire, r.weather) if r else (None, None)

    # ── composing the pooled picture ────────────────────────────────────────

    def queue_lines(self, fire: FireReport | None) -> list[str]:
        active = [r for r in self.db.table("ops_request") if r["status"] in ACTIVE]
        levels = Counter(r["level"] for r in active)
        lines = [f"Requests: {len(active)} active" + (" — " + ", ".join(f"{k} {v}" for k, v in levels.most_common()) if active else "")]
        threat = {t.station_id: t for t in fire.stations} if fire else {}
        for s in sorted(self.db.table("station"), key=lambda s: s["id"]):
            q = [e for e in self.db.table("ops_queue") if e["station_id"] == s["id"]]
            units = [u for u in self.db.table("unit") if u["station_id"] == s["id"]]
            free = sum(u["status"] == "available" for u in units)
            t = threat.get(s["id"])
            fire_note = ""
            if t and t.fire_eta_min == 0 and 0 <= t.distance_km <= 0.3:
                fire_note = ", 🔥 FIRE AT STATION"
            elif t and 0 <= t.fire_eta_min <= 180:
                fire_note = f", ⚠ fire in ~{t.fire_eta_min:.0f} min"
            elif t and t.distance_km >= 0:
                fire_note = f", fire {t.distance_km:.1f} km away"
            lines.append(f"• {s['name']}: queue {len(q)}, units {free}/{len(units)} free{fire_note}")
        flags = [f for f in self.db.table("ops_flag") if not f["resolved"]]
        if flags:
            lines.append(f"⚠ {len(flags)} open escalation(s): " + "; ".join(
                f"#{f['request_id']} {f['kind']}: {f['recommendation'] or f['detail']}" for f in flags[:5]))
        return lines

    def incident_line(self) -> str:
        inc = self.db.table("incident").one()
        if not inc:
            return "🗓 Incident: none selected (live mode)"
        day = lambda m: datetime.fromtimestamp(m / 1e6, timezone.utc).strftime("%Y-%m-%d")  # noqa: E731
        return f"🗓 Incident: {inc['name']} — news window {day(inc['news_from'])} → {day(inc['news_to'])}"

    async def situation(self, ctx: Context) -> str:
        # Different agents can be asked concurrently; never two requests to the same agent at once.
        hazard, news = await asyncio.gather(
            self.ask(ctx, "hazard", HazardReportRequest(), HazardReport),
            self.ask(ctx, "news", NewsReportRequest(limit=3), NewsReport),
        )
        fire, weather = (hazard.fire, hazard.weather) if hazard else (None, None)
        clock = self.db.table("sim_clock").one() or {}
        head = f"Incident T+{fmt_min(clock.get('sim_s', 0))}" + ("" if clock.get("running") else " (paused)")
        lines = [head]
        lines.append(self.incident_line())
        lines.append("🔥 Fire: " + (fire.summary if fire else "no answer (hazard agent offline?)"))
        lines.append("💨 Weather: " + (weather.summary if weather else "no answer (hazard agent offline?)"))
        lines.append("📰 News: " + (news.summary if news else "no answer (news agent offline?)"))
        if news:
            lines.append(f"📍 News focus: {news.focus}")
        rs = self.reports.summary()
        if rs["reports_active"]:
            lines.append(f"🙋 Residents: {rs['reports_active']} requests with reports — {rs['reports_fire_credible']} credible fire sightings, "
                         f"{rs['reports_road_blocks']} blocked roads, {rs['reports_trapped']} trapped")
        risk = self.db.table("risk_pipeline").one()
        if risk:
            lines.append(f"Risk pipeline: {risk['status']} ({risk['active_backend']}), forecast {risk['forecast_id'] or 'none'}; {risk['reason']}")
        lines += self.queue_lines(fire)
        return "\n".join(lines)

    # ── chat ────────────────────────────────────────────────────────────────

    async def handle(self, ctx: Context, sender: str, body: str, _sel: dict[str, Any] | None) -> list:
        low = body.lower().strip()
        if m := re.match(r"login\s+(\S+)", low):
            if m.group(1) != settings.operator_passcode.lower():
                return [text("Wrong passcode. " + LOGIN_HELP)]
            self.commanders.add(sender)
            AUTH_FILE.write_text(json.dumps(sorted(self.commanders)))
            return [text("Signed in as incident commander. Say help for the command list.\n\n" + await self.situation(ctx))]
        if sender not in self.commanders:
            if low == "login":
                return [text("Almost: login needs the passcode after it. " + LOGIN_HELP)]
            return [text("This is the incident-command console for the Wildfire Rescue Queue demo, and you're not signed in yet, "
                         "so I can't run that. " + LOGIN_HELP)]
        if low in ("help", "?", "commands"):
            return [text(HELP)]
        try:
            if m := re.match(r"pin\s+#?(\d+)\s+(?:to\s+)?(?:station\s+)?#?(\d+)", low):
                await self.db.call("override_assignment", int(m.group(1)), int(m.group(2)), "via ASI:One")
                return [text(f"Request #{m.group(1)} pinned to station {m.group(2)}.")]
            if m := re.match(r"unpin\s+#?(\d+)", low):
                await self.db.call("override_assignment", int(m.group(1)), 0, "via ASI:One")
                return [text(f"Request #{m.group(1)} unpinned; the policy decides again.")]
            if m := re.match(r"wind\s+(\d+(?:\.\d+)?)\s*(?:m/s\s+)?from\s+(\d+)", low):
                await self.db.call("set_weather", float(m.group(1)), float(m.group(2)), float(m.group(1)), "manual")
                return [text(f"Wind set to {m.group(1)} m/s from {m.group(2)}° (manual). The hazard agent is re-running fire and forecast.")]
            if re.match(r"release\s+wind", low):
                await self.db.call("release_weather_lock")
                return [text("Manual wind released; the live NWS feed takes over at its next poll.")]
            if re.match(r"pause\b", low):
                c = self.db.table("sim_clock").one()
                await self.db.call("set_sim", False, float(c["speed"]) if c else 30.0)
                return [text("Simulation paused.")]
            if m := re.match(r"resume(?:\s+(\d+(?:\.\d+)?))?", low):
                c = self.db.table("sim_clock").one()
                speed = float(m.group(1)) if m.group(1) else (float(c["speed"]) if c else 30.0)
                await self.db.call("set_sim", True, speed)
                return [text(f"Simulation running at {speed:g}x.")]
            if low.startswith("fire"):
                fire = await self.ask(ctx, "hazard", FireReportRequest(), FireReport)
                if not fire:
                    return [text("The hazard agent didn't answer.")]
                rows = [f"{t.station}: " + (f"fire in ~{t.fire_eta_min:.0f} min" if t.fire_eta_min >= 0 else "beyond 3 h forecast")
                        + (f", {t.distance_km:.1f} km away" if t.distance_km >= 0 else "") for t in fire.stations]
                return [text(f"🔥 {fire.summary}\nSource: {fire.source}" + (f" (last detection {fire.last_detection})" if fire.last_detection else "")
                             + "\n" + "\n".join(rows))]
            if low.startswith("incident"):
                arg = low.removeprefix("incident").strip()
                catalog = incidents.load_catalog()
                if arg in ("clear", "none", "live"):
                    await self.db.call("clear_incident")
                    return [text("Incident cleared; news and recency are back to live mode.")]
                if arg:
                    if arg not in catalog:
                        return [text(f"Unknown incident '{arg}'. Available: {', '.join(catalog)}")]
                    await incidents.select(self.db, catalog[arg])
                    return [text(f"Incident set: {catalog[arg].name}. News now follows the X accounts near it and keeps "
                                 f"posts from its window ({catalog[arg].news_from:%Y-%m-%d} → {catalog[arg].news_to:%Y-%m-%d}). "
                                 "Say 'news' to see stored posts, or 'refresh news' to pull them (costs Bright Data credits).")]
                rows = [f"• {k}: {i.name} ({i.news_from:%Y-%m-%d} → {i.news_to:%Y-%m-%d})" for k, i in catalog.items()]
                return [text(self.incident_line() + "\nAvailable (say incident followed by the key, e.g. incident glass-fire-2020):\n" + "\n".join(rows))]
            if m := re.match(r"ping\s+(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)\s*(.*)", body.strip(), re.I):
                lat, lon, label = float(m.group(1)), float(m.group(2)), m.group(3).strip()
                await self.db.call("ping_news", lat, lon, label)
                return [text(f"News focus set to {label or 'the pinned location'} ({lat:.3f}, {lon:.3f}). The news agent is "
                             "re-scoring stored posts and pulling the trusted accounts near it; say 'news' in a minute or two.")]
            if re.match(r"ping\s+clear", low):
                await self.db.call("clear_news_focus")
                return [text("Ping cleared; news falls back to the incident's center, then the stations.")]
            if m := re.match(r"window\s+(\d{4}-\d{2}-\d{2})\s+(?:to\s+|→\s*)?(\d{4}-\d{2}-\d{2})", low):
                try:
                    inc = incidents.adhoc(m.group(1), m.group(2))
                except ValueError as e:
                    return [text(str(e))]
                await incidents.select(self.db, inc)
                return [text(f"Time window set: {m.group(1)} → {m.group(2)} (same location). News keeps only posts from it; "
                             "'incident clear' or 'window live' goes back to now.")]
            if re.match(r"window\s+(live|now|clear)", low):
                await self.db.call("clear_incident")
                return [text("Back to live: news looks at the last hours around the current location.")]
            if re.match(r"(refresh|update)\s+news", low):
                res = await self.ask(ctx, "news", NewsRefreshRequest(), NewsRefreshResult)
                return [text(res.message if res else "The news agent didn't answer.")]
            if m := re.match(r"track\s+(\S+)", body.strip(), re.I):
                res = await self.ask(ctx, "news", NewsTrackRequest(url=m.group(1)), NewsRefreshResult)
                return [text(res.message if res else "The news agent didn't answer.")]
            if low.startswith("news"):
                news = await self.ask(ctx, "news", NewsReportRequest(limit=5), NewsReport)
                if not news:
                    return [text("The news agent didn't answer.")]
                rows = []
                for i in news.items:
                    sig = [s for s in (
                        "🚨 evacuations" if i.evacuation else "",
                        "🚧 " + i.closures.split(" | ")[0][:140] if i.closures else "",
                        "🏠 " + i.relief.split(" | ")[0][:140] if i.relief else "",
                        f"{i.containment_pct:.0f}% contained" if i.containment_pct >= 0 else "",
                        f"{i.acres:,.0f} acres" if i.acres >= 0 else "",
                    ) if s]
                    who = i.source + (" (official)" if i.official else "")
                    rows.append(f"• [{i.relevance:.2f}] {who}: {i.title} ({i.published})\n   {i.url}" + ("\n   " + "; ".join(sig) if sig else ""))
                tail = (f"\nFocus: {news.focus}\nFollowing: {', '.join(news.accounts) or 'no accounts'}\nSource: {news.source}"
                        + (f", last scrape {news.last_fetch.replace('T', ' ').rstrip('Z')} UTC" if news.last_fetch else ""))
                return [text(f"📰 {news.summary}\n" + "\n".join(rows) + tail)]
            if low.startswith("report"):
                return [text(self.reports_text())]
            if low.startswith("weather") or low.startswith("wind"):
                w = await self.ask(ctx, "hazard", WeatherReportRequest(), WeatherReport)
                return [text(f"💨 {w.summary}" if w else "The hazard agent didn't answer.")]
        except ReducerError as e:
            return [text(f"Rejected by the database: {e.message}")]
        return [text(await self.situation(ctx))]


    def reports_text(self) -> str:
        rows = {a["request_id"]: a for a in self.db.table("ops_assessment")}
        if not rows:
            return "No field reports yet."
        weighed = self.reports.weigh_all()
        lines = []
        for rid in sorted(rows, reverse=True)[:10]:
            a, w = rows[rid], weighed.get(rid)
            applied = (w.note or "nothing beyond the form") if w else "not weighed yet"
            lines.append(f"• #{rid} [{a['analyzer']}, {a['report_count']} report(s)]: {a['summary']}\n"
                         f"   credibility {w.credibility if w else 0:.2f}; effect on the queue: {applied}")
        return "🙋 Field reports (newest first):\n" + "\n".join(lines)


if __name__ == "__main__":
    CommanderAgent().run()
