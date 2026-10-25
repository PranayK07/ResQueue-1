"""Simulated crews: drive every dispatched unit through its mission, as the station crews would.

    cd agents && ../venv/bin/python scripts/sim_crews.py                # every station (run_all starts this)
    cd agents && ../venv/bin/python scripts/sim_crews.py --stations 2   # leave station 1's units to people
    cd agents && ../venv/bin/python scripts/sim_crews.py --dwell-s 120 --once

Run one driver at a time: to start your own (say with --stations), run the mesh with SIM_CREWS=0.

Nothing in the backend moves units: publish_plan only marks one `assigned`. This driver reads the plan back from the
database and calls the lifecycle reducers at the sim times it implies:

    assigned   -> unit_en_route(arrive, free)            travel: ops_travel, else the queue ETA, else a straight line
    en_route   -> unit_position(request), unit_on_scene  once sim time reaches the queue ETA
    on_scene   -> complete_mission(rescued)              after the request's on-scene time (or --dwell-s), unless a
                                                         responder phone has the unit open: then its crew decides
    returning  -> unit_available(station)                at free_at_s (arrival + on scene + the drive back)

Units are written only at these steps, never streamed: every risk card is stamped with all units' updated_at and
the planner waits for current risk after each unit write, so the map animates the drive in the browser instead.
The schedule lives in the database, so a restart picks up where the last run stopped. Acts as the `scenario` agent
"sim-crews" and heartbeats like the mesh agents, so the console can tell whether units will move.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from collections import Counter
from pathlib import Path
from typing import NamedTuple

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rescue.config import STATE_DIR, settings  # noqa: E402
from rescue.core.geo import haversine_m  # noqa: E402
from rescue.core.slack import extract_time_s  # noqa: E402
from rescue.stdb import Debouncer, ReducerError, SpacetimeClient  # noqa: E402

NAME = "sim-crews"
TABLES = ["sim_clock", "grid", "station", "unit", "ops_queue", "ops_request", "ops_travel"]
WATCH = ["sim_clock", "unit", "ops_queue", "crew_presence"]
SAFETY_S = 2.0  # step at least this often, even when no update arrives
HEARTBEAT_S = 10.0  # as the mesh agents; the console calls an agent stale after 45 s
CREWED_S = 45.0  # a responder phone heartbeats about every 20 s while it shows its unit
PENDING_S = 15.0  # a step whose result has not reached the replica by then may be sent again
RETRY_S, RETRY_MAX_S = 5.0, 60.0  # backoff after a rejected call
ROAD_MPS, DETOUR = 12.0, 1.35  # core.routing.RoadParams, for the straight-line fallback
NO_ROUTE_S = 1e8  # danger publishes 1e9 when there is no safe ground route
AT_STATION_M = 100.0
LABELS = {"assigned": "dispatched", "en_route": "en route", "on_scene": "on scene", "returning": "returning",
          "available": "available", "out_of_service": "out of service"}

log = logging.getLogger(NAME)

Key = tuple[int, str, int]  # (unit id, status, current request): one step of one mission


class Move(NamedTuple):
    calls: list[tuple]  # (reducer, *args), sent in order
    note: str


def key(u: dict) -> Key:
    return u["id"], u["status"], u["current_request"]


def mins(s: float) -> str:
    return f"{s / 60:.1f} min"


class Crews:
    """One session: registered, subscribed, stepping. A new session replaces it when the agent row disappears."""

    def __init__(self, a: argparse.Namespace):
        self.a = a
        STATE_DIR.mkdir(exist_ok=True)  # `scripts/dev.sh reset` deletes it, even under a running driver
        self.db = SpacetimeClient(NAME)
        self.lock = asyncio.Lock()
        self.closed = False
        self.lost = asyncio.Event()  # our agent row is gone (database wiped): register again in a new session
        self.tasks: list[asyncio.Task] = []
        self.pending: dict[Key, float] = {}  # step -> loop time before which it is not sent again
        self.failures: dict[Key, int] = {}
        self.since: dict[Key, float] = {}  # step -> sim time this driver first saw it (if the queue row is missing)
        self.world = ("", 0.0)  # (scenario, sim_s) at the last step, to notice a reload
        self.status, self.detail = "online", "starting"
        self.failed_at = -1e9
        self.notes: list[str] = []
        self.moved: list[str] = []

    async def start(self) -> None:
        # Register before subscribing, so the views are scoped to the scenario role from the first sync.
        await self.db.call("register_agent", settings.agent_join_key, "scenario", NAME, 0, "")
        tables = TABLES + (["crew_presence"] if await self.has("crew_presence") else [])
        if "crew_presence" not in tables:
            log.warning("this module has no crew_presence table: units with a responder phone open are completed too")
        await self.db.connect([f"SELECT * FROM {t}" for t in tables])

    async def has(self, table: str) -> bool:
        try:
            await self.db.sql(f"SELECT * FROM {table} LIMIT 0")
            return True
        except ReducerError:
            return False

    async def run(self) -> None:
        """Step on every relevant update (debounced) and every SAFETY_S; return when the registration is lost."""
        deb = Debouncer(self.step, delay=0.2, min_interval=1.0)
        self.db.on_update(WATCH, lambda _u: deb.trigger())
        deb.trigger()
        self.tasks = [asyncio.create_task(self.tick(deb)), asyncio.create_task(self.heartbeat())]
        await self.lost.wait()

    async def tick(self, deb: Debouncer) -> None:
        while True:
            await asyncio.sleep(SAFETY_S)
            deb.trigger()

    async def heartbeat(self) -> None:
        await asyncio.sleep(1.0)  # after the first step, so the console gets a real detail line
        while True:
            await self.call("agent_heartbeat", self.status, self.detail[:200])
            await asyncio.sleep(HEARTBEAT_S)

    async def close(self) -> None:
        self.closed = True
        for t in self.tasks:
            t.cancel()
        async with self.lock:  # a step in progress finishes its calls first
            await self.db.close()

    async def call(self, reducer: str, *args) -> bool:
        try:
            await self.db.call(reducer, *args)
            return True
        except ReducerError as e:
            if "requires" in e.message or "not a registered agent" in e.message:
                self.lost.set()  # e.g. the module was published with --delete-data
            log.warning("%s rejected: %s", reducer, e.message)
        except httpx.HTTPError as e:
            log.warning("%s: %s", reducer, str(e) or type(e).__name__)
        self.failed_at = asyncio.get_running_loop().time()
        return False

    async def step(self) -> None:
        async with self.lock:
            if not self.closed:
                await self._step()

    async def _step(self) -> None:
        db, loop = self.db, asyncio.get_running_loop()
        clock, grid = db.table("sim_clock").one(), db.table("grid").one()
        if not clock or not grid or clock["scenario"] == "none" or not grid["rows"]:
            self.status, self.detail, self.notes = "online", "waiting for a scenario", []
            return
        now = float(clock["sim_s"])
        if clock["scenario"] != self.world[0] or now < self.world[1] - 1.0:  # reloaded: new units, time from 0
            self.pending.clear()
            self.failures.clear()
            self.since.clear()
        self.world = (clock["scenario"], now)
        stations = {s["id"]: s for s in db.table("station")}
        presence = db.tables.get("crew_presence")
        crewed = {p["unit_id"] for p in (presence or []) if clock["last_tick"] - p["seen_at"] < CREWED_S * 1e6}
        units = sorted(db.table("unit"), key=lambda u: u["id"])
        mine = [u for u in units if not self.a.stations or u["station_id"] in self.a.stations]
        live, t = {key(u) for u in units}, loop.time()
        self.pending = {k: until for k, until in self.pending.items() if k in live and until > t}
        self.failures = {k: n for k, n in self.failures.items() if k in live}
        self.since = {k: s for k, s in self.since.items() if k in live}

        moves = [(u, self.plan(u, now, stations, crewed)) for u in mine]
        self.notes = [f"{u['callsign']}: {m.note}" for u, m in moves]
        self.moved = []
        for u, m in moves:  # every due step in one burst, so the planner pauses once
            k = key(u)
            if not m.calls or k in self.pending:
                continue
            self.pending[k] = loop.time() + PENDING_S  # replica lag must not send the same step twice
            for reducer, *args in m.calls:
                row = db.table("unit").get(u["id"])
                if self.closed or not row or key(row) != k:
                    break  # changed under us (released, reloaded): the next step plans it afresh
                if not await self.call(reducer, *args):
                    n = self.failures[k] = self.failures.get(k, 0) + 1
                    self.pending[k] = loop.time() + min(RETRY_MAX_S, RETRY_S * 2 ** (n - 1))
                    break
            else:
                self.moved.append(f"{u['callsign']} {m.note}")
                log.info("%s %s", u["callsign"], m.note)
        self.detail = self.summary(mine, crewed)
        self.status = "degraded" if loop.time() - self.failed_at < 30.0 else "online"

    def plan(self, u: dict, now: float, stations: dict[int, dict], crewed: set[int]) -> Move:
        """The step this unit is due for now (no calls if none), and a line saying where it stands."""
        uid, rid, status = u["id"], u["current_request"], u["status"]
        req = self.db.table("ops_request").get(rid) if rid else None
        q = self.db.table("ops_queue").get(rid) if rid else None
        st = stations.get(u["station_id"])
        first = self.since.setdefault(key(u), now)
        if rid and not req:
            return Move([], f"waiting for request #{rid} to reach the replica")
        if status == "assigned" and req:
            travel = self.travel(u, req, q, st, now)
            arrive = now + travel
            free = arrive + self.dwell(req) + travel  # back at the station, as the planner's timeline assumes
            return Move([("unit_en_route", uid, float(arrive), float(free))],
                        f"en route to #{rid}: on scene in {mins(travel)}, back at the station in {mins(free - now)}")
        if status == "en_route" and req:
            eta = q["eta_s"] if q else first + self.travel(u, req, None, st, first)
            if now < eta:
                return Move([], f"en route to #{rid}, on scene in {mins(eta - now)}")
            # One position write, so the map shows the unit at the scene and the drive back starts there.
            there = haversine_m(u["lat"], u["lon"], req["lat"], req["lon"]) < 1.0
            calls = [] if there else [("unit_position", uid, float(req["lat"]), float(req["lon"]))]
            return Move(calls + [("unit_on_scene", uid)], f"on scene at #{rid}")
        if status == "on_scene" and req:
            if uid in crewed:
                return Move([], f"on scene at #{rid}: its responder phone decides when it is done")
            done = (q["eta_s"] if q else first) + self.dwell(req)
            if now < done:
                return Move([], f"on scene at #{rid}, done in {mins(done - now)}")
            return Move([("complete_mission", uid, "rescued")], f"rescued #{rid}, driving back")
        home = st is not None and haversine_m(u["lat"], u["lon"], st["lat"], st["lon"]) < AT_STATION_M
        back = [("unit_available", uid, float(st["lat"]), float(st["lon"]))] if st else []
        if status == "returning" and st and not rid:
            # A unit still at home ("can't reach" before it left) is back in service now: free_at_s counts the
            # whole mission it never drove.
            if not home and 0 < now < u["free_at_s"]:
                return Move([], f"returning, back at {st['name']} in {mins(u['free_at_s'] - now)}")
            return Move(back, f"back in service at {st['name']}")
        if status == "available" and st and not rid and not home:
            # Released away from home (the request closed, or the crew declined, on scene).
            return Move(back, f"released, back at {st['name']}")
        return Move([], LABELS.get(status, status))

    def travel(self, u: dict, req: dict, q: dict | None, st: dict | None, now: float) -> float:
        """Station -> request in sim seconds: the danger engine's route, else the plan's ETA, else a straight line."""
        tr = self.db.table("ops_travel").get(req["id"] * 1024 + u["station_id"])
        if tr and tr["reachable"] and 0 <= tr["travel_s"] < NO_ROUTE_S:
            return float(tr["travel_s"])
        if q and q["eta_s"] - now < NO_ROUTE_S:
            return max(60.0, q["eta_s"] - now)
        if st:
            return haversine_m(st["lat"], st["lon"], req["lat"], req["lon"]) * DETOUR / ROAD_MPS
        return 600.0

    def dwell(self, req: dict) -> float:
        if self.a.dwell_s is not None:
            return self.a.dwell_s
        return req["extract_s"] if req["extract_s"] > 0 else extract_time_s(req["headcount"], req["needs"])

    def summary(self, units: list[dict], crewed: set[int]) -> str:
        n = Counter(u["status"] for u in units)
        parts = [f"{n[s]} {label}" for s, label in LABELS.items() if n[s]]
        parts += [f"{c} {s}" for s, c in n.items() if s not in LABELS]
        text = f"{len(units)} unit{'' if len(units) == 1 else 's'}: {', '.join(parts)}" if units else "no units"
        if self.a.stations:
            text = f"stations {','.join(map(str, sorted(self.a.stations)))}: {text}"
        if phones := [u["callsign"] for u in units if u["id"] in crewed]:
            text += f"; responder phone on {', '.join(phones)}"
        return text


async def once(a: argparse.Namespace) -> None:
    crews = Crews(a)
    try:
        await crews.start()
        await crews.step()
        clock = crews.db.table("sim_clock").one()
        print(f"{NAME} on {crews.db.db} ({crews.db.http}): {crews.detail}")
        if clock:
            print(f"  scenario {clock['scenario']}, T+{clock['sim_s'] / 3600:.2f} h, "
                  f"{'running' if clock['running'] else 'paused'} at {clock['speed']:g}x")
        for line in crews.notes:
            print(f"  {line}")
        print(f"  {len(crews.moved)} step(s) sent" + (f": {'; '.join(crews.moved)}" if crews.moved else ""))
    except (ReducerError, httpx.HTTPError, OSError) as e:
        sys.exit(f"{NAME}: cannot join {crews.db.db} at {crews.db.http}: {str(e) or type(e).__name__}")
    finally:
        await crews.close()


async def supervise(a: argparse.Namespace) -> None:
    """Sessions back to back: a new one registers again (after the database was wiped) and resubscribes."""
    loop, delay = asyncio.get_running_loop(), 1.0
    while True:
        crews, began = Crews(a), loop.time()
        try:
            await crews.start()
            log.info("driving %s on %s (%s)", f"stations {','.join(map(str, sorted(a.stations)))}" if a.stations
                     else "every station", crews.db.db, crews.db.http)
            await crews.run()
            log.warning("the agent registration is gone (database wiped?): registering again")
        except (ReducerError, httpx.HTTPError, OSError) as e:
            log.warning("cannot join %s at %s: %s", crews.db.db, crews.db.http, str(e) or type(e).__name__)
        except Exception:  # noqa: BLE001 - keep the units moving; run_all would only restart us
            log.exception("session failed")
        finally:
            await crews.close()
        delay = 1.0 if loop.time() - began > 60 else min(delay * 2, 30.0)
        await asyncio.sleep(delay)


def station_ids(text: str) -> set[int]:
    try:
        ids = {int(x) for x in text.split(",") if x.strip()}
    except ValueError:
        ids = set()
    if not ids:
        raise argparse.ArgumentTypeError(f"expected station ids like 1,2 (got {text!r})")
    return ids


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stations", type=station_ids, help="drive only these stations' units, e.g. 1,2 (default: all)")
    ap.add_argument("--dwell-s", type=float,
                    help="on-scene time in sim seconds for every mission (default: each request's extract time)")
    ap.add_argument("--once", action="store_true",
                    help="one step, print every unit's state, then exit (debugging; stop the running driver first)")
    a = ap.parse_args()
    if a.dwell_s is not None and not 0 <= a.dwell_s < 1e7:
        ap.error("--dwell-s must be a number of sim seconds, 0 or more")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per reducer call drowns out the missions
    await (once(a) if a.once else supervise(a))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
