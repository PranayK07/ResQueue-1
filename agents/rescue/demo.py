"""Choose fictional demand on actual roads using the current observation and calculated urgency.

No risk level is stored in a fixture. The live pipeline reassesses every location edit.
"""
import asyncio
import json
import math
from pathlib import Path
import numpy as np

from .config import REPO_ROOT, settings
from .core.fire import FUEL_SEED, FuelMap, Wind, Ensemble, ensemble_arrival
from .core.danger import assess_requests
from .core.geo import Grid
from .forecast_ml.live import LearnedForecastBackend


async def demo_fixture(source, manifest):
    from scripts.route_worker import calculate
    graph = json.loads((REPO_ROOT / 'web/public/replay/roads.json').read_text())
    grid = source.routing_grid
    fire = source.fire_cells(0)
    burning = {c['cell_id']: c['ignited_s'] for c in fire}
    context = {'grid': {'originLat': grid.origin_lat, 'originLon': grid.origin_lon, 'rows': grid.rows, 'cols': grid.cols, 'cellSizeM': grid.cell_size_m},
               'fireCells': [{'cellId': cid} for cid in burning], 'closures': []}
    closed = set(await calculate({'action': 'closures', 'graph': graph, 'context': context}))
    adjacency = {}
    for e in graph['edges']:
        if e['id'] not in closed:
            adjacency.setdefault(e['from'], set()).add(e['to'])
            adjacency.setdefault(e['to'], set()).add(e['from'])
    eligible = [n for n in graph['nodes'] if n['id'] in adjacency and grid.locate(n['lat'], n['lon']) is not None
                and grid.locate(n['lat'], n['lon']) not in burning]
    if len(eligible) < 10:
        raise ValueError('Insufficient accessible road locations in the incident domain')
    stations = []
    for i, station in enumerate(manifest['stations']):
        point = min(eligible, key=lambda n: (n['lat'] - station['lat']) ** 2 + ((n['lon'] - station['lon']) * math.cos(math.radians(station['lat']))) ** 2)
        stations.append({**station, 'name': f'Response station {i + 1}', 'lat': point['lat'], 'lon': point['lon']})
    reachable = set()
    for station in stations:
        start = min(eligible, key=lambda n: (n['lat'] - station['lat']) ** 2 + (n['lon'] - station['lon']) ** 2)['id']
        stack = [start]
        while stack:
            node = stack.pop()
            if node in reachable: continue
            reachable.add(node); stack.extend(adjacency.get(node, ()))
    eligible = [n for n in eligible if n['id'] in reachable]
    request, _ = source.request(0, [21600., 43200., 86400.])
    result = await asyncio.to_thread(LearnedForecastBackend('learned', settings.fire_forecast_checkpoint, settings.fire_forecast_metadata).forecast, request)
    if result.product is None:
        raise ValueError(f'Learned demo requires a validated U-Net forecast: {result.reason}')
    p10, _ = await asyncio.to_thread(ensemble_arrival, grid, FuelMap.uniform(grid, seed=FUEL_SEED), burning, Wind(0, 0), now_s=0., horizon_s=10800., ens=Ensemble(members=16))
    forecast = {int(r) * grid.cols + int(c): float(p10[r, c]) for r, c in zip(*np.nonzero(np.isfinite(p10)))}
    assessments, _ = assess_requests(grid, 0., [(n['id'], n['lat'], n['lon'], 1, '') for n in eligible],
                                    [(s['id'], s['lat'], s['lon']) for s in stations], forecast, set(burning), [])
    scores = {a['request_id']: a for a in assessments if a['slack_s'] > -1000 and a['slack_s'] < 1e8}
    eligible = [n for n in eligible if n['id'] in scores]
    def exposure(n):
        rc = result.product.grid.locate_rc(n['lat'], n['lon'])
        return float(result.product.probabilities[-1][rc]) if rc is not None else 0.
    high = min(eligible, key=lambda n: (abs(scores[n['id']]['slack_s'] - 420 - 900), -exposure(n)))
    medium = min((n for n in eligible if n['id'] != high['id']), key=lambda n: (abs(scores[n['id']]['slack_s'] - 2400), -exposure(n)))
    low = min((n for n in eligible if n['id'] not in (high['id'], medium['id'])), key=lambda n: (exposure(n), -scores[n['id']]['slack_s']))
    residents = [{ 'request_id': i + 1, 'lat': n['lat'], 'lon': n['lon'], 'headcount': 1, 'needs': 'mobility' if i == 0 else '',
                   'note': 'Wheelchair assistance requested' if i == 0 else 'Pickup requested at road access'} for i, n in enumerate([high, medium, low])]
    candidates = sorted((n for n in eligible if n['id'] not in (high['id'], medium['id'], low['id'])), key=lambda n: abs(scores[n['id']]['slack_s'] - 2200))[:12]
    public = {'sourceId': source.source_id, 'callerLocations': [{'lat': n['lat'], 'lon': n['lon']} for n in candidates],
              'description': 'NIROPS Arizona July 2020 replay; synthetic residents, stations and units',
              'profiles': [{**r, 'calculatedSlackS': scores[n['id']]['slack_s'] - (420 if i == 0 else 0), 'learnedExposure24h': exposure(n)} for i, (r, n) in enumerate(zip(residents, [high, medium, low]))]}
    output = REPO_ROOT / 'web/public/replay/demo.json'
    output.write_text(json.dumps(public, indent=2))
    print('Selected road-access fixtures:', [(round(r['calculatedSlackS'] / 60, 1), round(r['learnedExposure24h'], 3)) for r in public['profiles']])
    return stations, [{**u, 'callsign': f"Engine {u['id']}"} for u in manifest['units']], residents
