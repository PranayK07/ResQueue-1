"""Minimal async SpacetimeDB client for Python agents.

There is no official Python SDK, so this speaks the documented wire APIs:

* reducers:      POST /v1/database/:db/call/:reducer   (JSON array of args)
* ad-hoc reads:  POST /v1/database/:db/sql
* live state:    WS   /v1/database/:db/subscribe       (v1.json.spacetimedb)

`connect()` subscribes to a set of queries and keeps an in-memory replica of
the matching rows, exactly like the official SDK client cache. Agents read
from `client.table("...")` and register `on_update` callbacks that fire once
per committed transaction touching tables they care about.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import re
from collections.abc import Awaitable, Callable, Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any

import httpx
import websockets

from .config import STATE_DIR, settings
from .sats import decode_product

log = logging.getLogger("stdb")

# Primary key column per table/view, used to key the local replica.
PRIMARY_KEYS: dict[str, str] = {
    "agent": "identity",
    "sim_clock": "id",
    "grid": "id",
    "station": "id",
    "unit": "id",
    "weather": "id",
    "fire_cell": "cell_id",
    "forecast_cell": "cell_id",
    "forecast_meta": "id",
    "fire_risk_meta": "id",
    "fire_risk_cell": "key",
    "risk_pipeline": "id",
    "world_version": "id",
    "road_closure": "id",
    "event_log": "id",
    "news_article": "url",
    "news_focus": "id",
    "ops_request": "id",
    "ops_queue": "request_id",
    "ops_unit_route": "unit_id",
    "ops_travel": "key",
    "ops_flag": "id",
    "ops_report": "id",
    "ops_assessment": "request_id",
    "ops_message": "id",
    "my_requests": "request_id",
}

_FROM = re.compile(r"\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)", re.IGNORECASE)


class ReducerError(RuntimeError):
    def __init__(self, reducer: str, status: int, message: str):
        super().__init__(f"{reducer} failed ({status}): {message}")
        self.reducer = reducer
        self.status = status
        self.message = message


class Table:
    def __init__(self, name: str, elements: list[dict]):
        self.name = name
        self.elements = elements
        self.pk = PRIMARY_KEYS.get(name)
        self.rows: dict[Any, dict] = {}

    def key(self, row: dict) -> Any:
        if self.pk:
            return row[self.pk]
        return json.dumps(row, sort_keys=True, default=str)

    def decode(self, raw: str | list | dict) -> dict:
        if isinstance(raw, str):
            raw = json.loads(raw)
        return decode_product(self.elements, raw)

    def get(self, key: Any) -> dict | None:
        return self.rows.get(key)

    def one(self) -> dict | None:
        """For singleton tables (sim_clock, weather, grid, ...)."""
        return next(iter(self.rows.values()), None)

    def __iter__(self) -> Iterator[dict]:
        return iter(list(self.rows.values()))

    def __len__(self) -> int:
        return len(self.rows)


@dataclass
class TableDelta:
    inserts: list[dict] = field(default_factory=list)
    deletes: list[dict] = field(default_factory=list)


@dataclass
class Update:
    """One committed transaction (or a full resync after (re)connect)."""

    tables: dict[str, TableDelta]
    reducer: str | None = None
    caller: str | None = None
    resync: bool = False

    def touched(self, *names: str) -> bool:
        return self.resync or any(n in self.tables for n in names)


Listener = Callable[[Update], Awaitable[None] | None]


class SpacetimeClient:
    def __init__(self, name: str, *, http: str | None = None, db: str | None = None):
        self.name = name
        self.http = (http or settings.stdb_http).rstrip("/")
        self.db = db or settings.stdb_db
        self.ws_url = self.http.replace("http://", "ws://").replace("https://", "wss://")
        self.identity: str | None = None
        self.tables: dict[str, Table] = {}
        self._queries: list[str] = []
        self._listeners: list[tuple[frozenset[str] | None, Listener]] = []
        # Tokens are issued per server, so local and Maincloud identities are kept apart.
        host = re.sub(r"[^A-Za-z0-9.-]", "_", self.http.split("://", 1)[-1])
        self._token_path = STATE_DIR / f"{name}@{host}.stdb-token"
        self._token: str | None = None
        self._http: httpx.AsyncClient | None = None
        self._ws_task: asyncio.Task | None = None
        self._ready = asyncio.Event()
        self._closing = False
        self._registration: tuple[Any, ...] | None = None
        self._registration_lock = asyncio.Lock()
        self._registration_version = 0

    # ── auth ────────────────────────────────────────────────────────────────

    async def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=15.0)
        return self._http

    async def ensure_token(self) -> str:
        if self._token:
            return self._token
        if self._token_path.exists():
            self._token = self._token_path.read_text().strip()
        else:
            r = await (await self._client()).post(f"{self.http}/v1/identity")
            r.raise_for_status()
            self._token = r.json()["token"]
            self._token_path.write_text(self._token)
            self._token_path.chmod(0o600)
        return self._token

    async def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {await self.ensure_token()}"}

    # ── writes & ad-hoc reads ───────────────────────────────────────────────

    async def _invoke(self, reducer: str, args: tuple, timeout: float | None = None) -> None:
        url = f"{self.http}/v1/database/{self.db}/call/{reducer}"
        r = await (await self._client()).post(url, json=list(args), headers=await self._headers(),
                                              **({"timeout": timeout} if timeout else {}))
        if r.status_code >= 400:
            raise ReducerError(reducer, r.status_code, r.text.strip()[:500])

    async def _restore_registration(self, version: int) -> None:
        # Several engines can notice the same reset. Restore this principal once,
        # using only the role and join key it successfully registered with before.
        async with self._registration_lock:
            if self._registration and version == self._registration_version:
                await self._invoke("register_agent", self._registration)
                self._registration_version += 1
                log.info("[%s] restored agent registration on %s", self.name, self.db)

    async def call(self, reducer: str, *args: Any, timeout: float | None = None) -> None:
        """Invoke a reducer; recover a lost agent registration once, preserving its role."""
        version = self._registration_version
        try:
            await self._invoke(reducer, args, timeout)
        except ReducerError as error:
            lost_role = any(message in error.message for message in
                            ("not a registered agent", "requires commander", "requires agent role:"))
            if reducer == "register_agent" or not self._registration or not lost_role:
                raise
            await self._restore_registration(version)
            await self._invoke(reducer, args, timeout)  # one retry; permission failures still surface
        if reducer == "register_agent":
            self._registration = args
            self._registration_version += 1

    async def try_call(self, reducer: str, *args: Any) -> bool:
        try:
            await self.call(reducer, *args)
            return True
        except ReducerError as e:
            log.warning("[%s] %s", self.name, e)
            return False
        except httpx.HTTPError as e:
            log.warning("[%s] %s transport error: %s", self.name, reducer, e)
            return False

    async def sql(self, query: str) -> list[dict]:
        url = f"{self.http}/v1/database/{self.db}/sql"
        r = await (await self._client()).post(url, content=query, headers=await self._headers())
        if r.status_code >= 400:
            raise ReducerError("sql", r.status_code, r.text.strip()[:500])
        out: list[dict] = []
        for stmt in r.json():
            elements = stmt["schema"]["elements"]
            out.extend(decode_product(elements, row) for row in stmt["rows"])
        return out

    # ── subscriptions ───────────────────────────────────────────────────────

    def table(self, name: str) -> Table:
        if name not in self.tables:
            raise KeyError(f"{name} is not subscribed by {self.name}")
        return self.tables[name]

    def on_update(self, tables: Iterable[str] | None, cb: Listener) -> None:
        """Call `cb(update)` for every transaction touching any of `tables`
        (or every transaction if None). Also fires once after each (re)sync."""
        self._listeners.append((frozenset(tables) if tables is not None else None, cb))

    async def connect(self, queries: list[str], timeout: float = 30.0) -> None:
        self._queries = queries
        if self._ws_task is None or self._ws_task.done():
            await self._load_schemas()
            self._ws_task = asyncio.create_task(self._ws_loop(), name=f"stdb-ws-{self.name}")
        await asyncio.wait_for(self._ready.wait(), timeout)

    async def close(self) -> None:
        self._closing = True
        if self._ws_task:
            self._ws_task.cancel()
        if self._http:
            await self._http.aclose()

    async def _load_schemas(self) -> None:
        for q in self._queries:
            m = _FROM.search(q)
            if not m:
                raise ValueError(f"cannot find table name in query: {q}")
            name = m.group(1)
            if name in self.tables:
                continue
            url = f"{self.http}/v1/database/{self.db}/sql"
            r = await (await self._client()).post(url, content=f"SELECT * FROM {name} LIMIT 0", headers=await self._headers())
            r.raise_for_status()
            self.tables[name] = Table(name, r.json()[0]["schema"]["elements"])

    async def _ws_loop(self) -> None:
        backoff = 0.5
        url = f"{self.ws_url}/v1/database/{self.db}/subscribe"
        while not self._closing:
            try:
                async with websockets.connect(
                    url,
                    subprotocols=["v1.json.spacetimedb"],
                    additional_headers=await self._headers(),
                    max_size=None,
                    ping_interval=20,
                ) as ws:
                    await self._restore_registration(self._registration_version)
                    await ws.send(json.dumps({"Subscribe": {"query_strings": self._queries, "request_id": 1}}))
                    backoff = 0.5
                    async for raw in ws:
                        await self._handle(json.loads(raw))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - reconnect on anything
                if self._closing:
                    return
                log.warning("[%s] SpacetimeDB socket dropped (%s); reconnecting in %.1fs", self.name, e, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 10.0)

    async def _handle(self, msg: dict) -> None:
        (kind, body), = msg.items()
        if kind == "IdentityToken":
            self.identity = body["identity"]["__identity__"]
        elif kind == "InitialSubscription":
            for t in self.tables.values():
                t.rows.clear()
            self._apply(body["database_update"])
            self._ready.set()
            await self._emit(Update(tables={}, resync=True))
        elif kind == "TransactionUpdate":
            status = body["status"]
            if "Committed" in status:
                upd = self._apply(status["Committed"])
                call = body.get("reducer_call", {})
                upd.reducer = call.get("reducer_name")
                upd.caller = body.get("caller_identity", {}).get("__identity__")
                if upd.tables:
                    await self._emit(upd)
        elif kind == "TransactionUpdateLight":
            upd = self._apply(body["update"])
            if upd.tables:
                await self._emit(upd)
        elif kind == "SubscriptionError":
            log.error("[%s] subscription error: %s", self.name, body.get("error"))

    def _apply(self, db_update: dict) -> Update:
        upd = Update(tables={})
        for tu in db_update["tables"]:
            table = self.tables.get(tu["table_name"])
            if table is None:
                continue
            delta = upd.tables.setdefault(table.name, TableDelta())
            for qu in tu["updates"]:
                if "Uncompressed" in qu:  # tolerate the compressable envelope
                    qu = qu["Uncompressed"]
                for raw in qu.get("deletes", []):
                    row = table.decode(raw)
                    table.rows.pop(table.key(row), None)
                    delta.deletes.append(row)
                for raw in qu.get("inserts", []):
                    row = table.decode(raw)
                    table.rows[table.key(row)] = row
                    delta.inserts.append(row)
        return upd

    async def _emit(self, upd: Update) -> None:
        for names, cb in self._listeners:
            if names is None or upd.resync or names & upd.tables.keys():
                try:
                    res = cb(upd)
                    if inspect.isawaitable(res):
                        await res
                except Exception:  # noqa: BLE001 - one bad listener must not kill the socket
                    log.exception("[%s] listener failed", self.name)


class Debouncer:
    """Coalesce bursts of updates into one run of `fn`, at most every
    `min_interval` seconds, always running once more after the last trigger.
    Agents use this so a wind-slider drag triggers a few recomputes, not 60."""

    def __init__(self, fn: Callable[[], Awaitable[None]], delay: float = 0.15, min_interval: float = 0.5):
        self.fn = fn
        self.delay = delay
        self.min_interval = min_interval
        self._dirty = asyncio.Event()
        self._task: asyncio.Task | None = None

    def trigger(self) -> None:
        self._dirty.set()
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        while self._dirty.is_set():
            await asyncio.sleep(self.delay)
            self._dirty.clear()
            started = loop.time()
            try:
                await self.fn()
            except Exception:  # noqa: BLE001
                log.exception("debounced task failed")
            elapsed = loop.time() - started
            if elapsed < self.min_interval:
                await asyncio.sleep(self.min_interval - elapsed)
