"""Choose three fictional callers from the first known observation and real model output.

Only locations/needs are seeded. Live agents compute every priority; no risk
labels, future perimeters or forecast values are inserted by this fixture.
"""
from __future__ import annotations

import numpy as np

from .config import settings
from .core.danger import assess_requests
from .core.fire import Ensemble, FuelMap, Wind, FUEL_SEED, ensemble_arrival
from .forecast_ml.live import LearnedForecastBackend


def demo_residents(source, stations):
    request, _ = source.request(0, [21600.0, 43200.0, 86400.0])
    result = LearnedForecastBackend("learned", settings.fire_forecast_checkpoint, settings.fire_forecast_metadata).forecast(request)
    if result.product is None:
        raise RuntimeError(f"Demo requires the trained U-Net: {result.reason}")
    product = result.product
    grid = source.routing_grid
    burning = {c["cell_id"]: c["ignited_s"] for c in source.fire_cells(0)}
    p10, _ = ensemble_arrival(grid, FuelMap.uniform(grid, seed=FUEL_SEED), burning, Wind(0.0, 0.0),
                             now_s=0, horizon_s=10800, ens=Ensemble(members=16))
    forecast = {int(r) * grid.cols + int(c): float(p10[r, c]) for r, c in zip(*np.nonzero(np.isfinite(p10)))}
    # Sample known valid land only. All selection uses observation zero, never later masks.
    ids = np.flatnonzero(product.valid & ~product.observed)[::2]
    points = [(int(cid), *product.grid.center(int(cid)), 1, "") for cid in ids]
    assessments, _ = assess_requests(grid, 0, points, [(s["id"], s["lat"], s["lon"]) for s in stations], forecast, set(burning), [])
    by_id = {int(cid): (lat, lon) for cid, lat, lon, _, _ in points}
    usable = [a for a in assessments if a["slack_s"] > 0 and a["slack_s"] < 1e8]
    if len(usable) < 3:
        raise RuntimeError("Recorded demo needs three reachable unburned locations")
    probability = lambda a: float(product.probabilities[-1][product.grid.rc(a["request_id"])])
    # An extra 420 seconds for mobility is the same extraction adjustment used by the live engine.
    high = min(usable, key=lambda a: (abs((a["slack_s"] - 420) - 900), -probability(a)))
    rest = [a for a in usable if a is not high]
    medium = min(rest, key=lambda a: (abs(a["slack_s"] - 2400), -probability(a)))
    rest = [a for a in rest if a is not medium]
    low = min(rest, key=lambda a: (probability(a), -a["slack_s"]))
    selected = [(high, "mobility", "Wheelchair assistance needed; front entrance."),
                (medium, "", "One person at this location."),
                (low, "", "One person; no additional assistance needs.")]
    output = []
    for index, (a, needs, note) in enumerate(selected, 1):
        lat, lon = by_id[a["request_id"]]
        output.append(dict(request_id=index, lat=lat, lon=lon, headcount=1, needs=needs, note=note,
                           selection_slack_s=a["slack_s"] - (420 if needs else 0),
                           selection_exposure=probability(a)))
    return output
