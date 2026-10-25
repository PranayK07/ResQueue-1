"""Equal-information, unfitted fire forecast baselines.

The physical baseline uses unchanged main-branch fire physics and16 declared
ensemble seeds. It is never fitted to historical targets.
Historical weather is absent: no wind is assumed, never claimed observed.
Growth extrapolation dilates the current footprint by its recently observed
equivalent-radius growth rate, using only the previous/current acquisitions.
"""

from __future__ import annotations

import math
import time
from typing import Any

import numpy as np


def persistence(current: np.ndarray) -> np.ndarray:
    return np.asarray(current, dtype=float).copy()


def growth_extrapolation(
    current: np.ndarray,
    prior: np.ndarray | None,
    horizon_s: float,
    prior_gap_s: float | None,
    cell_size_m: float,
) -> tuple[np.ndarray, dict[str, Any]]:
    from scipy.ndimage import distance_transform_edt

    current = np.asarray(current, dtype=bool)
    if not math.isfinite(horizon_s) or horizon_s <= 0 or cell_size_m <= 0:
        raise ValueError("positive elapsed horizon and meters per cell required")
    if prior is None or prior_gap_s is None or prior_gap_s <= 0:
        return persistence(current), {
            "fallback": "persistence: no previous observed footprint",
            "radial_rate_mps": None,
        }
    prior = np.asarray(prior, dtype=bool)
    if prior.shape != current.shape:
        raise ValueError("previous/current observations must share a fixed geographic domain")
    r_now = math.sqrt(float(current.sum()) / math.pi) * cell_size_m
    r_prior = math.sqrt(float(prior.sum()) / math.pi) * cell_size_m
    rate = max(0.0, (r_now - r_prior) / prior_gap_s)
    radius = rate * horizon_s
    distance = distance_transform_edt(~current, sampling=(cell_size_m, cell_size_m))
    predicted = (current | (distance <= radius)) if current.any() else current
    return predicted.astype(float), {
        "radial_rate_mps": rate,
        "outward_distance_m": radius,
        "assumption": "isotropic equivalent-radius observed growth; no fitted global parameter",
    }


def forecast_baselines(sequence: dict, index: int, horizon_s: float) -> dict[str, dict]:
    from .data import grid_from_record
    from .physical import EVAL_SEEDS, predict_members

    current = np.asarray(sequence["masks"][index], bool)
    prior = np.asarray(sequence["masks"][index - 1], bool) if index else None
    times = np.asarray(sequence.get("times_s", sequence.get("acquisition_s")), dtype=float)
    grid = grid_from_record(sequence["grid"])
    result = {}
    start = time.perf_counter()
    p = persistence(current)
    result["persistence"] = {"probability": p, "latency_ms": 1000 * (time.perf_counter() - start)}
    start = time.perf_counter()
    members = predict_members(grid, current, horizon_s, seeds=EVAL_SEEDS, valid=sequence.get("valid"))
    if isinstance(members, dict):
        members = members["members"]
    p = np.mean(np.asarray(members) <= horizon_s, axis=0)
    result["existing_physical"] = {
        "probability": p,
        "members": members,
        "latency_ms": 1000 * (time.perf_counter() - start),
        "assumption": "main ROS0.08m/s; zero observed wind unavailable; synthetic fuel;16 shared RNG members",
    }
    start = time.perf_counter()
    p, metadata = growth_extrapolation(
        current, prior, horizon_s, float(times[index] - times[index - 1]) if index else None, grid.cell_size_m
    )
    result["growth_extrapolation"] = {
        "probability": p,
        "latency_ms": 1000 * (time.perf_counter() - start),
        **metadata,
    }
    return result
