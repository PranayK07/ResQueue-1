"""uAgents message models for direct agent-to-agent requests.

SpacetimeDB is the shared blackboard (state every agent reacts to); these
messages are for questions one agent asks another that must NOT become
shared state: explanations, what-if forecasts, policy comparisons, health.
"""
from __future__ import annotations

from uagents import Model


class StatusQuery(Model):
    pass


class StatusReply(Model):
    name: str
    role: str
    status: str
    detail: str


class ExplainRequest(Model):
    request_id: int


class Explanation(Model):
    request_id: int
    text: str


class WhatIfPoint(Model):
    request_id: int
    lat: float
    lon: float


class WhatIfWind(Model):
    wind_speed_mps: float
    wind_from_deg: float
    points: list[WhatIfPoint]


class WhatIfResult(Model):
    summary: str
    fire_eta_min: dict[str, float]  # request_id (str) -> minutes until fire (p10); -1 = beyond horizon


class ComparePolicies(Model):
    pass


class PolicyRow(Model):
    policy: str
    people_in_time: int
    late: int
    unreachable: int
    mean_slack_min: float


class PolicyComparison(Model):
    rows: list[PolicyRow]
    active_policy: str


# ─── Commander <-> specialist reports ───────────────────────────────────────

class FireReportRequest(Model):
    pass


class StationThreat(Model):
    station_id: int
    station: str
    fire_eta_min: float  # minutes until fire (p10 forecast) reaches the station; -1 = beyond horizon
    distance_km: float  # straight-line distance to the nearest burning cell


class FireReport(Model):
    source: str  # sim | firms | firms+sim
    sim_min: float
    burning_cells: int
    area_km2: float
    growth_km2_30min: float
    heading_deg: float  # compass direction the head of the fire is moving toward
    head_rate_kmh: float
    stations: list[StationThreat]
    last_detection: str  # latest FIRMS detection time ingested ("" if none)
    summary: str


class WeatherReportRequest(Model):
    pass


class WeatherReport(Model):
    source: str  # nws | scenario | manual
    station: str  # NWS station id the observation came from
    observed_at: str
    wind_speed_mps: float
    wind_from_deg: float
    gust_mps: float
    humidity_pct: float  # -1 = unknown
    temperature_c: float  # -999 = unknown
    locked: bool  # commander has manual control of wind in the DB
    trend: str
    red_flag: bool
    summary: str


class HazardReportRequest(Model):
    """One round trip for the commander's situation picture (a single
    request per destination avoids uAgents' per-session reply collisions)."""


class HazardReport(Model):
    fire: FireReport
    weather: WeatherReport


# ─── Commander <-> news agent ───────────────────────────────────────────────

class NewsReportRequest(Model):
    limit: int = 5


class NewsItem(Model):
    title: str
    url: str
    source: str  # the X account, "@handle"
    official: bool  # a government agency account (news_sources.json)
    published: str
    relevance: float
    evacuation: bool
    closures: str
    relief: str  # shelter / relief sentences, " | "-joined
    containment_pct: float  # -1 unknown
    acres: float  # -1 unknown


class NewsReport(Model):
    items: list[NewsItem]
    summary: str
    last_fetch: str
    source: str  # file | brightdata | off
    accounts: list[str]  # "@handle"s the agent follows for the current focus
    focus: str  # where and when it is looking, e.g. "Calistoga (38.579, -122.580) · 2020-09-27 → 2020-10-20"


class NewsRefreshRequest(Model):
    pass


class NewsTrackRequest(Model):
    """Collect one X post by URL (the commander saw it) and score it like the rest."""
    url: str


class NewsRefreshResult(Model):
    ok: bool
    message: str


# ─── Intake agent -> commander ──────────────────────────────────────────────

class Assessment(Model):
    """The intake agent's reading of everything one request sent (text, voice transcript, photos, video frames).
    Claims, not facts: the commander weighs them (core/reports.py). Fields match the publish_assessment reducer."""
    request_id: int
    report_count: int
    people: int  # 0 = not stated
    needs: str  # comma list
    injured: bool
    trapped: bool
    fire_seen: bool
    fire_distance_m: float  # -1 = unknown
    smoke: bool
    road_blocked: bool
    road_note: str
    media_supports: bool  # the photos / frames themselves show the fire or blocked road
    confidence: float
    urgency: float
    summary: str
    resident_reply: str
    analyzer: str  # vision model id, 'keywords' or 'form'


class AssessmentAck(Model):
    request_id: int
    ok: bool  # recorded; False = the intake agent retries
    detail: str


class SignalRequest(Model):
    """The commander hands a (mock or relayed) distress signal to the intake subagent, which files it exactly like a
    resident's ping plus one text report, so it travels the whole pipeline: intake -> commander -> risk -> queue."""
    lat: float
    lon: float
    headcount: int
    needs: str  # comma list
    text: str  # what the signal says; read by the intake analyzer like any resident report
    label: str


class SignalAck(Model):
    request_id: int  # 0 = not filed
    ok: bool
    detail: str


class IntakeReportRequest(Model):
    pass


class IntakeReport(Model):
    analyzer: str  # vision model id, or 'keywords'
    requests_read: int
    awaiting_ack: int  # readings the commander hasn't confirmed yet
    summary: str
