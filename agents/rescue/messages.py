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
