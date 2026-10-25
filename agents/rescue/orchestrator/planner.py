"""Planner engine: synthesis and the dispatch policy.

SYNTHESIS. Every SITUATION_PERIOD_S it asks its three subagents for their typed reports (uAgents messages, in
parallel): hazard (fire + weather), news (X posts) and intake (residents' reports: analyzer health, readings
outstanding), adds the reports engine's field-report counts, merges them into one
`Situation` (core/situation.py, with freshness), keeps it as `self.latest`, and records it in SpacetimeDB's
`situation` table when something material changed (plus a heartbeat row every 5 min).

PLANNING. On changes to requests, travel estimates, assessments, units or the world it builds a `PlanInput`
from the database (planning.build_plan_input: requests with their slack and travel times from the danger
engine, the weighed field reports, units, stations, and `self.latest`), runs the policy chosen by POLICY
(nearest | greedy | lookahead | rl), and publishes the result with publish_plan, only when the plan changed. New
requests whose reports the intake agent is still reading are held back for at most INTAKE_GRACE_S. The database
enforces the invariants (commander pins win, a committed unit is never reassigned), so any policy can only propose.

The RL model plugs in here: POLICY=rl runs rescue/rl_policy.py.
"""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from uagents import Context

from ..config import settings
from ..core.policy import POLICIES
from ..core.situation import Situation
from ..messages import HazardReport, HazardReportRequest, IntakeReport, IntakeReportRequest, NewsReport, NewsReportRequest
from ..planning import build_plan_input, plan_signature, plan_to_reducer_args, validate_plan, risk_inputs_ready
from ..stdb import Debouncer

if TYPE_CHECKING:
    from ..agents.commander import CommanderAgent

HEARTBEAT_ROW_S = 300.0
# Staleness limits. A NWS observation older than this is flagged; so is a forecast that predates the latest wind
# change for longer than a re-forecast should take, and (live mode only) a news scrape older than the news limit.
WIND_OBS_MAX_AGE_MIN = 180.0
FORECAST_LAG_MAX_S = 90.0
NEWS_MAX_AGE_MIN = 360.0
WATCH = ["ops_request", "ops_travel", "ops_assessment", "ops_risk", "unit", "world_version"]


def _iso_micros(micros: int) -> str:
    return datetime.fromtimestamp(micros / 1e6, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _age_min(iso: str) -> float:
    try:
        return max(0.0, (datetime.now(timezone.utc) - datetime.fromisoformat(iso.replace("Z", "+00:00"))).total_seconds() / 60)
    except ValueError:
        return -1.0


def make_policy():
    if settings.policy == "rl":  # the RL teammate's model: rescue/rl_policy.py
        from ..rl_policy import RLPolicy
        return RLPolicy()
    if settings.policy in POLICIES:
        return POLICIES[settings.policy]()
    raise SystemExit(f"POLICY={settings.policy!r} is not one of {sorted([*POLICIES, 'rl'])}")


class Planner:
    def __init__(self, agent: "CommanderAgent") -> None:
        self.agent = agent
        self.latest: Situation | None = None  # the policy's live fire / wind / news / reports input
        self.intake: IntakeReport | None = None  # the intake agent's last answer
        self._recorded: Situation | None = None
        self._news_sig: tuple | None = None  # what the risk records currently say about news
        self._recorded_at = -1e9
        self.recorded_count = 0
        self.policy = make_policy()
        self._last_error = ""
        self._debounce: Debouncer | None = None
        self._last_plan_sig: tuple | None = None
        self._release: asyncio.TimerHandle | None = None
        self.plans_published = 0

    def on_ready(self, ctx: Context) -> None:
        ctx.logger.info(f"dispatch policy: {settings.policy} -> {self.policy.name}")
        self._debounce = Debouncer(self.plan, delay=0.3, min_interval=2.0)
        self.agent.db.on_update(WATCH, lambda _u: self._debounce.trigger())
        self._debounce.trigger()

    async def plan(self) -> None:
        """Build the policy's input from the database, run the policy, publish the plan if it changed."""
        a, db = self.agent, self.agent.db
        if not a.ready.is_set():
            return
        clock = db.table("sim_clock").one()
        if not clock:
            return
        hold, wait = a.reports.hold()
        if wait and self._release is None:  # re-plan when the first held request's grace runs out
            def _fire():
                self._release = None
                self._debounce.trigger()
            self._release = asyncio.get_running_loop().call_later(wait + 0.5, _fire)
        requests, risks, queue = list(db.table("ops_request")), list(db.table("ops_risk")), list(db.table("ops_queue"))
        if not risk_inputs_ready(requests, risks, hold, queue):
            return  # preserve the last plan; do not mix new evidence with old danger/travel numbers
        inp = build_plan_input(
            clock["sim_s"], requests, list(db.table("ops_travel")), list(db.table("unit")),
            list(db.table("station")), self.latest, queue=queue,
            weighed=a.reports.weigh_all(), hold=hold, risks=risks)
        try:
            plan = await asyncio.to_thread(self.policy.plan, inp)
        except Exception as e:  # noqa: BLE001 - a model under development must not take the agent down
            msg = f"{type(e).__name__}: {e}"
            if msg != self._last_error:
                a.log.exception("policy %s failed; keeping the last published plan", getattr(self.policy, "name", "?"))
                self._last_error = msg
            a.set_part("planner", "degraded", f"policy {getattr(self.policy, 'name', '?')} failed: {msg}"[:160])
            return
        self._last_error = ""
        plan, problems = validate_plan(inp, plan)
        if problems:
            a.log.warning("policy %s returned an invalid plan; dropped: %s", plan.policy, "; ".join(problems[:5]))
        sig = plan_signature(plan)
        if sig == self._last_plan_sig or (self._last_plan_sig is None and not plan.entries and not plan.unreachable):
            return
        name, entries, unreachable = plan_to_reducer_args(plan)
        if await db.try_call("publish_plan", name, entries, unreachable):
            self._last_plan_sig = sig
            self.plans_published += 1
            a.log.info("published plan #%d (%s): %d queued, %d dispatched now, %d unreachable, %d held for intake",
                       self.plans_published, name, len(entries), sum(1 for e in entries if e["unit_id"]), len(unreachable), len(hold))

    async def pool(self, ctx: Context) -> None:
        a = self.agent
        if not a.ready.is_set():
            return
        hazard, news, intake = await asyncio.gather(
            a.ask(ctx, "hazard", HazardReportRequest(), HazardReport),
            a.ask(ctx, "news", NewsReportRequest(limit=20), NewsReport),
            a.ask(ctx, "intake", IntakeReportRequest(), IntakeReport),
        )
        self.intake = intake
        if hazard is None:  # no fire/wind picture = nothing trustworthy to synthesize or train on
            a.set_part("planner", "degraded", "hazard agent not answering; no situation recorded")
            return
        if hazard.weather.source in ("none", ""):  # the hazard agent's weather row is the empty default: no world loaded
            a.set_part("planner", "degraded", "hazard agent reports no world loaded yet; no situation recorded")
            return
        inc = a.db.table("incident").one()
        a.reports.weigh_all()
        sit = self.synthesize(hazard, news, inc["key"] if inc else "")
        self.latest = sit
        news_sig = (sit.news_ok, sit.news_evacuation, sit.news_closures)
        if news_sig != self._news_sig:  # news is part of each resident's risk record: reassess when it changes
            self._news_sig = news_sig
            if a.danger._debounce:
                a.danger._debounce.trigger()
        now = time.monotonic()
        if sit.changed_materially(self._recorded) or now - self._recorded_at >= HEARTBEAT_ROW_S:
            if await a.db.try_call("record_situation", sit.to_row()):
                self._recorded, self._recorded_at = sit, now
                self.recorded_count += 1
        a.set_part("planner", "online" if news and sit.data_fresh else "degraded",
                   f"{self.recorded_count} situations; fire {sit.fire_area_sq_km:.1f} km², wind {sit.wind_speed_mps:.0f} m/s, "
                   f"{sit.news_relevant} relevant news, {sit.reports_active} field reports"
                   + ("" if news else " (news agent silent)") + ("" if intake else " (intake agent silent)")
                   + ("" if sit.data_fresh else f" | STALE: {sit.stale_reasons}"))

    def freshness(self, hazard: HazardReport, news: NewsReport | None, incident: str) -> dict:
        """When was each input observed, and is any of it stale? Computed from timestamps the data itself carries."""
        db = self.agent.db
        w, reasons = hazard.weather, []
        wrow = db.table("weather").one() or {}
        if w.source == "nws" and w.observed_at:  # the real observation time, not when we wrote it
            observed, age = w.observed_at, _age_min(w.observed_at)
            if age > WIND_OBS_MAX_AGE_MIN:
                reasons.append(f"wind observation is {age / 60:.1f} h old")
        elif wrow.get("updated_at"):  # manual / scenario wind: when it was set
            observed = _iso_micros(wrow["updated_at"]); age = _age_min(observed)
        else:
            observed, age = "", -1.0
        fm, wv = db.table("forecast_meta").one(), db.table("world_version").one()
        f_age, f_ok = -1.0, True
        if fm and fm["version"]:
            f_age = max(0.0, (self.agent.sim_now() - fm["computed_at_s"]) / 60)
            lag_s = datetime.now(timezone.utc).timestamp() - fm["updated_at"] / 1e6
            f_ok = not (wv and fm["weather_version"] != wv["weather"] and lag_s > FORECAST_LAG_MAX_S)
            if not f_ok:
                reasons.append("forecast predates the latest wind change")
        n_fetch = news.last_fetch if news else ""
        n_age = _age_min(n_fetch) if n_fetch else -1.0
        if news and not incident and n_age > NEWS_MAX_AGE_MIN and settings.news_source == "brightdata":
            reasons.append(f"news last scraped {n_age / 60:.1f} h ago")
        return dict(wind_source=w.source, wind_observed_at=observed, wind_age_min=round(age, 1), forecast_age_sim_min=round(f_age, 1),
                    forecast_matches_wind=f_ok, news_last_fetch=n_fetch, news_age_min=round(n_age, 1),
                    data_fresh=not reasons, stale_reasons="; ".join(reasons))

    def synthesize(self, hazard: HazardReport, news: NewsReport | None, incident: str) -> Situation:
        f, w = hazard.fire, hazard.weather
        relevant = [i for i in (news.items if news else []) if i.relevance >= 0.5]
        contain = [i.containment_pct for i in relevant if i.containment_pct >= 0]
        acres = [i.acres for i in relevant if i.acres >= 0]
        reports = self.agent.reports.summary()
        parts = [f"Fire: {f.summary}", f"Weather: {w.summary}"] + ([f"News ({news.focus}): {news.summary}"] if news else ["News: unavailable"])
        parts.append(f"Intake: {self.intake.summary}" if self.intake else "Intake: unavailable")
        if reports["reports_active"]:
            parts.append(f"Residents: {reports['reports_active']} requests with reports, {reports['reports_fire_credible']} credible fire "
                         f"sightings, {reports['reports_road_blocks']} blocked roads, {reports['reports_trapped']} trapped")
        return Situation(
            sim_s=self.agent.sim_now(), incident=incident,
            fire_area_sq_km=f.area_km2, fire_growth_sq_km=f.growth_km2_30min, fire_heading_deg=f.heading_deg, fire_head_kmh=f.head_rate_kmh,
            wind_speed_mps=w.wind_speed_mps, wind_from_deg=w.wind_from_deg, gust_mps=w.gust_mps, humidity_pct=w.humidity_pct, red_flag=w.red_flag,
            news_ok=news is not None, news_relevant=len(relevant),
            news_evacuation=any(i.evacuation for i in relevant), news_closures=sum(1 for i in relevant if i.closures),
            news_max_containment_pct=max(contain, default=-1.0), news_max_acres=max(acres, default=-1.0),
            stations_json=json.dumps([{"id": t.station_id, "eta_min": t.fire_eta_min, "dist_km": t.distance_km} for t in f.stations]),
            summary=" | ".join(parts)[:1500],
            **self.freshness(hazard, news, incident),
            **reports,
        )
