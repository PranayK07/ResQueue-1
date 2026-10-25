"""Geographic exposure and fictional resident impact, independent of dispatch.

Arrays are south-up/eastward; time is seconds relative to a declared issue.
Physical products use a 16-member modeled ensemble; supervised products carry
direct probability maps without invented ensemble members. Historical footprints
provide interval labels, never exact minute-of-arrival or mortality labels.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import math
from typing import Any

import numpy as np

from ..core.slack import extract_time_s

RISK_SCHEMA = "wildfire-risk-v1"
RESIDENT_SEED = 46079


@dataclass
class ForecastProduct:
    grid: Any
    issue_s: float
    horizons_s: list[float]
    probabilities: np.ndarray
    valid: np.ndarray
    observed: np.ndarray
    model_id: str
    source: str
    observation_age_s: float = 0.0
    quality_flags: list[str] = field(default_factory=list)
    schema_version: str = RISK_SCHEMA

    def __post_init__(self):
        self.probabilities = np.asarray(self.probabilities, dtype=float)
        self.valid = np.asarray(self.valid, dtype=bool)
        self.observed = np.asarray(self.observed, dtype=bool)
        shape = (len(self.horizons_s), self.grid.rows, self.grid.cols)
        if self.schema_version != RISK_SCHEMA or self.probabilities.shape != shape:
            raise ValueError("incompatible forecast probability schema/shape")
        if self.valid.shape != shape[1:] or self.observed.shape != shape[1:]:
            raise ValueError("valid/observed masks must match geographic grid")
        if not self.horizons_s or any(not math.isfinite(h) or h <= 0 for h in self.horizons_s):
            raise ValueError("forecast horizons must be finite positive seconds")
        if any(a >= b for a, b in zip(self.horizons_s, self.horizons_s[1:])):
            raise ValueError("forecast horizons must increase strictly")
        if (
            not math.isfinite(self.issue_s)
            or not math.isfinite(self.observation_age_s)
            or self.observation_age_s < 0
        ):
            raise ValueError("issue and observation age must use finite seconds")
        p = self.probabilities[:, self.valid]
        if not np.isfinite(p).all() or np.any((p < 0) | (p > 1)):
            raise ValueError("known probabilities must lie in [0,1]")
        if np.any(np.diff(p, axis=0) < -1e-7):
            raise ValueError("cumulative horizon probabilities must not decrease")

    def window(self, cell_id: int, threshold=0.1):
        """CDF-threshold bracket, not an interpolated p10 arrival estimate."""
        if not 0 <= cell_id < self.grid.size or not 0 < threshold < 1:
            raise ValueError("cell/threshold outside domain")
        rc = self.grid.rc(cell_id)
        if not self.valid[rc]:
            return {"status": "unknown", "lower_s": None, "upper_s": None}
        if self.observed[rc]:
            return {
                "status": "already_observed",
                "lower_s": None,
                "upper_s": self.issue_s - self.observation_age_s,
            }
        lower = self.issue_s - self.observation_age_s
        for horizon, probability in zip(self.horizons_s, self.probabilities):
            upper = self.issue_s + horizon
            if probability[rc] >= threshold:
                return {"status": "interval", "lower_s": lower, "upper_s": upper}
            lower = upper
        return {"status": "right_censored", "lower_s": lower, "upper_s": None}


def product_from_members(
    grid,
    arrivals,
    current,
    valid,
    horizons_s,
    *,
    issue_s=0.0,
    model_id="",
    source="learned",
    observation_age_s=0.0,
    quality_flags=(),
):
    arrivals = np.asarray(arrivals, dtype=float)
    if arrivals.shape != (16, grid.rows, grid.cols) or np.isnan(arrivals).any():
        raise ValueError("primary forecast requires16 known member arrival fields")
    probability = np.stack([(arrivals <= h).mean(axis=0) for h in horizons_s])
    return ForecastProduct(
        grid,
        issue_s,
        list(horizons_s),
        probability,
        valid,
        current,
        model_id,
        source,
        observation_age_s,
        list(quality_flags),
    )


def synthetic_residents(grid, valid, *, pair_id, count=24, observed=None):
    """Fictional independent demand: uniform valid cells, no target conditioning."""
    seed = (RESIDENT_SEED + int.from_bytes(hashlib.sha256(str(pair_id).encode()).digest()[:4], "big")) % 2**32
    rng = np.random.default_rng(seed)
    candidates = np.flatnonzero(np.asarray(valid, bool))
    if observed is not None:
        candidates = candidates[~np.asarray(observed, bool).ravel()[candidates]]
    if not len(candidates):
        return []
    cells = rng.choice(candidates, size=min(count, len(candidates)), replace=False)
    result = []
    for rid, cell in enumerate(cells, 1):
        people = int(rng.integers(1, 5))
        needs = str(rng.choice(["", "mobility", "medical"], p=[0.6, 0.25, 0.15]))
        lat, lon = grid.center(int(cell))
        result.append(
            {
                "request_id": rid,
                "cell_id": int(cell),
                "lat": lat,
                "lon": lon,
                "headcount": people,
                "needs": needs,
                "extract_s": extract_time_s(people, needs),
                "compatible_vehicle": "ambulance" if needs == "medical" else "rescue",
                "synthetic": True,
                "request_s": 0.0,
            }
        )
    return result


def assess_residents(
    product: ForecastProduct, residents, *, travel_s=None, waits_s=None, margin_s=300.0, now_s=None
):
    """Expose probability, timing intervals and assistance-adjusted slack separately.

    Missing routes yield a review state, never an invented ground-unreachable
    judgment. The existing short-horizon danger agent remains the dispatch input.
    """
    output = []
    now_s = product.issue_s if now_s is None else float(now_s)
    if not math.isfinite(now_s) or now_s < product.issue_s:
        raise ValueError("assessment clock precedes forecast issue; commander review required")
    for resident in residents:
        cell = product.grid.locate(resident["lat"], resident["lon"])
        if cell is None or cell != resident["cell_id"]:
            raise ValueError("resident geographic coordinates do not round-trip to forecast cell")
        rc = product.grid.rc(cell)
        window = product.window(cell)
        drive = (travel_s or {}).get(resident["request_id"])
        wait = (waits_s or {}).get(resident["request_id"], 0.0)
        service = float(resident["extract_s"])
        usable_route = (
            drive is not None and math.isfinite(drive) and drive >= 0 and math.isfinite(wait) and wait >= 0
        )
        duration = wait + drive + service + margin_s if usable_route else None
        slack_lower = (
            window["lower_s"] - now_s - duration
            if duration is not None and window["lower_s"] is not None
            else None
        )
        slack_upper = (
            window["upper_s"] - now_s - duration
            if duration is not None and window["upper_s"] is not None
            else None
        )
        expired = now_s >= product.issue_s + product.horizons_s[-1]
        review = (
            expired
            or not usable_route
            or window["status"] != "interval"
            or (slack_lower is not None and slack_upper is not None and slack_lower <= 0 <= slack_upper)
        )
        probabilities = [float(p[rc]) if product.valid[rc] else None for p in product.probabilities]
        probability_text = f"{100 * probabilities[-1]:.1f}%" if probabilities[-1] is not None else "unknown"
        if window["status"] == "interval":
            window_text = (
                f"{(window['lower_s'] - product.issue_s) / 3600:.1f} to "
                f"{(window['upper_s'] - product.issue_s) / 3600:.1f} hours after forecast issue"
            )
        elif window["status"] == "right_censored":
            window_text = "no modeled threshold crossing through the horizon; later timing unknown"
        elif window["status"] == "already_observed":
            window_text = "already observed affected; exact arrival unknown"
        else:
            window_text = "unknown"
        output.append(
            {
                **resident,
                "issue_s": product.issue_s,
                "horizons_s": product.horizons_s,
                "probabilities": probabilities,
                "arrival_window": window,
                "slack_lower_s": slack_lower,
                "slack_upper_s": slack_upper,
                "uncertainty_status": "forecast_expired"
                if expired
                else "commander_review"
                if review
                else "modeled_interval",
                "model_id": product.model_id,
                "source": product.source,
                "quality_flags": product.quality_flags,
                "reason": (
                    f"Modeled affected-area probability {probability_text} by {product.horizons_s[-1] / 3600:.1f}h; "
                    f"threat bracket: {window_text}; "
                    f"assistance {service / 60:.1f}min, margin {margin_s / 60:.1f}min. "
                    + (
                        "Forecast expired; commander review."
                        if expired
                        else "Timing/route needs commander review."
                        if review
                        else "Modeled urgency; no safety assurance."
                    )
                ),
            }
        )
    # This ordering concerns exposure at the requested horizon, not dispatch order
    # or a falsely precise ordering of overlapping arrival intervals.
    ordered = sorted(
        output,
        key=lambda r: (
            -(r["probabilities"][-1] if r["probabilities"][-1] is not None else -1),
            r["request_id"],
        ),
    )
    for rank, row in enumerate(ordered, 1):
        row["exposure_rank"] = rank
        row["arrival_order_is_partial"] = True
    return ordered


def resident_ranking_metrics(rows, target, *, k=5):
    """Binary-horizon threat recall/precision, not mortality or exact arrival."""
    if not rows:
        return {
            "topk_recall": None,
            "topk_precision": None,
            "missed_threatened": None,
            "reason": "no admitted fictional residents",
        }
    k = min(k, len(rows))
    actual = {r["request_id"] for r in rows if bool(target.flat[r["cell_id"]])}
    selected = {r["request_id"] for r in rows[:k]}
    tp = len(actual & selected)
    return {
        "topk_recall": tp / len(actual) if actual else None,
        "topk_precision": tp / k if k else None,
        "missed_threatened": len(actual - selected),
        "topk": k,
        "threatened": len(actual),
        "known_order_agreement": None,
        "order_reason": "single future footprint cannot establish nonoverlapping arrival intervals",
    }
