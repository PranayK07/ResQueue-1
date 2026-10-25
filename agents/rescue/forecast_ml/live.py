"""Opt-in supplementary forecasting; never replaces three-hour route timing.

This adapter consumes only known, timestamped observations. It validates an
export receipt before importing the optional ML runtime. A missing checkpoint,
coarse/unsupported horizon, grid mismatch or failed validation returns a visible
simulation fallback. Checkpoint existence alone cannot activate learned risk.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from .provenance import sha256
from .risk import ForecastProduct

FEATURE_SCHEMA = "wildfire-supervised-known-perimeters-v2"


def dispatch_policy_name(configured: str, forecast_backend: str) -> str:
    """Learned fire configuration keeps the existing Lookahead dispatcher."""
    return "lookahead" if forecast_backend == "learned" else configured


@dataclass
class ForecastRequest:
    """Known historical masks (south-up), absolute UTC seconds, requested offsets."""

    history_masks: np.ndarray
    acquisition_s: list[float]
    grid_record: dict
    grid: Any
    valid: np.ndarray
    issue_s: float
    horizons_s: list[float]
    quality_flags: tuple[str, ...] = ()

    def validate(self):
        masks = np.asarray(self.history_masks)
        if masks.ndim != 3 or masks.shape[0] != len(self.acquisition_s) or not len(masks):
            raise ValueError("known observation history/timestamps have incompatible shapes")
        if masks.shape[1:] != (self.grid.rows, self.grid.cols):
            raise ValueError("history does not match geographic grid")
        valid = np.asarray(self.valid)
        if valid.shape != masks.shape[1:]:
            raise ValueError("valid mask does not match geographic grid")
        for name, values in (("history", masks), ("valid", valid)):
            if (
                values.dtype.kind not in "biuf"
                or not np.isfinite(values).all()
                or not np.isin(values, (0, 1)).all()
            ):
                raise ValueError(f"{name} mask must contain finite binary values; use explicit validity")
        if not all(math.isfinite(t) for t in self.acquisition_s + [self.issue_s]):
            raise ValueError("timestamps must be finite UTC seconds")
        if any(a >= b for a, b in zip(self.acquisition_s, self.acquisition_s[1:])):
            raise ValueError("observation acquisition times must increase")
        if self.acquisition_s[-1] > self.issue_s:
            raise ValueError("future observation cannot be a feature")
        if self.issue_s != self.acquisition_s[-1]:
            raise ValueError(
                "this checkpoint requires issue at last acquisition; delivery latency is unknown"
            )
        if not self.horizons_s or any(not math.isfinite(h) or h <= 0 for h in self.horizons_s):
            raise ValueError("positive finite requested horizons required")
        if any(a >= b for a, b in zip(self.horizons_s, self.horizons_s[1:])):
            raise ValueError("requested horizons must increase")
        from .geo_contract import validate_projected_grid

        validate_projected_grid(self.grid_record, self.grid)


@dataclass
class BackendResult:
    requested: str
    active: str
    reason: str
    product: ForecastProduct | None = None


class LearnedForecastBackend:
    """Fail-closed optional historical risk backend; default is simulation.

    Export metadata is a separate reviewable artifact. It binds the exact
    checkpoint hash, features, split, supported horizons and measured gates.
    """

    def __init__(self, backend="simulation", checkpoint=None, metadata=None):
        self.backend = backend
        self.checkpoint = Path(checkpoint) if checkpoint else None
        self.metadata_path = Path(metadata) if metadata else None

    def forecast(self, request: ForecastRequest | None) -> BackendResult:
        def fallback(reason):
            return BackendResult(self.backend, "simulation", reason)

        if self.backend == "simulation":
            return fallback("configured simulation; short-horizon physical timing remains active")
        if self.backend != "learned":
            return fallback("unsupported backend; hybrid has not been defined or validated")
        if self.checkpoint is None or not self.checkpoint.is_file():
            return fallback("learned checkpoint absent")
        if self.metadata_path is None or not self.metadata_path.is_file():
            return fallback("versioned validation/export metadata absent")
        try:
            metadata = json.loads(self.metadata_path.read_text())
            if not isinstance(metadata, dict):
                return fallback("export metadata must be a JSON object")
            gate = metadata.get("deployment")
            if not isinstance(gate, dict):
                return fallback("deployment metadata must be a JSON object")
            if gate.get("feature_schema") != FEATURE_SCHEMA or not gate.get("trained"):
                return fallback("untrained checkpoint or incompatible feature schema")
            if sha256(self.checkpoint) != gate.get("checkpoint_sha256"):
                return fallback("checkpoint checksum differs from validated export")
            if not gate.get("validation_passed") or not gate.get("inference_checked"):
                return fallback(
                    "validation or measured inference gate failed: "
                    + "; ".join(gate.get("fallback_reasons", []))
                )
            if gate.get("model_family") != "time_conditioned_unet":
                return fallback("unsupported learned forecasting model family")
            bounds = gate.get("supported_horizon_s")
            if (
                not isinstance(bounds, (list, tuple))
                or len(bounds) != 2
                or any(
                    isinstance(h, bool) or not isinstance(h, (int, float)) or not math.isfinite(h) or h <= 0
                    for h in bounds
                )
                or bounds[0] >= bounds[1]
            ):
                return fallback("supported horizon bounds must be two finite positive increasing seconds")
            if request is None:
                return fallback("timestamped historical observation history unavailable in live simulation")
            request.validate()
            if list(request.history_masks.shape[1:]) != gate.get("grid_shape"):
                return fallback("live grid shape is incompatible with trained checkpoint")
            if any(h < bounds[0] or h > bounds[1] for h in request.horizons_s):
                return fallback("requested horizon is outside validated historical observation gaps")
            if request.grid_record.get("crs") is None:
                return fallback("projected geographic grid CRS missing")
            from .unet import NativePredictor

            predictor = NativePredictor(self.checkpoint, metadata)
            if not predictor.metadata.get("trained") or not predictor.metadata.get("actual_parameter_update"):
                return fallback("native checkpoint lacks demonstrated supervised training")
            result = predictor.forecast(
                request.history_masks,
                request.acquisition_s,
                request.grid_record,
                request.horizons_s,
                valid=request.valid,
            )
            product = ForecastProduct(
                request.grid,
                request.issue_s,
                request.horizons_s,
                result["probabilities"],
                request.valid,
                request.history_masks[-1],
                model_id=gate["model_id"],
                source="learned",
                quality_flags=[
                    *request.quality_flags,
                    "historical acquisition used as idealized information availability",
                    "no historical weather; not validated minute-level dispatch timing",
                ],
            )
            return BackendResult(self.backend, "learned", "supplementary historical risk only", product)
        except (OSError, ValueError, KeyError, TypeError, RuntimeError, ImportError) as exc:
            return fallback(f"learned compatibility/inference rejected: {type(exc).__name__}: {exc}")
