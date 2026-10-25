"""One-stop LOOKAHEAD from a crew's actual location; never steal an attended caller."""
from .assistance import response_options
from .geo import haversine_m


def next_request(unit, now, requests, units, cards, grid, burning=(), closures=()):
    risks = {c['assessment']['request_id']: c['assessment'] for c in cards if c['current']}
    attended = {u['current_request'] for u in units if u['current_request']}
    candidates = [r for r in requests if r['status'] in ('pending', 'queued') and not r['location_purged']
                  and r['id'] not in attended and r['headcount'] <= unit['capacity']
                  and r.get('pinned_station_id', 0) in (0, unit['station_id']) and r['id'] in risks]
    available = {**unit, 'status':'available', 'current_request':0, 'free_at_s':now}
    options = response_options(grid, now, candidates, [available], [], burning=burning, closures=closures)
    feasible = []
    for r in candidates:
        risk, option = risks[r['id']], options[r['id']]
        if not option or not risk['reachable']:
            continue
        drive = max(1.0, option['travel_s'])
        nearby_critical = risk['level'] == 'critical' and haversine_m(unit['lat'], unit['lon'], r['lat'], r['lon']) <= 3000
        feasible.append(((not nearby_critical, risk['slack_s'], drive), r['id'], risk['assessment_id'], drive))
    return min(feasible)[1:] if feasible else None
