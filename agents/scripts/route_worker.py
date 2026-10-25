"""Publish shared, closure-aware OSM road routes. Network/CPU work stays outside reducers."""
import asyncio
import hashlib
import json
import logging
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rescue.config import REPO_ROOT, settings
from rescue.stdb import SpacetimeClient

log = logging.getLogger('road-router')
TABLES = ['sim_clock', 'world_version', 'grid', 'unit', 'station', 'fire_cell', 'road_closure', 'ops_request', 'ops_unit_route']


async def calculate(payload):
    process = await asyncio.create_subprocess_exec('node', str(REPO_ROOT / 'agents/scripts/route_cli.mjs'),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    stdout, stderr = await process.communicate(json.dumps(payload).encode())
    if process.returncode:
        raise RuntimeError(stderr.decode()[:500])
    return json.loads(stdout)


async def run():
    path = REPO_ROOT / 'web/public/replay/roads.json'
    graph = json.loads(path.read_text())
    db = SpacetimeClient('road-router')
    await db.call('register_agent', settings.agent_join_key, 'scenario', 'road-router', 0, '')
    await db.connect([f'SELECT * FROM {name}' for name in TABLES])
    last_fire = None
    while True:
        try:
            clock = db.table('sim_clock').one()
            versions = db.table('world_version').one()
            grid = db.table('grid').one()
            if not clock or not versions or not grid:
                await asyncio.sleep(1)
                continue
            context = {'grid': {'originLat': grid['origin_lat'], 'originLon': grid['origin_lon'], 'rows': grid['rows'], 'cols': grid['cols'], 'cellSizeM': grid['cell_size_m']},
                       'fireCells': [{'cellId': c['cell_id']} for c in db.table('fire_cell')], 'closures': []}
            nodes = {n['id']: n for n in graph['nodes']}
            closures = list(db.table('road_closure'))
            fire_key = (clock['scenario'], versions['fire'])
            if fire_key != last_fire:
                blocked = set(await calculate({'action': 'closures', 'graph': graph, 'context': context}))
                existing = {c['name']: c for c in closures if c['source'] == 'replay-fire'}
                for edge in graph['edges']:
                    name = f"{edge['name']} · {edge['id']}"
                    if edge['id'] in blocked and name not in existing:
                        a, b = nodes[edge['from']], nodes[edge['to']]
                        await db.call('add_road_closure', name, a['lat'], a['lon'], b['lat'], b['lon'], 'replay-fire')
                    elif name in existing and existing[name]['active'] != (edge['id'] in blocked):
                        await db.call('set_road_closure_active', existing[name]['id'], edge['id'] in blocked)
                last_fire = fire_key
                await asyncio.sleep(.5)  # let the atomic closure updates reach the replica
                continue
            context['closures'] = [{'lat1': c.get('lat_1', c.get('lat1')), 'lon1': c.get('lon_1', c.get('lon1')), 'lat2': c.get('lat_2', c.get('lat2')), 'lon2': c.get('lon_2', c.get('lon2')), 'active': c['active']} for c in closures]
            requests = {r['id']: r for r in db.table('ops_request')}
            stations = {s['id']: s for s in db.table('station')}
            routes = {r['unit_id']: r for r in db.table('ops_unit_route')}
            for unit in db.table('unit'):
                if unit['status'] not in ('assigned', 'en_route', 'returning'):
                    continue
                target = requests.get(unit['current_request']) if unit['current_request'] else stations.get(unit['station_id'])
                if not target:
                    continue
                signature = hashlib.sha256(json.dumps([clock['scenario'], unit['id'], unit['current_request'], target['lat'], target['lon'], versions['fire'], versions['roads']], sort_keys=True).encode()).hexdigest()[:24]
                previous = routes.get(unit['id'])
                if previous and previous['signature'] == signature and previous.get('fire_version') == versions['fire'] and previous.get('roads_version') == versions['roads']:
                    continue
                payload = {'graph': graph, 'from': [unit['lon'], unit['lat']], 'to': [target['lon'], target['lat']], 'context': context}
                if previous and previous['points'] and unit['status'] in ('en_route', 'returning'):
                    payload['previous'] = {'points': previous['points'], 'fraction': (clock['sim_s'] - previous['depart_s']) / max(1, previous['arrive_s'] - previous['depart_s'])}
                route = await calculate(payload)
                ok = route['onRoads']
                await db.call('publish_unit_route', unit['id'], unit['current_request'], target['lat'], target['lon'], route.get('points', []), route['durationS'],
                              'ready' if ok else 'blocked', f"OSM roads via {route['via']}" if ok else route['reason'], signature, versions['fire'], versions['roads'])
                log.info('%s: %s', unit['callsign'], 'road route ready' if ok else route['reason'])
            await db.try_call('agent_heartbeat', 'online', 'OSM road routing; observed-fire closures; shared vehicle paths')
        except Exception:
            log.exception('route update failed; retrying current inputs')
        await asyncio.sleep(2)


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    logging.getLogger('httpx').setLevel(logging.WARNING)
    asyncio.run(run())
