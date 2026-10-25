"""Registration recovery must not weaken reducer permissions or loop on failures."""
import asyncio
import json
import httpx
import pytest
from rescue.stdb import SpacetimeClient, ReducerError


def test_lost_registration_recovers_once_and_preserves_principal_role():
    async def run():
        registered=False
        calls=[]
        def handle(request):
            nonlocal registered
            reducer=request.url.path.rsplit('/',1)[-1]
            args=json.loads(request.content)
            calls.append((reducer,args))
            if reducer=='register_agent':
                registered=True
                return httpx.Response(200)
            return httpx.Response(200 if registered else 530, text='' if registered else 'not a registered agent')
        client=SpacetimeClient('registration-test')
        client._token='test-token'
        client._http=httpx.AsyncClient(transport=httpx.MockTransport(handle))
        registration=('test-key','hazard','hazard',0,'test-address')
        try:
            await client.call('register_agent',*registration)
            registered=False
            await client.call('agent_heartbeat','online','ready')
            assert [name for name,_ in calls]==['register_agent','agent_heartbeat','register_agent','agent_heartbeat']
            assert calls[2][1]==list(registration)
        finally: await client.close()
    asyncio.run(run())


def test_wrong_role_or_invalid_join_key_still_fails_without_retry_loop():
    async def run():
        calls=[]
        def handle(request):
            reducer=request.url.path.rsplit('/',1)[-1]
            calls.append(reducer)
            return httpx.Response(200 if reducer=='register_agent' else 530,text='requires commander')
        client=SpacetimeClient('registration-test')
        client._token='test-token'
        client._http=httpx.AsyncClient(transport=httpx.MockTransport(handle))
        try:
            await client.call('register_agent','test-key','news','news',0,'')
            with pytest.raises(ReducerError,match='requires commander'):
                await client.call('upsert_fire_cells',[],True,'perimeter')
            assert calls==['register_agent','upsert_fire_cells','register_agent','upsert_fire_cells']
            client._registration=None
            with pytest.raises(ReducerError): await client.call('upsert_fire_cells',[],True,'perimeter')
            assert len(calls)==5  # anonymous clients cannot acquire an agent role
        finally: await client.close()
    asyncio.run(run())


def test_subscription_timeout_reuses_existing_socket_on_retry(monkeypatch):
    async def run():
        client=SpacetimeClient('subscription-test')
        loaded=0
        release=asyncio.Event()
        async def schemas():
            nonlocal loaded
            loaded+=1
        async def socket():
            await release.wait()
            client._ready.set()
            await asyncio.Event().wait()
        monkeypatch.setattr(client,'_load_schemas',schemas)
        monkeypatch.setattr(client,'_ws_loop',socket)
        try:
            with pytest.raises(TimeoutError): await client.connect(['SELECT * FROM grid'],timeout=0.001)
            existing=client._ws_task
            release.set()
            await client.connect(['SELECT * FROM grid'],timeout=1)
            assert client._ws_task is existing and loaded==1
        finally: await client.close()
    asyncio.run(run())
