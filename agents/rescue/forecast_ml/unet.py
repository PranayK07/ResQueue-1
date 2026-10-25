"""Supervised, time-conditioned U-Net for raw component-perimeter growth.

All eight features are known at issue time. The head learns only valid cells
outside the current footprint; cumulative forecasts retain observed cells.
Weighted BCE logits receive an explicit train-prior correction at inference.
The fixed Dice auxiliary makes that correction approximate, so calibration must
be measured rather than asserted. Multi-horizon cummax is a disclosed projection,
not an ensemble or a precise arrival-time distribution.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F
from torch.utils.data import Dataset

from .provenance import sha256

FEATURE_SCHEMA = "wildfire-supervised-known-perimeters-v2"
FEATURE_NAMES = [
    "current",
    "previous",
    "observed_growth",
    "valid",
    "horizon_hours",
    "previous_gap_hours",
    "meters_per_pixel",
    "history_available",
]
ARCHITECTURE = {"width": 16, "depth": 3, "input_channels": 8, "grid_shape": [128, 128]}


class _DoubleConv(nn.Sequential):
    def __init__(self, inputs, outputs):
        super().__init__(
            nn.Conv2d(inputs, outputs, 3, padding=1),
            nn.ReLU(),
            nn.Conv2d(outputs, outputs, 3, padding=1),
            nn.ReLU(),
        )


class TimeConditionedUNet(nn.Module):
    """Three encoder/downsampling stages and matching spatial skip connections."""

    def __init__(self, width=16, depth=3):
        super().__init__()
        if width != 16 or depth != 3:
            raise ValueError("the predeclared architecture is width16/depth3")
        channels = [width * 2**i for i in range(depth + 1)]
        self.encoders = nn.ModuleList(
            [_DoubleConv(8 if i == 0 else channels[i - 1], channels[i]) for i in range(depth + 1)]
        )
        self.ups = nn.ModuleList(
            [nn.ConvTranspose2d(channels[i + 1], channels[i], 2, stride=2) for i in reversed(range(depth))]
        )
        self.decoders = nn.ModuleList(
            [_DoubleConv(2 * channels[i], channels[i]) for i in reversed(range(depth))]
        )
        self.output = nn.Conv2d(width, 1, 1)

    def forward(self, value):
        if value.ndim != 4 or value.shape[1:] != (8, 128, 128):
            raise ValueError("model input must be [batch,8,128,128]")
        skips = []
        for index, encoder in enumerate(self.encoders):
            value = encoder(value if index == 0 else F.max_pool2d(value, 2))
            skips.append(value)
        for index, (up, decoder) in enumerate(zip(self.ups, self.decoders)):
            value = decoder(torch.cat((up(value), skips[-index - 2]), dim=1))
        return self.output(value)


def all_training_pairs(records):
    result = []
    for record in records:
        times = record.get("acquisition_s", record.get("times_s"))
        for i in record.get("eligible_transition_indices", range(len(times) - 1)):
            horizon = float(times[i + 1] - times[i])
            if not 21600 <= horizon <= 259200:
                continue
            result.append(
                {
                    "sequence_id": record["sequence_id"],
                    "group_id": record["group_id"],
                    "from_index": i,
                    "to_index": i + 1,
                    "horizon_s": horizon,
                }
            )
    return result


def normalization_for_records(records):
    """Pair-weighted physical mean/scale fit exclusively on the train partition."""
    if not records or any(r["split"] != "train" for r in records):
        raise ValueError("normalization requires training records only")
    by_id = {r["sequence_id"]: r for r in records}
    values = []
    for pair in all_training_pairs(records):
        record = by_id[pair["sequence_id"]]
        times, i = record["acquisition_s"], pair["from_index"]
        values.append(
            [
                pair["horizon_s"] / 3600,
                (times[i] - times[i - 1]) / 3600 if i else 0,
                record["grid"]["cell_size_m"],
            ]
        )
    if not values:
        raise ValueError("no eligible training observation pairs")
    raw = np.asarray(values, dtype=float)
    return {
        "mean": raw.mean(axis=0).tolist(),
        "scale": np.maximum(raw.std(axis=0), [1, 1, 10]).tolist(),
        "fit_groups": sorted({r["group_id"] for r in records}),
        "fit_pairs": len(values),
        "uses_target_pixels": False,
        "clip_standardized": [-10, 10],
    }


def _binary_mask(value, name):
    """Reject missing/nonbinary observations before NumPy can coerce them to True."""
    array = np.asarray(value)
    if array.dtype.kind not in "biuf" or not np.isfinite(array).all() or not np.isin(array, (0, 1)).all():
        raise ValueError(f"{name} mask must contain finite binary values; use explicit validity")
    return array.astype(bool, copy=False)


def known_features(
    current, previous, valid, horizon_s, previous_gap_s, cell_size_m, normalization, *, history_available=None
):
    """Pure training/inference feature builder; there is no target argument."""
    current, previous, valid = (
        _binary_mask(value, name)
        for value, name in ((current, "current"), (previous, "previous"), (valid, "valid"))
    )
    if current.shape != (128, 128) or previous.shape != current.shape or valid.shape != current.shape:
        raise ValueError("features require matching 128x128 known masks")
    raw = np.asarray([horizon_s / 3600, previous_gap_s / 3600, cell_size_m], np.float32)
    means, scales = (np.asarray(normalization[k], np.float32) for k in ("mean", "scale"))
    if (
        means.shape != (3,)
        or scales.shape != (3,)
        or not np.isfinite(means).all()
        or not np.isfinite(scales).all()
        or np.any(scales <= 0)
    ):
        raise ValueError("invalid frozen feature normalization")
    if (
        not np.isfinite(raw).all()
        or not 21600 <= horizon_s <= 259200
        or previous_gap_s < 0
        or cell_size_m <= 0
    ):
        raise ValueError("invalid physical feature units or unsupported horizon")
    available = previous_gap_s > 0 if history_available is None else bool(history_available)
    if not available and previous_gap_s != 0:
        raise ValueError("missing history must have zero preceding gap")
    current, previous = current & valid, previous & valid
    if not available:
        previous = np.zeros_like(previous)
    scalars = np.broadcast_to(np.clip((raw - means) / scales, -10, 10)[:, None, None], (3, 128, 128))
    return np.concatenate(
        (
            np.stack(
                (current, previous, current & ~previous if available else np.zeros_like(current), valid)
            ),
            scalars,
            np.full((1, 128, 128), available),
        )
    ).astype(np.float32)


def cumulative_probability(logits, current, pos_weight=1.0):
    """Analytic weighted-BCE prior correction; approximate with the Dice term."""
    if not np.isfinite(pos_weight) or pos_weight <= 0:
        raise ValueError("positive finite train class weight required")
    return torch.where(
        current.bool(), torch.ones_like(logits), torch.sigmoid(logits - float(np.log(pos_weight)))
    )


def segmentation_loss(logits, current, target, valid, dice_weight=0.2, pos_weight=1.0):
    """Weighted BCE and fixed soft Dice only on valid & ~current cells.

    Raw regression labels remain unchanged. Their unavoidable retention error is
    scored in full-footprint evaluation, never charged to this growth head.
    """
    domain = valid.bool() & ~current.bool()
    bce_cells = F.binary_cross_entropy_with_logits(
        logits, target.float(), reduction="none", pos_weight=logits.new_tensor(pos_weight)
    )
    bce = (bce_cells * domain).sum() / domain.sum().clamp_min(1)
    probability = torch.sigmoid(logits) * domain
    truth = target.float() * domain
    intersection = (probability * truth).sum(dim=(1, 2, 3))
    denominator = probability.sum(dim=(1, 2, 3)) + truth.sum(dim=(1, 2, 3))
    per_pair = (2 * intersection + 1e-6) / (denominator + 1e-6)
    nonempty_domain = domain.sum(dim=(1, 2, 3)) > 0
    dice_loss = ((1 - per_pair) * nonempty_domain).sum() / nonempty_domain.sum().clamp_min(1)
    return bce + dice_weight * dice_loss, {
        "bce": bce.detach(),
        "growth_soft_dice": (1 - dice_loss).detach(),
        "growth_domain_cells": domain.sum().detach(),
    }


class ForecastPairDataset(Dataset):
    """Actual consecutive UTC observation pairs, without target interpolation."""

    def __init__(self, records, normalization, *, pairs=None):
        self.records = {r["sequence_id"]: r for r in records}
        self.normalization = normalization
        self.loaded = {}
        self.pairs = all_training_pairs(records) if pairs is None else list(pairs)
        for pair in self.pairs:
            if pair["sequence_id"] not in self.records:
                raise ValueError("pair is outside the supplied partition")

    def __len__(self):
        return len(self.pairs)

    def sequence(self, sid):
        from .data import load_sequence

        if sid not in self.loaded:
            self.loaded[sid] = load_sequence(self.records[sid])
        return self.loaded[sid]

    def __getitem__(self, index):
        pair = self.pairs[index]
        sequence = self.sequence(pair["sequence_id"])
        masks, times = sequence["masks"], sequence["times_s"]
        i, j = pair["from_index"], pair["to_index"]
        horizon = float(times[j] - times[i])
        if j != i + 1 or not 21600 <= horizon <= 259200 or abs(horizon - pair["horizon_s"]) > 1e-6:
            raise ValueError("pair must be consecutive observed 6–72 hour labels")
        previous = masks[i - 1] if i else np.zeros_like(masks[i])
        gap = float(times[i] - times[i - 1]) if i else 0.0
        x = known_features(
            masks[i],
            previous,
            sequence["valid"],
            horizon,
            gap,
            sequence["grid"]["cell_size_m"],
            self.normalization,
            history_available=i > 0,
        )
        return {
            "inputs": torch.from_numpy(x),
            "current": torch.from_numpy(masks[i].copy())[None],
            "target": torch.from_numpy(masks[j].copy())[None].float(),
            "valid": torch.from_numpy(sequence["valid"].copy())[None],
            "pair_index": index,
        }


def training_class_counts(data, max_pos_weight=50.0):
    """Count actual growth-domain labels on train only, before any optimizer."""
    if any(r["split"] != "train" for r in data.records.values()):
        raise ValueError("class weights require training records only")
    positive = negative = 0
    for pair in data.pairs:
        seq = data.sequence(pair["sequence_id"])
        domain = seq["valid"].astype(bool) & ~seq["masks"][pair["from_index"]].astype(bool)
        target = seq["masks"][pair["to_index"]].astype(bool)
        positive += int((target & domain).sum())
        negative += int((~target & domain).sum())
    if positive == 0 or negative == 0:
        raise ValueError("both growth-domain training label classes are required")
    ratio = negative / positive
    return {
        "positive_cells": positive,
        "negative_cells": negative,
        "negative_positive_ratio": ratio,
        "pos_weight": min(float(max_pos_weight), ratio),
        "maximum_pos_weight": float(max_pos_weight),
        "partition": "train",
        "domain": "valid & ~current",
        "pairs": len(data),
    }


def _state_hash(state):
    digest = hashlib.sha256()
    for name, value in sorted(state.items()):
        digest.update(name.encode())
        digest.update(value.detach().cpu().contiguous().numpy().tobytes())
    return digest.hexdigest()


def _parameter_hash(model):
    return _state_hash(model.state_dict())


def _save_native(path, model, optimizer, metadata, **state):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name("." + path.name + ".partial")
    if next(model.parameters()).device.type == "mps":
        torch.mps.synchronize()
    torch.save(
        {
            "model_state": model.state_dict(),
            "optimizer_state": optimizer.state_dict() if optimizer else None,
            "metadata": metadata,
            **state,
        },
        temporary,
    )
    os.replace(temporary, path)


def selected_native_validation(checkpoint):
    native = torch.load(checkpoint, map_location="cpu", weights_only=True)
    metadata = native["metadata"]
    state_hash = _state_hash(native["model_state"])
    if (
        metadata.get("parameter_hash_after") != state_hash
        or metadata.get("model_identity") != state_hash[:16]
    ):
        raise ValueError("selected native parameter identity mismatch")
    score = metadata.get("validation")
    if not isinstance(score, dict) or score.get("complete") is not True:
        raise ValueError("checkpoint lacks complete frozen validation metadata")
    return score


class NativePredictor:
    """Native deterministic supervised head for known observation histories."""

    def __init__(self, checkpoint, metadata=None):
        import time

        self._clock = time.perf_counter
        self.path = Path(checkpoint)
        native = torch.load(self.path, map_location="cpu", weights_only=True)
        internal = native["metadata"]
        external = json.loads(Path(metadata).read_text()) if isinstance(metadata, (str, Path)) else metadata
        if external:
            for key in ("feature_schema", "normalization", "calibration", "architecture", "model_identity"):
                if key in external and external[key] != internal.get(key):
                    raise ValueError(f"external {key} differs from checkpoint")
            if external.get("checkpoint_sha256") and sha256(self.path) != external["checkpoint_sha256"]:
                raise ValueError("checkpoint checksum differs from selected receipt")
        self.metadata = internal
        if internal.get("feature_schema") != FEATURE_SCHEMA or internal.get("architecture") != ARCHITECTURE:
            raise ValueError("checkpoint feature schema or architecture mismatch")
        self.model = TimeConditionedUNet()
        self.model.load_state_dict(native["model_state"])
        if internal.get("model_identity") != _parameter_hash(self.model)[:16]:
            raise ValueError("model identity differs from native parameter state")
        self.model.eval()
        self.normalization = internal["normalization"]
        self.pos_weight = float(internal["calibration"]["pos_weight"])
        self.threshold = float(internal.get("threshold", 0.5))

    def forecast(self, history_masks, acquisition_s, grid_record, horizons_s, valid=None):
        masks, times, horizons = (
            _binary_mask(history_masks, "history"),
            np.asarray(acquisition_s, float),
            np.asarray(horizons_s, float),
        )
        if (
            masks.ndim != 3
            or masks.shape[1:] != (128, 128)
            or len(masks) != len(times)
            or not len(times)
            or not np.isfinite(times).all()
            or np.any(np.diff(times) <= 0)
        ):
            raise ValueError("chronological 128x128 known observation history required")
        if (
            horizons.ndim != 1
            or not len(horizons)
            or not np.isfinite(horizons).all()
            or np.any(np.diff(horizons) <= 0)
            or np.any(horizons < 21600)
            or np.any(horizons > 259200)
        ):
            raise ValueError("forecast horizons must increase within 6–72 hours")
        valid = np.ones((128, 128), bool) if valid is None else _binary_mask(valid, "valid")
        previous = masks[-2] if len(masks) > 1 else np.zeros_like(masks[-1])
        gap = float(times[-1] - times[-2]) if len(times) > 1 else 0.0
        inputs = np.stack(
            [
                known_features(
                    masks[-1],
                    previous,
                    valid,
                    h,
                    gap,
                    grid_record["cell_size_m"],
                    self.normalization,
                    history_available=len(masks) > 1,
                )
                for h in horizons
            ]
        )
        started = self._clock()
        with torch.inference_mode():
            logits = self.model(torch.from_numpy(inputs))
            current = torch.from_numpy(masks[-1].copy())[None, None].expand(len(horizons), 1, 128, 128)
            probability = cumulative_probability(logits, current, self.pos_weight)[:, 0].numpy()
        probability = np.maximum.accumulate(probability, axis=0)
        probability[:, ~valid] = np.nan
        return {
            "probabilities": probability,
            "probability": probability[-1],
            "new_growth_probability": np.where(masks[-1], 0, probability[-1]),
            "issue_s": float(times[-1]),
            "horizons_s": horizons.tolist(),
            "model_version": self.metadata["model_identity"],
            "threshold": self.threshold,
            "policy_elapsed_s": self._clock() - started,
            "ensemble_size": None,
            "quality_flags": [
                "deterministic_supervised_probability_head",
                "analytic_weighted_bce_prior_correction_approximate_with_dice",
                "calibration_requires_empirical_measurement",
                "no_ensemble_arrivals",
                "historical_environment_unavailable",
                "coarse_observation_horizons",
                "multi_horizon_monotonicity_projection_cumulative_max",
            ],
        }

    def predict(self, sequence, pair):
        index = int(pair["from_index"])
        times = sequence["times_s"]
        if (
            "to_index" in pair
            and abs(float(times[pair["to_index"]] - times[index]) - float(pair["horizon_s"])) > 1e-6
        ):
            raise ValueError("pair horizon differs from actual acquisition UTC")
        return self.forecast(
            sequence["masks"][: index + 1],
            times[: index + 1],
            sequence["grid"],
            [pair["horizon_s"]],
            sequence["valid"],
        )


UNetPredictor = NativePredictor
