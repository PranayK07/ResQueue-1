"""Danger assessment: for every request, how long until fire reaches it, how long a unit needs to get there,
and the resulting slack and level. Pure numpy over the same grid / forecast / routing the live danger agent
uses, so the RL simulator can call it directly.

    slack = fire_eta - (now + travel + extract) - margin        (core.slack)

`adjust` carries what the commander accepted from residents' field reports (core.reports): a fire ETA that
can only move earlier, and extra on-scene time for a blocked road.
"""
from __future__ import annotations

import math
from typing import Iterable

import numpy as np

from .geo import Grid
from .reports import NEAR_FIRE_M, LocalHazard
from .routing import GridRouter, RoadParams, blocked_mask
from .slack import extract_time_s, level_for, slack_s

# Must match the hazard agent's forecast horizon: a cell missing from the forecast is "not reached within it".
FORECAST_HORIZON_S = 3 * 3600.0
UNREACHABLE_S = 1e9  # JSON-safe stand-in for "no safe ground route"


def local_hazard(grid: Grid, now_s: float, lat: float, lon: float, forecast: dict[int, float], burning: set[int],
                 spot_radius_m: float = NEAR_FIRE_M) -> LocalHazard:
    """The hazard model's view at one point: forecast fire arrival, distance to the nearest burning cell, and the
    wind-dependent spotting radius (core.reports.spot_radius_m)."""
    cid = grid.locate(lat, lon)
    eta = now_s if cid is not None and cid in burning else forecast.get(cid, math.inf) if cid is not None else math.inf
    if burning:
        centers = np.array([grid.center(b) for b in burning])
        lat0 = math.radians(lat)
        dy = (centers[:, 0] - lat) * 111_320.0
        dx = (centers[:, 1] - lon) * 111_320.0 * math.cos(lat0)
        nearest = float(np.sqrt(dx * dx + dy * dy).min())
    else:
        nearest = math.inf
    return LocalHazard(now_s=now_s, fire_eta_s=eta, nearest_burning_m=nearest, spot_radius_m=spot_radius_m)


def assess_requests(
    grid: Grid,
    now_s: float,
    requests: Iterable[tuple[int, float, float, int, str]],  # (id, lat, lon, headcount, needs)
    stations: Iterable[tuple[int, float, float]],  # (id, lat, lon)
    forecast: dict[int, float],  # cell_id -> early (p10) fire arrival, absolute sim s
    burning: set[int],
    closures: list[tuple[float, float, float, float]],
    params: RoadParams = RoadParams(),
    adjust: dict[int, tuple[float | None, float]] | None = None,  # request_id -> (fire ETA hint, extra on-scene s)
) -> tuple[list[dict], list[dict]]:
    """Returns (assessments, travel) shaped for the `publish_danger` reducer (snake_case keys)."""
    fire_early = np.full((grid.rows, grid.cols), np.inf)
    for cid, t in forecast.items():
        fire_early[grid.rc(cid)] = t
    blocked = blocked_mask(grid, burning, closures)
    router = GridRouter(grid, params)
    fields = {sid: router.travel_times((lat, lon), now_s, fire_early, blocked) for sid, lat, lon in stations}

    assessments: list[dict] = []
    travel: list[dict] = []
    for rid, lat, lon, headcount, needs in requests:
        rc = grid.locate_rc(lat, lon)
        if rc is None:  # outside the incident grid
            continue
        cid = grid.cell_id(*rc)
        fire_eta = now_s if cid in burning else forecast.get(cid, now_s + FORECAST_HORIZON_S)
        best = math.inf
        for sid, field in fields.items():
            t = float(field[rc])
            ok = math.isfinite(t)
            best = min(best, t)
            travel.append({"request_id": rid, "station_id": sid, "travel_s": round(t, 1) if ok else UNREACHABLE_S, "reachable": ok})
        hint, extra = (adjust or {}).get(rid, (None, 0.0))
        if hint is not None:
            fire_eta = min(fire_eta, hint)
        extract = extract_time_s(headcount, needs) + extra
        # The legacy wire contract requires a finite number. Zero is unused when every route is
        # unreachable; the database exposes null slack for that case. Never subtract a transport sentinel.
        slack = slack_s(fire_eta, now_s, 0.0, best, extract) if math.isfinite(best) else 0.0
        assessments.append({"request_id": rid, "level": level_for(slack) if math.isfinite(best) else "unreachable", "slack_s": round(slack, 1),
                            "fire_eta_s": round(fire_eta, 1), "extract_s": round(extract, 1)})
    return assessments, travel
