"""Cache the actual OSM drivable network around a recorded incident, with source attribution."""
import json
from pathlib import Path
import sys
from datetime import datetime, timezone
import httpx

root = Path(__file__).resolve().parents[2]
manifest = json.loads((root / 'runs/recorded-integration/incident.json').read_text())
g = manifest['routing_grid']
south, west = g['origin_lat'] - .025, g['origin_lon'] - .03
north = g['origin_lat'] + g['rows'] * g['cell_size_m'] / 111320 + .025
east = g['origin_lon'] + .13
query = f'[out:json][timeout:45];way["highway"]["highway"!~"^(footway|path|cycleway|steps|pedestrian|bridleway|construction|proposed)$"]({south},{west},{north},{east});out geom;'
target = root / 'web/public/replay/roads.json'
if target.exists():
    print(f'Using cached road network: {target}')
    sys.exit(0)
for endpoint in ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']:
    try:
        response = httpx.post(endpoint, data={'data': query}, timeout=65, headers={'User-Agent': 'WildfireRescueHackathon/1.0'})
        response.raise_for_status()
        data = response.json()
        break
    except (httpx.HTTPError, ValueError):
        if endpoint.endswith('kumi.systems/api/interpreter'):
            raise
nodes, edges = {}, []
speeds = {'motorway': 25, 'trunk': 22, 'primary': 18, 'secondary': 15, 'tertiary': 12, 'residential': 8, 'service': 6, 'track': 4}
for way in data['elements']:
    tags = way.get('tags', {})
    if tags.get('motor_vehicle') == 'no' or tags.get('motorcar') == 'no':
        continue
    ids, geometry = way.get('nodes', []), way.get('geometry', [])
    for nid, point in zip(ids, geometry):
        nodes[nid] = {'id': nid, 'lon': point['lon'], 'lat': point['lat']}
    for i in range(len(ids) - 1):
        a, b = ids[i:i + 2]
        if tags.get('oneway') == '-1':
            a, b = b, a
        edges.append({'id': f"{way['id']}:{i}", 'from': a, 'to': b, 'name': tags.get('name') or tags.get('ref') or 'Forest access road',
                      'speedMps': speeds.get(tags.get('highway'), 8), 'oneway': tags.get('oneway') in ('yes', '1', '-1')})
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps({'source': 'OpenStreetMap contributors / ODbL', 'endpoint': endpoint, 'fetchedAt': datetime.now(timezone.utc).isoformat(),
                             'bbox': [west, south, east, north], 'nodes': list(nodes.values()), 'edges': edges}, separators=(',', ':')))
print(f'Cached {len(nodes)} road nodes and {len(edges)} road segments.')
