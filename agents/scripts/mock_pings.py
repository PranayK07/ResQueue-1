"""Simulated residents pinging for help, for demos and drills: batches of mock help pings in the incident area.

    cd agents && ../venv/bin/python scripts/mock_pings.py                       # 10 pings near the fire
    cd agents && ../venv/bin/python scripts/mock_pings.py --count 6 --reports --cluster
    cd agents && ../venv/bin/python scripts/mock_pings.py --near stations --radius-m 3000 --batches 3 --every 90
    cd agents && ../venv/bin/python scripts/mock_pings.py --near 35.65,-112.72 --radius-m 800 --seed 7

Acts as the `scenario` agent "mock-pings". A batch is one submit_mock_requests call, so one transaction: the planner
pauses once per batch instead of once per ping (send bursts, not a trickle). Each ping is an ordinary request on the
'synthetic' channel with 24 h consent: the commander sees it like any other, no resident's app shows it. Points are
inside the grid and never in a burning cell; where it can, it also avoids cells the forecast fire reaches within the
hour (or was due at already), which the danger engine would mark unreachable.

--reports attaches a canned text report to each ping, written for the intake agent's keyword analyzer (trapped,
injured, smoke, road blocked, flames at a distance, needs) in plain ASCII. --cluster makes the first three pings of the
first batch fire sightings that corroborate each other: within 1 km of one another, inside the spotting radius of the
burning cells, each giving its real distance to them. Text-only sightings move the queue only when two neighbours
report the same. Run the agents with INTAKE_ANALYZER=keywords for readings you can predict. A module without
submit_mock_requests gets the same pings one by one (submit_help_request_for + submit_report).
"""
from __future__ import annotations

import argparse
import asyncio
import math
import random
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rescue.config import settings  # noqa: E402
from rescue.core.geo import M_PER_DEG_LAT, Grid  # noqa: E402
from rescue.stdb import ReducerError, SpacetimeClient  # noqa: E402

NAME = "mock-pings"
TABLES = ["sim_clock", "grid", "station", "fire_cell", "forecast_cell"]
ACTIVE = ("pending", "queued", "assigned", "en_route", "on_scene")
MAX_BATCH = 25  # submit_mock_requests takes 1..25
CONSENT_MIN = 24 * 60  # what submit_mock_requests grants; the one-by-one fallback asks for the same
RADIUS_M = {"fire": 1500.0, "stations": 3000.0, "point": 1000.0}
FIRE_GAP_M = 300.0  # near-fire pings keep at least this far from burning cells
OTHER_GAP_M = 100.0
SPACING_M = 150.0  # between the pings of one run
FORECAST_SAFE_S = 3600.0
CLUSTER_FIRE_M = (350.0, 1300.0)  # inside the 1.5 km spotting radius at calm wind (core.reports.spot_radius_m)
CLUSTER_SPAN_M = 1000.0  # pairwise; the commander corroborates sightings within 1.5 km
SIGHTING_MAX_M = 2000.0  # farther than this from the fire, --reports tells other stories
TRIES = 200  # candidate points per ping
HEADCOUNTS = [1, 1, 2, 2, 3, 4, 5]
NEEDS = ["", "", "", "mobility", "medical", "infant", "elderly", "pets", "mobility,medical"]
# (headcount, needs, report): the form agrees with the text. ASCII apostrophes: a curly one hides "can't". The
# patterns have no word boundaries, so avoid words that contain one: "members" reads as embers, "flashlight" as ash.
REPORTS = [
    (3, "mobility,elderly",
     "We're trapped, my 82-year-old grandmother uses a wheelchair and we have no car. There are 3 of us here."),
    (2, "medical", "My son is hurt, his arm is bleeding. 2 people here."),
    (2, "oxygen", "Thick smoke, hard to breathe. Dad is on an oxygen tank, there are 2 of us."),
    (2, "", "Tree down across the road, we can't drive out. 2 adults here."),
    (3, "infant", "We have a newborn baby and the power is out. 3 people here and the smoke is getting worse."),
    (2, "pets", "We have two dogs and a horse and no trailer. 2 of us."),
    (4, "language", "My mother doesn't speak English. There are 4 of us at home and we need a ride out."),
    (1, "elderly,medical,mobility", "I'm an 86-year-old with a heart condition and I cannot walk far."),
    (2, "", "Power lines down on our street and the road is blocked. 2 of us here."),
]
# Fire sightings; {d} becomes the real distance to the nearest burning cell, so the claim fits the map.
SIGHTINGS = [
    (2, "", "Flames about {d} meters from our house, embers landing in the yard. 2 of us here."),
    (3, "", "I can see the fire from the window, about {d} meters away. We are 3 people and can't get out."),
    (1, "", "The hillside behind us is burning, maybe {d} meters away. Thick smoke, hard to breathe."),
    (3, "mobility", "Fire is close, about {d} meters. 3 of us, one in a wheelchair."),
]

Point = tuple[float, float]  # grid meters: x east, y north of the grid's south-west corner


class Area:
    """The loaded world, in grid meters."""

    def __init__(self, db: SpacetimeClient):
        g, clock = db.table("grid").one(), db.table("sim_clock").one()
        self.grid = Grid.from_row(g) if g else Grid(0.0, 0.0, 0.0, 0, 0)
        self.scenario = clock["scenario"] if clock else "none"
        self.now = float(clock["sim_s"]) if clock else 0.0
        self.ready = self.grid.valid and self.scenario != "none"
        self.burning = {r["cell_id"] for r in db.table("fire_cell")} if self.ready else set()
        self.eta = {r["cell_id"]: r["arrival_early_s"] for r in db.table("forecast_cell")}
        self.stations = sorted(db.table("station"), key=lambda s: s["id"])
        self.fire = [self.center(c) for c in self.burning]
        self.edge = sorted(c for c in self.burning if self.on_edge(c))  # sorted: --seed repeats a run

    def center(self, cell: int) -> Point:
        r, c = self.grid.rc(cell)
        return (c + 0.5) * self.grid.cell_size_m, (r + 0.5) * self.grid.cell_size_m

    def latlon(self, x: float, y: float) -> tuple[float, float]:
        g = self.grid
        return g.origin_lat + y / M_PER_DEG_LAT, g.origin_lon + x / g.m_per_deg_lon

    def xy(self, lat: float, lon: float) -> Point:
        g = self.grid
        return (lon - g.origin_lon) * g.m_per_deg_lon, (lat - g.origin_lat) * M_PER_DEG_LAT

    def on_edge(self, cell: int) -> bool:
        g = self.grid
        r, c = g.rc(cell)
        return any(0 <= r + dr < g.rows and 0 <= c + dc < g.cols and g.cell_id(r + dr, c + dc) not in self.burning
                   for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)))

    def fire_m(self, x: float, y: float) -> float:
        """Distance to the nearest burning cell centre (inf when nothing burns)."""
        return min((math.hypot(fx - x, fy - y) for fx, fy in self.fire), default=math.inf)

    def fire_within(self, x: float, y: float, m: float) -> bool:
        g, s = self.grid, self.grid.cell_size_m
        r0, c0, k = int(y // s), int(x // s), int(m // s) + 1
        return any(g.cell_id(r, c) in self.burning and math.hypot((c + 0.5) * s - x, (r + 0.5) * s - y) < m
                   for r in range(max(0, r0 - k), min(g.rows, r0 + k + 1))
                   for c in range(max(0, c0 - k), min(g.cols, c0 + k + 1)))

    def fits(self, x: float, y: float, gap: float, taken: list[Point], safe: bool) -> bool:
        cell = self.grid.locate(*self.latlon(x, y))
        if cell is None or cell in self.burning or (gap > 0 and self.fire_within(x, y, gap)):
            return False
        if any(math.hypot(x - px, y - py) < SPACING_M for px, py in taken):
            return False
        return not safe or self.eta.get(cell, math.inf) >= self.now + FORECAST_SAFE_S

    def candidate(self, rnd: random.Random, mode: str, radius: float, point: tuple[float, float] | None) -> Point:
        if mode == "random":
            g = self.grid
            return rnd.uniform(0.05, 0.95) * g.cols * g.cell_size_m, rnd.uniform(0.05, 0.95) * g.rows * g.cell_size_m
        if mode == "fire":
            ax, ay = self.center(rnd.choice(self.edge))
            d = rnd.uniform(min(FIRE_GAP_M, radius / 2), radius)
        else:
            if mode == "stations":
                s = rnd.choice(self.stations)
                ax, ay = self.xy(s["lat"], s["lon"])
            else:
                ax, ay = self.xy(*point)
            d = radius * math.sqrt(rnd.random())  # uniform over the disc
        th = rnd.uniform(0.0, 2 * math.pi)
        return ax + d * math.cos(th), ay + d * math.sin(th)

    def place(self, rnd: random.Random, n: int, mode: str, radius: float, point: tuple[float, float] | None,
              taken: list[Point]) -> list[Point]:
        """Up to n new points. The forecast check is dropped only for the points that cannot pass it."""
        out: list[Point] = []
        gap = min(FIRE_GAP_M, radius / 2) if mode == "fire" else OTHER_GAP_M
        for safe in (True, False):
            for _ in range(TRIES * n):
                if len(out) == n:
                    break
                x, y = self.candidate(rnd, mode, radius, point)
                if self.fits(x, y, gap, taken + out, safe):
                    out.append((x, y))
        return out

    def cluster(self, rnd: random.Random, taken: list[Point]) -> list[Point]:
        """Three fire sightings that corroborate each other, or [] if none fit."""
        lo, hi = CLUSTER_FIRE_M
        for safe in (True, False):
            for _ in range(50):
                ax, ay = self.center(rnd.choice(self.edge))
                d, th = rnd.uniform(lo, (lo + hi) / 2), rnd.uniform(0.0, 2 * math.pi)
                first = (ax + d * math.cos(th), ay + d * math.sin(th))
                if not self.sighting(*first, [], taken, safe):
                    continue
                pts = [first]
                for _ in range(200):
                    d, th = rnd.uniform(250.0, 600.0), rnd.uniform(0.0, 2 * math.pi)
                    x, y = first[0] + d * math.cos(th), first[1] + d * math.sin(th)
                    if self.sighting(x, y, pts, taken, safe):
                        pts.append((x, y))
                        if len(pts) == 3:
                            return pts
        return []

    def sighting(self, x: float, y: float, pts: list[Point], taken: list[Point], safe: bool) -> bool:
        lo, hi = CLUSTER_FIRE_M
        return (all(math.hypot(x - px, y - py) <= CLUSTER_SPAN_M for px, py in pts)
                and self.fits(x, y, lo, taken + pts, safe) and self.fire_m(x, y) <= hi)


def meters(d: float) -> int:
    return max(50, round(d / 50) * 50)


def build(area: Area, a: argparse.Namespace, rnd: random.Random, cluster: bool) -> tuple[list[dict], list[str], str]:
    """One batch: (pings for submit_mock_requests, one line per ping, where they went)."""
    mode, point = a.near
    why = ""
    if mode == "fire" and not area.edge:
        mode, why = "random", " (nothing is burning)"
    elif mode == "stations" and not area.stations:
        mode, why = "random", " (no stations)"
    elif mode == "point" and area.grid.locate(*point) is None:
        return [], [], f"around {point[0]},{point[1]}, which is outside the grid"
    radius = a.radius_m or RADIUS_M.get(mode, 0.0)
    if mode == "fire":
        where = f"{min(FIRE_GAP_M, radius / 2):.0f}-{radius:.0f} m from the fire"
    elif mode == "stations":
        where = f"within {radius:.0f} m of the stations"
    elif mode == "point":
        where = f"within {radius:.0f} m of {point[0]:.5f},{point[1]:.5f}"
    else:
        where = "anywhere in the grid"
    where += why
    sightings = area.cluster(rnd, []) if cluster and area.edge else []
    if cluster:
        where += ", with a cluster of 3 fire sightings" if sightings else ", no room for a cluster of fire sightings"
    points = sightings + area.place(rnd, a.count - len(sightings), mode, radius, point, sightings)
    if 0 < len(points) < a.count:
        where += f" (only {len(points)} of {a.count} fit)"

    pings, lines = [], []
    for i, (x, y) in enumerate(points):
        lat, lon = area.latlon(x, y)
        near = area.fire_m(x, y)
        if i < len(sightings):
            n, needs, text = SIGHTINGS[i]
        elif a.reports:
            n, needs, text = rnd.choice(SIGHTINGS if near <= SIGHTING_MAX_M and rnd.random() < 0.4 else REPORTS)
        else:
            n, needs, text = rnd.choice(HEADCOUNTS), rnd.choice(NEEDS), ""
        report = text.replace("{d}", str(meters(near))) if math.isfinite(near) else text
        pings.append({"lat": lat, "lon": lon, "headcount": n, "needs": needs, "note": "", "report": report})
        who = f"{n} {'person' if n == 1 else 'people'}" + (f", {needs}" if needs else "")
        fire = f"{near:5.0f} m from fire" if math.isfinite(near) else "no fire"
        said = f'  "{report[:56]}{"..." if len(report) > 56 else ""}"' if report else ""
        lines.append(f"  {i + 1:2}. {lat:.5f},{lon:.5f}  {who:<26} {fire}{said}")
    return pings, lines, where


def unknown_reducer(e: ReducerError) -> bool:
    msg = e.message.lower()
    return "no such reducer" in msg or (e.status == 404 and "reducer" in msg)


async def file_batch(db: SpacetimeClient, pings: list[dict], legacy: bool) -> tuple[int, bool]:
    """Send one batch. Returns (pings filed, whether the module is older and they went one by one)."""
    if not legacy:
        try:
            await db.call("submit_mock_requests", pings)
            return len(pings), False
        except ReducerError as e:
            if not unknown_reducer(e):
                raise
            print("  this module has no submit_mock_requests (republish it to file a batch in one transaction); "
                  "sending them one by one")
    run, filed = int(time.time() * 1e6), []
    for i, p in enumerate(pings):
        ref = f"mock:{run}:{i}"
        try:
            await db.call("submit_help_request_for", ref, "synthetic", p["lat"], p["lon"], p["headcount"], p["needs"],
                          p["note"], CONSENT_MIN)
            filed.append((ref, p["report"]))
        except ReducerError as e:
            print(f"  ping {i + 1} rejected: {e.message}")
    if any(text for _, text in filed):
        # The reducer returns nothing, so look the ids up (as the caller: a scenario agent sees every request).
        try:
            rows = await db.sql("SELECT * FROM ops_request")
        except ReducerError as e:
            print(f"  cannot look the new requests up, so no reports were sent: {e.message}")
            rows = []
        ids = {r["external_ref"]: r["id"] for r in rows if r["status"] in ACTIVE}
        for ref, text in filed:
            if text and ref in ids:
                try:
                    await db.call("submit_report", ids[ref], ref, "text", text, "", "")
                except ReducerError as e:
                    print(f"  report for #{ids[ref]} rejected: {e.message}")
    return len(filed), True


async def check_mesh(db: SpacetimeClient) -> None:
    """Say (don't wait) when the agents that read, queue and serve the pings are not running."""
    clock = db.table("sim_clock").one()
    now = clock["last_tick"] if clock else int(time.time() * 1e6)
    try:
        rows = await db.sql("SELECT * FROM agent")
    except (ReducerError, httpx.HTTPError):
        return
    fresh = {r["name"] for r in rows if now - r["last_seen"] < 45e6}
    for name, why in (("intake", "reports are read once it runs"), ("commander", "nothing is queued until it runs"),
                      ("sim-crews", "dispatched units will not move")):
        if name not in fresh:
            print(f"  note: agent {name} is not running ({why})")


def count_arg(text: str) -> int:
    n = int(text)
    if not 1 <= n <= MAX_BATCH:
        raise argparse.ArgumentTypeError(f"1..{MAX_BATCH} pings per batch")
    return n


def positive(text: str) -> float:
    v = float(text)
    if not 0 < v < 1e6:
        raise argparse.ArgumentTypeError("must be a positive number")
    return v


def near_arg(text: str) -> tuple[str, tuple[float, float] | None]:
    if text in ("fire", "stations", "random"):
        return text, None
    try:
        lat, lon = (float(v) for v in text.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError("fire, stations, random or LAT,LON") from None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise argparse.ArgumentTypeError(f"not a location: {text}")
    return "point", (lat, lon)


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--count", type=count_arg, default=10, help=f"pings per batch, 1..{MAX_BATCH} (default 10)")
    ap.add_argument("--batches", type=int, default=1, help="how many batches (default 1)")
    ap.add_argument("--every", type=float, default=60.0, help="real seconds between batches (default 60)")
    ap.add_argument("--near", type=near_arg, default=("fire", None), metavar="fire|stations|random|LAT,LON",
                    help="near the burning cells (default), around the stations, anywhere in the grid, or around a "
                         "point (write --near=LAT,LON when LAT is negative)")
    ap.add_argument("--radius-m", type=positive,
                    help="how far out: from the burning cells (default 1500), the stations (3000), or LAT,LON (1000)")
    ap.add_argument("--reports", action="store_true", help="attach a canned text report to each ping")
    ap.add_argument("--cluster", action="store_true",
                    help="make the first batch's first three pings fire sightings that corroborate each other")
    ap.add_argument("--seed", type=int, help="random seed (printed, so a run can be repeated)")
    a = ap.parse_args()
    if a.batches < 1:
        ap.error("--batches must be 1 or more")
    if not 0 <= a.every < 1e6:
        ap.error("--every must be 0 or more seconds")
    if a.cluster and a.count < 3:
        ap.error("--cluster needs --count 3 or more")
    seed = a.seed if a.seed is not None else random.randrange(1_000_000)
    rnd = random.Random(seed)

    db = SpacetimeClient(NAME)
    detail = "starting"

    async def heartbeat() -> None:  # the console lists mock-pings with the mesh while batches are still to come
        while True:
            await asyncio.sleep(10.0)
            await db.try_call("agent_heartbeat", "online", detail[:200])

    beat: asyncio.Task | None = None
    try:
        try:
            await db.call("register_agent", settings.agent_join_key, "scenario", NAME, 0, "")
            await db.connect([f"SELECT * FROM {t}" for t in TABLES])
        except ReducerError as e:
            sys.exit(f"{e.reducer} rejected: {e.message}")
        except (httpx.HTTPError, OSError) as e:
            sys.exit(f"cannot reach {db.db} at {db.http}: {str(e) or type(e).__name__}")
        area = Area(db)
        if not area.ready:
            sys.exit("no scenario is loaded (the grid is empty): run scripts/dev.sh first")
        print(f"mock pings -> {db.db} ({db.http}): scenario {area.scenario}, seed {seed}")
        await check_mesh(db)
        beat = asyncio.create_task(heartbeat())
        legacy, total = False, 0
        for b in range(1, a.batches + 1):
            if b > 1:
                await asyncio.sleep(a.every)
                area = Area(db)
            head = f"batch {b}/{a.batches} at T+{area.now / 3600:.2f} h"
            if not area.ready:
                print(f"{head}: skipped, no scenario is loaded")
                continue
            pings, lines, where = build(area, a, rnd, cluster=a.cluster and b == 1)
            if not pings:
                print(f"{head}: no point fits {where}")
                continue
            try:
                filed, legacy = await file_batch(db, pings, legacy)
            except ReducerError as e:
                print(f"{head}: rejected: {e.message}")
                continue
            except httpx.HTTPError as e:
                print(f"{head}: not sent: {str(e) or type(e).__name__}")
                continue
            total += filed
            detail = f"{head}: {filed} pings {where}"
            lost = f", {len(pings) - filed} rejected" if filed < len(pings) else ""
            print(f"{detail}{' (one by one)' if legacy else ''}{lost}")
            print("\n".join(lines))
            await db.try_call("agent_heartbeat", "online", detail[:200])
        detail = f"done: {total} pings in {a.batches} batch{'' if a.batches == 1 else 'es'}"
        await db.try_call("agent_heartbeat", "online", detail)
        print(detail)
    finally:
        if beat:
            beat.cancel()
        await db.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
