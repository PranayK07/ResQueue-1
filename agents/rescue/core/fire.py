"""Simplified wind-driven fire spread as a minimum-travel-time model.

Fire arrival time at each cell = shortest path from the burning cells, where
crossing from one cell to a neighbour costs distance / spread_rate(direction).
Spread rate is elliptical in the wind: fast downwind, slow upwind.

This is deliberately simple (it is NOT a validated fire-behaviour model) but
it has the properties the rescue queue depends on: wind shifts rotate the
front, fuel breaks slow it, and uncertainty can be expressed as an ensemble.

All solvers are vectorised numpy relaxations over (members, rows, cols), so a
16-member ensemble on a 100x100 grid runs in tens of milliseconds — fast
enough to recompute live while a judge drags the wind slider.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .geo import Grid

INF = np.inf

# Fire and forecast agents must build the identical fuel field from the grid.
FUEL_SEED = 1

# 16-neighbourhood (8 + knight moves) keeps the fire front from looking square.
_OFFSETS: list[tuple[int, int]] = [
    (1, 0), (-1, 0), (0, 1), (0, -1),
    (1, 1), (1, -1), (-1, 1), (-1, -1),
    (2, 1), (2, -1), (-2, 1), (-2, -1),
    (1, 2), (1, -2), (-1, 2), (-1, -2),
]


@dataclass(frozen=True)
class FireParams:
    base_ros_mps: float = 0.08  # no-wind spread rate on unit fuel
    wind_coeff: float = 0.20  # rate multiplier = exp(wind_coeff * U * cos(angle off downwind))
    min_factor: float = 0.08  # floor on the upwind/backing rate multiplier


@dataclass
class FuelMap:
    """Per-cell spread multiplier; 0 = unburnable (water, rock, wide road)."""

    factor: np.ndarray  # (rows, cols) float

    @classmethod
    def uniform(cls, grid: Grid, seed: int = 0, patchiness: float = 0.35) -> "FuelMap":
        """Smooth random fuel field so fronts are not perfect ellipses."""
        rng = np.random.default_rng(seed)
        noise = rng.normal(0, 1, (grid.rows, grid.cols))
        for _ in range(4):  # cheap blur
            noise = (noise + np.roll(noise, 1, 0) + np.roll(noise, -1, 0) + np.roll(noise, 1, 1) + np.roll(noise, -1, 1)) / 5
        noise /= noise.std() + 1e-9
        return cls(np.clip(1.0 + patchiness * noise, 0.3, 2.0))


@dataclass
class Wind:
    speed_mps: float
    from_deg: float  # meteorological convention

    @property
    def to_rad(self) -> float:
        """Direction the wind blows TOWARD, as a math angle (0 = east, CCW)."""
        to_compass = (self.from_deg + 180.0) % 360.0
        return math.radians(90.0 - to_compass)


@dataclass
class Ensemble:
    members: int = 16
    dir_sigma_deg: float = 15.0
    speed_sigma: float = 0.20  # lognormal
    ros_sigma: float = 0.15
    seed: int = 7
    rng: np.random.Generator = field(init=False)

    def __post_init__(self) -> None:
        self.rng = np.random.default_rng(self.seed)


def _edge_costs(grid: Grid, fuel: FuelMap, speeds: np.ndarray, to_rads: np.ndarray, ros: np.ndarray, p: FireParams) -> list[np.ndarray]:
    """Per-offset (members, rows, cols) seconds to spread INTO each cell."""
    costs = []
    for dr, dc in _OFFSETS:
        dist = grid.cell_size_m * math.hypot(dr, dc)
        heading = math.atan2(dr, dc)  # rows go north, cols go east
        cos = np.cos(heading - to_rads)  # (M,)
        mult = np.maximum(np.exp(p.wind_coeff * speeds * cos), p.min_factor)
        rate = (ros * mult)[:, None, None] * fuel.factor[None, :, :]  # (M,R,C)
        with np.errstate(divide="ignore"):
            costs.append(np.where(rate > 0, dist / rate, INF))
    return costs


def _relax(arrival: np.ndarray, costs: list[np.ndarray], t_max: float, max_iters: int = 400) -> np.ndarray:
    """Bellman-Ford style min-plus relaxation until stable."""
    R, C = arrival.shape[1:]
    for _ in range(max_iters):
        changed = False
        for (dr, dc), cost in zip(_OFFSETS, costs):
            # source slice -> destination slice for this offset
            sr = slice(max(0, -dr), R - max(0, dr))
            sc = slice(max(0, -dc), C - max(0, dc))
            tr = slice(max(0, dr), R - max(0, -dr))
            tc = slice(max(0, dc), C - max(0, -dc))
            cand = arrival[:, sr, sc] + cost[:, tr, tc]
            dst = arrival[:, tr, tc]
            better = cand < dst
            if better.any():
                np.minimum(dst, cand, out=dst)
                changed = True
        if not changed:
            break
    arrival[arrival > t_max] = INF
    return arrival


def arrival_times(
    grid: Grid,
    fuel: FuelMap,
    sources: dict[int, float],
    wind: Wind,
    *,
    t_max: float,
    params: FireParams = FireParams(),
) -> np.ndarray:
    """Deterministic arrival time (sim seconds) for every cell, (rows, cols)."""
    arr = np.full((1, grid.rows, grid.cols), INF)
    for cid, t0 in sources.items():
        r, c = grid.rc(cid)
        arr[0, r, c] = min(arr[0, r, c], t0)
    costs = _edge_costs(grid, fuel, np.array([wind.speed_mps]), np.array([wind.to_rad]), np.array([params.base_ros_mps]), params)
    return _relax(arr, costs, t_max)[0]


def ensemble_arrival(
    grid: Grid,
    fuel: FuelMap,
    sources: dict[int, float],
    wind: Wind,
    *,
    now_s: float,
    horizon_s: float,
    ens: Ensemble,
    params: FireParams = FireParams(),
) -> tuple[np.ndarray, np.ndarray]:
    """(p10, p50) arrival-time grids from a perturbed-wind ensemble.

    p10 = the time by which 10% of plausible futures have the fire here —
    the conservative number the danger agent plans against. Arrivals earlier
    than `now_s` are clamped to now (the model thinks it should already be
    burning, so treat it as imminent)."""
    m = ens.members
    rng = ens.rng
    speeds = wind.speed_mps * np.exp(rng.normal(0, ens.speed_sigma, m))
    to_rads = wind.to_rad + np.radians(rng.normal(0, ens.dir_sigma_deg, m))
    ros = params.base_ros_mps * np.exp(rng.normal(0, ens.ros_sigma, m))
    speeds[0], to_rads[0], ros[0] = wind.speed_mps, wind.to_rad, params.base_ros_mps  # keep the nominal member

    arr = np.full((m, grid.rows, grid.cols), INF)
    for cid, t0 in sources.items():
        r, c = grid.rc(cid)
        arr[:, r, c] = np.minimum(arr[:, r, c], t0)
    costs = _edge_costs(grid, fuel, speeds, to_rads, ros, params)
    arr = _relax(arr, costs, now_s + horizon_s)
    arr = np.where(np.isfinite(arr), np.maximum(arr, now_s), INF)
    arr.sort(axis=0)
    p10 = arr[max(0, int(math.floor(0.10 * (m - 1))))]
    p50 = arr[int(round(0.50 * (m - 1)))]
    return p10, p50


def frontier(grid: Grid, burning: dict[int, float]) -> dict[int, float]:
    """Burning cells that still have at least one unburnt 8-neighbour."""
    out = {}
    for cid, t in burning.items():
        r, c = grid.rc(cid)
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                rr, cc = r + dr, c + dc
                if (dr or dc) and 0 <= rr < grid.rows and 0 <= cc < grid.cols and grid.cell_id(rr, cc) not in burning:
                    out[cid] = t
                    break
            else:
                continue
            break
    return out


def truth_arrival(
    grid: Grid,
    fuel: FuelMap,
    burning: dict[int, float],
    wind: Wind,
    *,
    now_s: float,
    t_max: float,
    params: FireParams = FireParams(),
) -> np.ndarray:
    """Ground-truth arrival field for the simulator under the wind in force
    from `now_s` on. The simulator recomputes this only when the wind (or the
    observed perimeter) changes, then ignites cells as sim time passes them.

    The fire front (burning cells with unburnt neighbours) restarts from
    `now_s` under the new wind. Replaying the fire's whole history under the
    new wind would instead ignite everything it "should" already have
    reached in one instant — a wind shift must change where the fire goes
    next, not rewrite where it has been."""
    front = {cid: max(t, now_s) for cid, t in frontier(grid, burning).items()}
    arr = arrival_times(grid, fuel, front, wind, t_max=t_max, params=params)
    for cid, t in burning.items():
        arr[grid.rc(cid)] = t
    return arr


def ignite_due(grid: Grid, truth: np.ndarray, burning: dict[int, float], now_s: float) -> dict[int, float]:
    """Cells whose ground-truth arrival has passed and are not yet burning."""
    new: dict[int, float] = {}
    rows, cols = np.nonzero(truth <= now_s)
    for r, c in zip(rows.tolist(), cols.tolist()):
        cid = r * grid.cols + c
        if cid not in burning:
            new[cid] = float(truth[r, c])
    return new
