"""Opt-in regression check against the isolated, running Arizona demo database."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
import uuid
import pytest

@pytest.mark.skipif(not os.environ.get('DEMO_TEST_DB'), reason='requires isolated local Arizona demo')
def test_live_caller_receipt_location_risk_privacy_and_busy_unit():
    from rescue.stdb import SpacetimeClient, ReducerError
    async def run():
        http = 'http://127.0.0.1:3000'
        database = os.environ['DEMO_TEST_DB']
        assert urlparse(http).hostname == '127.0.0.1' and database.startswith('wildfire-arizona-')
        clients = [SpacetimeClient('demo-test-'+uuid.uuid4().hex, http=http, db=database) for _ in range(3)]
        commander, caller, outsider = clients
        rid = None
        async def until(fn):
            stop = asyncio.get_running_loop().time() + 45
            while asyncio.get_running_loop().time() < stop:
                result = await fn()
                if result: return result
                await asyncio.sleep(.3)
            raise AssertionError('live pipeline did not propagate the change')
        try:
            await commander.call('claim_operator', os.environ['OPERATOR_PASSCODE'], 'commander', 0, 'Demo regression')
            fixture=json.loads((Path(__file__).parents[1]/'web/public/replay/demo.json').read_text())
            near, far = fixture['profiles'][0], fixture['profiles'][2]
            args=[near['lat'],near['lon'],1,'mobility','Test caller','Gate',15]
            await caller.call('submit_app_request',*args)
            rid=(await caller.sql('SELECT * FROM my_requests'))[0]['request_id']
            await caller.call('submit_app_request',*args)
            assert len(await caller.sql('SELECT * FROM my_requests')) == 1
            assert any(r['id']==rid for r in await commander.sql('SELECT * FROM ops_request'))
            assert await outsider.sql('SELECT * FROM ops_request') == []
            assert await outsider.sql('SELECT * FROM ops_unit_route') == []
            with pytest.raises(ReducerError,match='not your request'):
                await outsider.call('update_my_request',rid,far['lat'],far['lon'],1,'','','')
            async def risk():
                return next((r['assessment'] for r in await caller.sql('SELECT * FROM my_risk') if r['current']),None)
            first=await until(risk)
            busy=next(u for u in await commander.sql('SELECT * FROM unit') if u['current_request'] and u['current_request']!=rid)
            with pytest.raises(ReducerError,match='not available'):
                await commander.call('assign_request_to_unit',rid,busy['id'])
            await caller.call('update_my_request',rid,far['lat'],far['lon'],1,'','Moved to far pickup','Road gate')
            async def changed():
                r=await risk()
                return r if r and r['assessment_id']!=first['assessment_id'] and r['probabilities']!=first['probabilities'] else None
            second=await until(changed)
            assert second['slack_s'] != first['slack_s']
            assert second['model_id'] == first['model_id'] and second['model_id']
            assert (await caller.sql('SELECT * FROM my_requests'))[0]['request_id']==rid
            await caller.call('close_my_request',rid,'','safe')
            card=(await caller.sql('SELECT * FROM my_requests'))[0]
            assert card['lat']==card['lon']==0 and card['status']=='safe'
            assert await caller.sql('SELECT * FROM my_risk') == []
        finally:
            if rid:
                await caller.try_call('close_my_request',rid,'','safe')
            for c in clients: await c.close()
    asyncio.run(run())
