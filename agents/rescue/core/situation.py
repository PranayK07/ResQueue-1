"""The head agent's synthesized view of the incident.

One typed record pooling the hazard agent's fire + weather reports, the news agent's signals, and residents'
field reports (intake agent, weighed by core/reports.py). The commander agent builds it live and writes it to SpacetimeDB (`situation` table); the RL
workstream can build the same record from the simulator, and read the table's history as
training / evaluation data. Pure data: no network or uAgents imports.

Field names match the `record_situation` reducer arguments (snake_case)."""
from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass


# ─── Model input ────────────────────────────────────────────────────────────
# A fixed-order numeric encoding of the environment, for a learned policy. STARTING POINT: change it freely,
# but bump FEATURE_VERSION and store the version with any trained model so training and serving agree.
FEATURE_VERSION = 3
FEATURE_NAMES = [
    "fire_area_log",  # log1p(km²) / 6, so ~400 km² is ~1
    "fire_growth_frac",  # fraction of current area added in the last <= 30 sim-min, clipped to [0, 1]
    "fire_heading_sin", "fire_heading_cos",  # compass heading of the fire head (circular, so sin/cos)
    "fire_head_kmh",  # / 10
    "wind_speed", "wind_from_sin", "wind_from_cos", "gust",  # m/s / 20, direction as sin/cos, gust / 30
    "humidity_known", "humidity",  # humidity / 100 (0 when unknown, with the flag above)
    "red_flag",
    "news_ok", "news_relevant", "news_evacuation", "news_closures",  # counts / 10 and / 5, clipped to 1
    "containment_known", "containment",  # pct / 100
    "acres_known", "acres_log",  # log1p(acres) / 12
    "nearest_station_eta",  # min over stations of eta / 180 min; 1.0 = beyond the 3 h forecast horizon
    "nearest_station_dist",  # min over stations of km / 30, clipped to 1
    "wind_age",  # wind_age_min / 180, clipped to 1; 1.0 when unknown
    "data_fresh",  # 0 when any input is stale
    # v3: residents' field reports (counts / 10, clipped to 1)
    "reports_active", "reports_fire_credible", "reports_road_blocks", "reports_trapped",
]


def _sin_cos(deg: float) -> tuple[float, float]:
    r = math.radians(deg)
    return math.sin(r), math.cos(r)


@dataclass
class Situation:
    sim_s: float
    incident: str  # '' = live mode
    fire_area_sq_km: float
    fire_growth_sq_km: float  # over the last <= 30 sim-min; 0 = not enough history yet
    fire_heading_deg: float  # compass direction the head of the fire is moving toward
    fire_head_kmh: float
    wind_speed_mps: float
    wind_from_deg: float
    gust_mps: float
    humidity_pct: float  # -1 = unknown
    red_flag: bool
    news_ok: bool  # False = news agent did not answer; the news fields are neutral
    news_relevant: int
    news_evacuation: bool
    news_closures: int
    news_max_containment_pct: float  # -1 = unknown
    news_max_acres: float  # -1 = unknown
    stations_json: str  # [{"id", "eta_min", "dist_km"}]; eta -1 = beyond the forecast horizon
    summary: str
    # Freshness: when was the wind data observed, and is anything stale? (-1 / '' = unknown)
    wind_source: str = ""  # nws | manual | scenario | none
    wind_observed_at: str = ""  # ISO-8601 UTC time of the NWS observation (or of the manual/scenario write)
    wind_age_min: float = -1.0
    forecast_age_sim_min: float = -1.0
    forecast_matches_wind: bool = True  # False = the forecast predates the latest wind change
    news_last_fetch: str = ""  # ISO-8601 UTC
    news_age_min: float = -1.0
    data_fresh: bool = True
    stale_reasons: str = ""
    # Field reports, as weighed by the commander (core/reports.summarize)
    reports_active: int = 0
    reports_fire_credible: int = 0
    reports_road_blocks: int = 0
    reports_trapped: int = 0

    def to_row(self) -> dict:
        return asdict(self)

    def stations(self) -> list[dict]:
        return json.loads(self.stations_json)

    def changed_materially(self, prev: "Situation | None") -> bool:
        """Is this worth a new row? (Heartbeat rows are the caller's job.)"""
        if prev is None or self.incident != prev.incident:
            return True
        area_delta = abs(self.fire_area_sq_km - prev.fire_area_sq_km)
        if area_delta >= max(0.2, 0.02 * prev.fire_area_sq_km):
            return True
        wind_dir = abs((self.wind_from_deg - prev.wind_from_deg + 180) % 360 - 180)
        if abs(self.wind_speed_mps - prev.wind_speed_mps) >= 1.0 or wind_dir >= 10:
            return True
        return (
            self.red_flag != prev.red_flag
            or self.news_ok != prev.news_ok
            or self.news_relevant != prev.news_relevant
            or self.news_evacuation != prev.news_evacuation
            or self.news_closures != prev.news_closures
            or self.data_fresh != prev.data_fresh
            or self.reports_fire_credible != prev.reports_fire_credible
            or self.reports_road_blocks != prev.reports_road_blocks
            or self.reports_trapped != prev.reports_trapped
        )

    def feature_vector(self) -> list[float]:
        """Fixed-order numeric encoding (see FEATURE_NAMES / FEATURE_VERSION)."""
        hs, hc = _sin_cos(self.fire_heading_deg)
        ws, wc = _sin_cos(self.wind_from_deg)
        stations = self.stations()
        etas = [s["eta_min"] for s in stations if s["eta_min"] >= 0]
        dists = [s["dist_km"] for s in stations if s["dist_km"] >= 0]
        clip = lambda x: max(0.0, min(1.0, x))  # noqa: E731
        return [
            math.log1p(max(0.0, self.fire_area_sq_km)) / 6,
            clip(self.fire_growth_sq_km / max(self.fire_area_sq_km, 1.0)),
            hs, hc,
            self.fire_head_kmh / 10,
            self.wind_speed_mps / 20, ws, wc, self.gust_mps / 30,
            float(self.humidity_pct >= 0), max(0.0, self.humidity_pct) / 100,
            float(self.red_flag),
            float(self.news_ok), clip(self.news_relevant / 10), float(self.news_evacuation), clip(self.news_closures / 5),
            float(self.news_max_containment_pct >= 0), max(0.0, self.news_max_containment_pct) / 100,
            float(self.news_max_acres >= 0), math.log1p(max(0.0, self.news_max_acres)) / 12,
            clip(min(etas, default=180.0) / 180),
            clip(min(dists, default=30.0) / 30),
            clip(self.wind_age_min / 180) if self.wind_age_min >= 0 else 1.0,
            float(self.data_fresh),
            clip(self.reports_active / 10), clip(self.reports_fire_credible / 10), clip(self.reports_road_blocks / 10),
            clip(self.reports_trapped / 10),
        ]
