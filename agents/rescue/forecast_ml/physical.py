"""Unfitted main-branch fire physics, accelerated by a SciPy shortest-path solver.

Inputs are observed south-up masks, projected meters per cell and relative
forecast seconds. Outputs are16 seeded arrival fields. Fuel, wind uncertainty,
ROS and stencil costs match the existing core. No learned controls are applied.
"""

from __future__ import annotations

from functools import lru_cache
import math

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

from ..core.fire import FUEL_SEED, FireParams, FuelMap, Wind, _OFFSETS

EVAL_SEEDS = tuple(range(17001, 17017))
PHYSICAL_VERSION = "main-core-edge-dijkstra-v1"


@lru_cache(maxsize=32)
def _topology(rows, cols):
    sources, targets, kinds = [], [], []
    ids = np.arange(rows * cols).reshape(rows, cols)
    for index, (dr, dc) in enumerate(_OFFSETS):
        if abs(dr) >= rows or abs(dc) >= cols:
            continue
        sr, sc = slice(max(0, -dr), rows - max(0, dr)), slice(max(0, -dc), cols - max(0, dc))
        tr, tc = slice(max(0, dr), rows - max(0, -dr)), slice(max(0, dc), cols - max(0, -dc))
        a, b = ids[sr, sc].ravel(), ids[tr, tc].ravel()
        sources.append(a)
        targets.append(b)
        kinds.append(np.full(len(a), index, np.int16))
    if not sources:
        return np.array([], np.int32), np.array([], np.int16), np.zeros(rows * cols + 1, np.int32)
    source, target, kind = np.concatenate(sources), np.concatenate(targets), np.concatenate(kinds)
    order = np.lexsort((target, source))
    source, target, kind = source[order], target[order], kind[order]
    pointers = np.r_[0, np.cumsum(np.bincount(source, minlength=rows * cols))].astype(np.int32)
    return target.astype(np.int32), kind, pointers


def predict_members(
    grid, current_mask, horizon_s, *, seeds=EVAL_SEEDS, wind=None, valid=None, nominal_first=True
):
    """Relative arrival seconds [members,rows,cols]; infinity means censored.

    The first member is nominal; the remaining fixed seeds reproduce main's
    lognormal wind/ROS and15-degree wind-direction uncertainty. Historical
    weather is unavailable, so the default wind is explicitly0m/s. Synthetic
    main fuel seed1 is fixed, never claimed observed environmental data.
    """
    if not math.isfinite(horizon_s) or horizon_s <= 0:
        raise ValueError("positive finite elapsed horizon required")
    shape = (grid.rows, grid.cols)
    current = np.asarray(current_mask, bool)
    valid = np.ones(shape, bool) if valid is None else np.asarray(valid, bool)
    if current.shape != shape or valid.shape != shape:
        raise ValueError("mask/grid shape mismatch")
    indices = np.flatnonzero((current & valid).ravel()).astype(np.int32)
    output = np.full((len(seeds), *shape), np.inf)
    if not len(indices):
        return output
    targets, kinds, pointers = _topology(grid.rows, grid.cols)
    fuel = FuelMap.uniform(grid, seed=FUEL_SEED).factor.ravel()
    params, wind = FireParams(), wind or Wind(0.0, 0.0)
    distance = np.array([grid.cell_size_m * math.hypot(dr, dc) for dr, dc in _OFFSETS])
    heading = np.array([math.atan2(dr, dc) for dr, dc in _OFFSETS])
    for member, seed in enumerate(seeds):
        rng = np.random.default_rng(int(seed))
        speed = wind.speed_mps * math.exp(float(rng.normal(0, 0.2)))
        to_rad = wind.to_rad + math.radians(float(rng.normal(0, 15)))
        ros = params.base_ros_mps * math.exp(float(rng.normal(0, 0.15)))
        if member == 0 and nominal_first:
            speed, to_rad, ros = wind.speed_mps, wind.to_rad, params.base_ros_mps
        wind_scale = np.maximum(
            np.exp(params.wind_coeff * speed * np.cos(heading - to_rad)), params.min_factor
        )
        costs = distance / (ros * wind_scale)
        edges = np.where(valid.ravel()[targets], costs[kinds] / fuel[targets], np.inf)
        graph = csr_matrix((edges, targets, pointers), shape=(grid.size, grid.size), copy=False)
        output[member] = dijkstra(
            graph, directed=True, indices=indices, min_only=True, limit=horizon_s
        ).reshape(shape)
    return output


def probability_from_members(members, horizon_s):
    return np.mean(np.asarray(members) <= float(horizon_s), axis=0).astype(np.float32)
