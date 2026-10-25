"""Response time from real unit state, kept separate from fire exposure and road topology."""
import math

import numpy as np

from .routing import GridRouter, blocked_mask


def position_along(points, fraction):
    fraction = max(0.0, min(1.0, fraction))
    def distance(a, b):
        return math.hypot((a['lat'] - b['lat']) * 111320,
                          (a['lon'] - b['lon']) * 111320 * math.cos(math.radians((a['lat'] + b['lat']) / 2)))
    lengths = [distance(a, b) for a, b in zip(points, points[1:])]
    left = sum(lengths) * fraction
    for i, length in enumerate(lengths):
        if length > 0 and left <= length:
            f = left / length
            return {k: points[i][k] + (points[i + 1][k] - points[i][k]) * f for k in ('lat', 'lon')}
        left -= length
    return {k: points[-1][k] for k in ('lat', 'lon')}


def response_options(grid, now, requests, units, travel, queue=(), routes=(), burning=(), closures=()):
    """Committed truck first; otherwise the earliest capacity-compatible available truck or known release.

    Assigned trucks have not departed: an old queue ETA is never a countdown to their arrival.
    A road path is distinct from whether the fire-timing estimate leaves enough rescue time.
    """
    stations = {(t['request_id'], t['station_id']): t for t in travel}
    queues = {q['request_id']: q for q in queue}
    paths = {r['unit_id']: r for r in routes}
    fields = {}
    blocked = blocked_mask(grid, set(burning), list(closures))
    router = GridRouter(grid)
    no_deadlines = np.full((grid.rows, grid.cols), np.inf)
    results = {}
    for request in requests:
        rid = request['id']
        committed = next((u for u in units if u['current_request'] == rid and u['status'] in ('assigned', 'en_route', 'on_scene')), None)
        options = []
        for u in ([committed] if committed else units):
            if u['status'] == 'out_of_service' or u.get('capacity', 50) < request['headcount']:
                continue
            route = paths.get(u['id'])
            if committed:
                q = queues.get(rid)
                ready = route and route['request_id'] == rid and route.get('status', 'ready') == 'ready'
                if route and not ready:
                    continue
                if u['status'] == 'on_scene':
                    drive = 0.0
                elif u['status'] == 'en_route':
                    arrival = route['arrive_s'] if ready else (q['eta_s'] if q else now)
                    drive = max(0.0, arrival - now)
                elif ready:
                    drive = route.get('duration_s', route['arrive_s'] - route['depart_s'])
                else:
                    if u['id'] not in fields:
                        fields[u['id']] = router.travel_times((u['lat'], u['lon']), now, no_deadlines, blocked)
                    rc = grid.locate_rc(request['lat'], request['lon'])
                    drive = float(fields[u['id']][rc]) if rc is not None else math.inf
                wait = 0.0
            elif u['status'] in ('available', 'returning') and not u['current_request']:
                at = u
                if route and route.get('points') and u['status'] == 'returning':
                    at = position_along(route['points'], (now - route['depart_s']) / max(1, route['arrive_s'] - route['depart_s']))
                if u['id'] not in fields:
                    fields[u['id']] = router.travel_times((at['lat'], at['lon']), now, no_deadlines, blocked)
                rc = grid.locate_rc(request['lat'], request['lon'])
                drive = float(fields[u['id']][rc]) if rc is not None else math.inf
                wait = 0.0
            else:
                if u['free_at_s'] <= now:
                    continue  # unknown release: do not invent a 30-minute delay
                leg = stations.get((rid, u['station_id']))
                if not leg or not leg['reachable']:
                    continue
                drive, wait = leg['travel_s'], u['free_at_s'] - now
            if math.isfinite(drive) and drive < 1e8:
                options.append(dict(request_id=rid, station_id=u['station_id'], unit_id=u['id'], callsign=u['callsign'],
                                    travel_s=round(drive, 1), wait_s=round(wait, 1), reachable=True))
        results[rid] = min(options, key=lambda t: t['wait_s'] + t['travel_s']) if options else None
    return results
