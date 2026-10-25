"""Exercise the actual crew step so a missing continuation method cannot ship unnoticed."""
from argparse import Namespace
from scripts.sim_crews import Crews
from rescue.stdb import Table


def test_returning_crew_finishes_the_return_when_no_next_caller_exists():
    crew = Crews(Namespace(stations=set(), dwell_s=None, manual_phones=False))
    home = dict(id=1, name='Home', lat=35.6, lon=-112.8)
    unit = dict(id=1, station_id=1, callsign='R1', capacity=8, status='returning', current_request=0,
                lat=35.6001, lon=-112.8, free_at_s=100, leg_depart_s=0)
    rows = {
        'grid':[dict(id=0, origin_lat=35.6,origin_lon=-112.8,cell_size_m=60,rows=5,cols=5)],
        'ops_unit_route':[dict(unit_id=1,request_id=0,status='ready',depart_s=0,arrive_s=100,
                               points=[dict(lat=unit['lat'],lon=unit['lon']),dict(lat=home['lat'],lon=home['lon'])])],
        'ops_request':[], 'ops_queue':[], 'ops_risk':[], 'road_closure':[], 'fire_cell':[], 'unit':[unit],
    }
    for name, values in rows.items():
        table=Table(name,[])
        table.rows={table.key(row):row for row in values}
        crew.db.tables[name]=table
    move=crew.plan(unit,200,{1:home},set())
    assert move.calls==[('unit_available',1,home['lat'],home['lon'])]
