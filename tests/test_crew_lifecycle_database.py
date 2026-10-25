"""Run against an isolated wrq-web-flow-* module; never touches a demo database."""
import asyncio
import os
import uuid
import pytest

@pytest.mark.skipif(not os.environ.get('WEB_FLOW_DB'), reason='requires isolated local module')
def test_return_position_extraction_and_atomic_continuation():
    from rescue.config import settings
    from rescue.stdb import SpacetimeClient, ReducerError
    from rescue.core.danger import assess_requests
    from rescue.core.geo import Grid
    from rescue.core.risk import compose_risks, risk_snapshot
    from rescue.planning import risk_to_reducer_args

    async def run():
        database = os.environ['WEB_FLOW_DB']
        assert database.startswith('wrq-web-flow-')
        prefix = 'crew-test-' + uuid.uuid4().hex[:8]
        command, hazard, caller, other = [SpacetimeClient(prefix+n, http='http://127.0.0.1:3000', db=database)
                                         for n in ('command','hazard','caller','other')]
        async def rows(table):
            return await command.sql('SELECT * FROM '+table)
        async def publish():
            versions = (await rows('world_version'))[0]
            clock = (await rows('sim_clock'))[0]
            await hazard.call('publish_forecast', versions['weather'], versions['fire'], clock['sim_s'], 18000.0, 16, [])
            versions = (await rows('world_version'))[0]
            units, requests = await rows('unit'), await rows('ops_request')
            pipeline = await rows('risk_pipeline')
            snap = risk_snapshot(clock['sim_s'], clock['scenario'], versions, units, pipeline=pipeline[0] if pipeline else None)
            grid = Grid.from_row((await rows('grid'))[0])
            dangers, travel = assess_requests(grid, clock['sim_s'],
                [(r['id'],r['lat'],r['lon'],r['headcount'],r['needs']) for r in requests],
                [(1,35.6005,-112.7995)], {},set(),[])
            await command.call('publish_risk_assessments', *risk_to_reducer_args(snap, compose_risks(snap,requests,dangers,travel,units,{}),travel))
        try:
            await command.call('register_agent',settings.agent_join_key,'scenario','Crew regression',0,'')
            await command.call('load_scenario','crew-regression',35.6,-112.8,100.0,20,20,
                [dict(id=1,name='Home',lat=35.6005,lon=-112.7995)],
                [dict(id=1,station_id=1,callsign='R1',kind='engine',capacity=8)],1.0,0.0,0.0)
            await command.call('register_agent',settings.agent_join_key,'commander','Crew regression',0,'')
            await hazard.call('register_agent',settings.agent_join_key,'hazard','Crew hazard',0,'')
            await caller.call('submit_app_request',35.602,-112.798,1,'','','',60)
            first=(await caller.sql('SELECT * FROM my_requests'))[0]['request_id']
            await command.call('assign_request_to_unit',first,1)
            await command.call('unit_en_route',1,600.0,1800.0)
            await command.call('set_replay_schedule',[0.0,300.0,600.0,1200.0])
            await command.call('advance_replay')
            await caller.call('close_my_request',first,'','safe')
            unit=(await rows('unit'))[0]
            assert unit['status']=='returning' and unit['current_request']==0
            assert 35.6005 < unit['lat'] < 35.602
            assert unit['leg_depart_s']==300 and unit['free_at_s']>300
            await command.call('unit_available',1,35.6005,-112.7995)
            await caller.call('submit_app_request',35.602,-112.798,1,'','','',60)
            first=max(await caller.sql('SELECT * FROM my_requests'),key=lambda r:r['request_id'])['request_id']
            await other.call('submit_app_request',35.603,-112.797,1,'','','',60)
            second=(await other.sql('SELECT * FROM my_requests'))[0]['request_id']
            await command.call('assign_request_to_unit',first,1)
            await command.call('unit_en_route',1,600.0,1800.0)
            await command.call('advance_replay')
            await command.call('unit_on_scene',1)
            await publish()
            assessment=next(r['assessment'] for r in await rows('ops_risk') if r['assessment']['request_id']==second)
            with pytest.raises(ReducerError):
                await other.call('continue_unit_mission',1,second,assessment['assessment_id'],60.0)
            with pytest.raises(ReducerError,match='extraction is still in progress'):
                await command.call('continue_unit_mission',1,second,assessment['assessment_id'],60.0)
            await command.call('advance_replay')
            await publish()
            assessment=next(r['assessment'] for r in await rows('ops_risk') if r['assessment']['request_id']==second)
            await command.call('continue_unit_mission',1,second,assessment['assessment_id'],60.0)
            unit=(await rows('unit'))[0]
            assert unit['current_request']==second and unit['status']=='assigned'
            assert unit['lat']==35.602 and unit['lon']==-112.798
            closed=next(r for r in await caller.sql('SELECT * FROM my_requests') if r['request_id']==first)
            assert closed['status']=='rescued' and closed['lat']==closed['lon']==0
            with pytest.raises(ReducerError):
                await command.call('continue_unit_mission',1,second,assessment['assessment_id'],60.0)
        finally:
            for client in (command,hazard,caller,other): await client.close()
    asyncio.run(run())
