"""Portable, checksum-bound recorded incident input. No training or future features.

The manifest's scenario must match sim_clock.scenario. T+0 is the first
acquisition's UTC timestamp; only observations acquired by the replay clock
can reach forecasting. The routing grid is deliberately separate from UTM.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path

import numpy as np

from ..core.geo import Grid
from .geo_contract import validate_projected_grid
from .live import ForecastRequest
from .provenance import sha256


@dataclass
class RecordedIncident:
    scenario: str
    source_id: str
    grid_record: dict
    routing_grid: Grid
    masks: np.ndarray
    valid: np.ndarray
    times_s: np.ndarray
    arrays_sha256: str = ""

    @classmethod
    def load(cls, path):
        path = Path(path).resolve()
        manifest = json.loads(path.read_text())
        if manifest.get("schema_version") != "recorded-fire-v1":
            raise ValueError("expected recorded-fire-v1 manifest")
        arrays = path.parent / manifest["arrays"]
        if sha256(arrays) != manifest["arrays_sha256"]:
            raise ValueError("recorded observation checksum mismatch")
        with np.load(arrays, allow_pickle=False) as data:
            masks, valid, times = (data[k].copy() for k in ("masks", "valid", "times_s"))
        if times.ndim != 1 or len(times) == 0:
            raise ValueError("recorded source needs acquisition timestamps")
        grid = validate_projected_grid(manifest["grid"])
        # Validate the entire source before any observation can be published.
        req = ForecastRequest(
            masks, times.tolist(), manifest["grid"], grid, valid, float(times[-1]), [21600.0]
        )
        req.validate()
        routing = Grid.from_row(manifest["routing_grid"])
        if not routing.valid or not manifest["scenario"] or not manifest["source_id"]:
            raise ValueError("recorded source/scenario/routing grid missing")
        if any(routing.locate(*grid.center(int(cid))) is None for cid in np.flatnonzero(valid)):
            raise ValueError("recorded valid domain falls outside routing grid; regenerate bundle")
        return cls(
            manifest["scenario"],
            manifest["source_id"],
            manifest["grid"],
            routing,
            masks.astype(bool),
            valid.astype(bool),
            times.astype(float),
            manifest["arrays_sha256"],
        )

    @property
    def start_utc_s(self):
        return float(self.times_s[0])

    def matches_grid(self, grid):
        """Allow JSON float roundoff across Python/V8; never accept a different cell geometry."""
        expected = self.routing_grid
        return (
            grid.rows == expected.rows
            and grid.cols == expected.cols
            and math.isclose(grid.origin_lat, expected.origin_lat, rel_tol=0, abs_tol=1e-10)
            and math.isclose(grid.origin_lon, expected.origin_lon, rel_tol=0, abs_tol=1e-10)
            and math.isclose(grid.cell_size_m, expected.cell_size_m, rel_tol=0, abs_tol=1e-9)
        )

    def request(self, sim_s, horizons_s):
        if not math.isfinite(sim_s) or sim_s < 0:
            raise ValueError("recorded replay requires finite nonnegative sim seconds")
        count = int(np.searchsorted(self.times_s, self.start_utc_s + sim_s, side="right"))
        if not count:
            raise ValueError("no observation acquired yet")
        # Native preprocessing needs current + previous only. No future mask is exposed.
        start = max(0, count - 2)
        grid = validate_projected_grid(self.grid_record)
        req = ForecastRequest(
            self.masks[start:count],
            self.times_s[start:count].tolist(),
            self.grid_record,
            grid,
            self.valid,
            float(self.times_s[count - 1]),
            list(horizons_s),
            ("recorded acquisition equals idealized release time",),
        )
        token = hashlib.sha256(f"{self.source_id}:{self.arrays_sha256}:{req.issue_s}".encode()).hexdigest()[
            :24
        ]
        return req, token

    def fire_cells(self, sim_s):
        req, _ = self.request(sim_s, [21600.0])
        # Observation centers are explicitly located on the application's routing grid.
        cells = {
            self.routing_grid.locate(*req.grid.center(int(cid)))
            for cid in np.flatnonzero(req.history_masks[-1] & self.valid)
        }
        if None in cells:
            raise ValueError("recorded observation falls outside routing domain; regenerate bundle")
        return [
            {"cell_id": cid, "ignited_s": req.issue_s - self.start_utc_s, "intensity": 1.0}
            for cid in sorted(cells)
        ]
