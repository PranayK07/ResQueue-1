"""Typed probability-layer bridge to SpacetimeDB, with no resident data.

The old forecast_cell, danger and publish_plan contracts remain unchanged.
Historical UTC and simulation seconds are explicit distinct clocks. This layer
cannot silently inject coarse historical windows into minute-level route ETAs.
"""

from __future__ import annotations

import numpy as np

from .risk import ForecastProduct, RISK_SCHEMA


def risk_arguments(product: ForecastProduct, grid_record, versions, clock_s, *, time_basis="historical_utc"):
    """Reducer positional arguments; all times are seconds, projected distances meters."""
    if time_basis not in {"historical_utc", "simulation"}:
        raise ValueError("explicit supported time basis required")
    from .geo_contract import validate_projected_grid

    validate_projected_grid(grid_record, product.grid)
    if time_basis == "simulation" and product.issue_s > clock_s:
        raise ValueError("forecast issue is ahead of simulation clock")
    cells = []
    for cell in np.flatnonzero(product.valid):
        rc = product.grid.rc(int(cell))
        for horizon, probability in zip(product.horizons_s, product.probabilities):
            cells.append(
                {
                    "cell_id": int(cell),
                    "horizon_s": float(horizon),
                    "probability": float(probability[rc]),
                    "observed": bool(product.observed[rc]),
                }
            )
    return [
        versions["weather"],
        versions["fire"],
        float(clock_s),
        RISK_SCHEMA,
        product.model_id,
        product.source,
        time_basis,
        product.issue_s,
        product.observation_age_s,
        product.horizons_s,
        grid_record["crs"],
        grid_record["x_min"],
        grid_record["y_min"],
        product.grid.cell_size_m,
        product.grid.rows,
        product.grid.cols,
        product.quality_flags,
        cells,
    ]


def product_from_rows(meta, rows):
    """Reconstruct the exact projected grid; omitted cells remain unknown."""
    from .spatial import transformer
    from .geo_contract import validate_projected_grid

    lon, lat = transformer(meta["crs"], "EPSG:4326").transform(meta["west_m"], meta["south_m"])
    grid = validate_projected_grid(
        {
            "origin_lat": lat,
            "origin_lon": lon,
            "cell_size_m": meta["cell_size_m"],
            "rows": meta["rows"],
            "cols": meta["cols"],
            "crs": meta["crs"],
            "x_min": meta["west_m"],
            "y_min": meta["south_m"],
        }
    )
    horizons = meta["horizons_s"]
    p = np.full((len(horizons), grid.rows, grid.cols), np.nan)
    observed = np.zeros((grid.rows, grid.cols), bool)
    for row in rows:
        if not 0 <= row["cell_id"] < grid.size:
            raise ValueError("stored risk cell outside declared grid")
        index = horizons.index(row["horizon_s"])
        rc = grid.rc(row["cell_id"])
        p[(index, *rc)] = row["probability"]
        observed[rc] = row["observed"]
    valid = np.isfinite(p).all(axis=0)
    return ForecastProduct(
        grid,
        meta["issue_s"],
        horizons,
        p,
        valid,
        observed,
        meta["model_id"],
        meta["source"],
        meta["observation_age_s"],
        meta["quality_flags"],
    )
