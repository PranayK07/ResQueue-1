"""Urgency changes order; a modeled deadline must never veto an otherwise reachable dispatch."""
from rescue.core.policy import LookaheadPolicy, PlanInput, RequestState, UnitState
from rescue.core.continuation import next_request
from rescue.core.geo import Grid


def test_negative_margin_is_dispatched_before_lower_urgency_requests():
    late = RequestState(1, 1, 'mobility', 500, 705, {1:300})
    low = RequestState(2, 1, '', 20000, 285, {1:60})
    inp = PlanInput(1000, [low,late], [UnitState(1,1,'R1',True,1000)], {1:'Home'})
    plan = LookaheadPolicy().plan(inp)
    assert not plan.unreachable
    assert [entry.request_id for entry in sorted(plan.entries,key=lambda entry:entry.rank)] == [1,2]
    assert next(entry for entry in plan.entries if entry.request_id==1).unit_id == 1


def test_only_an_actual_missing_route_prevents_ground_dispatch():
    caller = RequestState(1,1,'',500,285,{1:float('inf')})
    plan = LookaheadPolicy().plan(PlanInput(1000,[caller],[UnitState(1,1,'R1',True,1000)],{1:'Home'}))
    assert not plan.entries and len(plan.unreachable)==1


def test_returning_truck_can_continue_to_a_caller_with_negative_slack():
    grid=Grid(35.6,-112.8,60,5,5)
    lat,lon=grid.center(12)
    unit=dict(id=1,station_id=1,callsign='R1',capacity=8,status='returning',current_request=0,
              free_at_s=1200,lat=lat,lon=lon)
    target=dict(id=2,status='pending',location_purged=False,headcount=1,needs='mobility',
                lat=lat,lon=lon,extract_s=705,pinned_station_id=0)
    risk=dict(request_id=2,reachable=True,level='critical',slack_s=-900,fire_eta_s=900,assessment_id='current')
    result=next_request(unit,1000,[target],[unit],[dict(current=True,assessment=risk)],grid)
    assert result[0:2]==(2,'current')
