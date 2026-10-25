"""Serving grid validation, independent of rasterization and trained features."""

from __future__ import annotations

import math


def validate_projected_grid(record, expected=None):
    """Require finite local UTM meters, south-west origin and identical lookup.

    Degree-valued CRS axes cannot be interpreted as meters per cell. Unsupported
    projections are rejected instead of silently resampling an incoming risk map.
    This does not change the existing frozen NIROPS UTM arrays.
    """
    from pyproj import CRS
    from .spatial import grid_from_record, transformer

    crs = CRS.from_user_input(record["crs"])
    if not crs.is_projected or crs.utm_zone is None or len(crs.axis_info) != 2:
        raise ValueError("forecast grid requires a projected local UTM CRS")
    if any(
        not math.isclose(axis.unit_conversion_factor, 1.0, rel_tol=0, abs_tol=1e-12) for axis in crs.axis_info
    ):
        raise ValueError("forecast grid axes must use meters")
    numeric = ("origin_lat", "origin_lon", "x_min", "y_min", "cell_size_m")
    if any(not math.isfinite(float(record[k])) for k in numeric) or record["cell_size_m"] <= 0:
        raise ValueError("forecast grid origin/resolution must be finite meters")
    if any(
        not isinstance(record[k], int) or isinstance(record[k], bool) or record[k] <= 0
        for k in ("rows", "cols")
    ):
        raise ValueError("forecast grid dimensions must be positive integers")
    grid = grid_from_record(record)
    lon, lat = transformer(crs.to_string(), "EPSG:4326").transform(grid.x_min, grid.y_min)
    if not all(math.isfinite(v) for v in (lon, lat)) or not (
        math.isclose(lon, grid.origin_lon, abs_tol=1e-8, rel_tol=0)
        and math.isclose(lat, grid.origin_lat, abs_tol=1e-8, rel_tol=0)
    ):
        raise ValueError("forecast projected and geographic origins disagree")
    if expected is not None and grid != expected:
        raise ValueError("model grid record differs from resident geographic grid")
    return grid
