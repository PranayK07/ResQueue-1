"""Time-dependent travel times from a station to every cell.

A route is only valid if the unit passes through each cell before the fire's
*early* (p10) arrival there, minus a safety buffer — so a road that is open
now but will be cut by the time the unit gets there is correctly treated as
closed. Closed roads and burning cells are impassable.

`GridRouter` drives over the fire grid as a stand-in road network (cell-to-
cell with a detour factor). `Router` is the interface; an OSM road-graph
router can drop in later without touching the danger agent.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from .geo import Grid

INF = np.inf
_OFFSETS = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]


@dataclass(frozen=True)
class RoadParams:
    speed_mps: float = 12.0  # ~43 km/h average incl. smoke and evacuation traffic
    detour_factor: float = 1.35  # road distance / straight-line distance
    fire_buffer_s: float = 300.0  # must clear a cell this long before the fire


class Router(Protocol):
    def travel_times(
        self, origin: tuple[float, float], depart_s: float, fire_early: np.ndarray, blocked: np.ndarray
    ) -> np.ndarray:
        """Seconds of travel from `origin` to every cell (rows, cols); inf = unreachable."""


class GridRouter:
    def __init__(self, grid: Grid, params: RoadParams = RoadParams()):
        self.grid = grid
        self.p = params
        self._cost = [grid.cell_size_m * math.hypot(dr, dc) * params.detour_factor / params.speed_mps for dr, dc in _OFFSETS]

    def travel_times(self, origin, depart_s, fire_early, blocked):
        g = self.grid
        start = g.locate_rc(*origin)
        if start is None:
            return np.full((g.rows, g.cols), INF)
        deadline = fire_early - self.p.fire_buffer_s - depart_s  # latest relative time we may be in each cell
        deadline = np.where(blocked, -INF, deadline)
        t = np.full((g.rows, g.cols), INF)
        t[start] = 0.0  # stations are never "blocked" for departure
        R, C = g.rows, g.cols
        for _ in range(4 * (R + C)):
            changed = False
            for (dr, dc), cost in zip(_OFFSETS, self._cost):
                sr, sc = slice(max(0, -dr), R - max(0, dr)), slice(max(0, -dc), C - max(0, dc))
                tr, tc = slice(max(0, dr), R - max(0, -dr)), slice(max(0, dc), C - max(0, -dc))
                cand = t[sr, sc] + cost
                dst = t[tr, tc]
                ok = (cand < dst) & (cand <= deadline[tr, tc])
                if ok.any():
                    dst[ok] = cand[ok]
                    changed = True
            if not changed:
                break
        return t


def blocked_mask(grid: Grid, burning: set[int], closures: list[tuple[float, float, float, float]]) -> np.ndarray:
    m = np.zeros((grid.rows, grid.cols), dtype=bool)
    for cid in burning:
        m[grid.rc(cid)] = True
    for lat1, lon1, lat2, lon2 in closures:
        for cid in grid.segment_cells(lat1, lon1, lat2, lon2):
            m[grid.rc(cid)] = True
    return m
