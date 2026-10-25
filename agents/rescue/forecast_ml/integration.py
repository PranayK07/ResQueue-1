"""Isolated recorded-fire -> risk -> existing danger -> Lookahead -> DB demo.

Only synthetic residents and an explicitly named loopback database are allowed.
Historical UTC risk never becomes minute-level dispatch ground truth. Main's
native grid is separately populated by geographic lookup of observed centers;
its existing three-hour physics supplies route timing. This is a contract demo,
not a dynamic mission/handoff simulator or a real emergency service.
"""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import asdict
import json
import math
from urllib.parse import urlparse

import numpy as np

from ..core.danger import assess_requests
from ..core.fire import Ensemble, FUEL_SEED, FuelMap, Wind, ensemble_arrival
from ..core.geo import Grid, M_PER_DEG_LAT
from ..core.policy import LookaheadPolicy, evaluate
from ..planning import build_plan_input, plan_to_reducer_args, validate_plan
from .bridge import risk_arguments
from .data import grid_from_record, load_dataset, load_sequence
from .evaluation import primary_pairs
from .provenance import atomic_json
from .risk import ForecastProduct, assess_residents, synthetic_residents


def make_demo(product, residents):
    """Use the existing native routing grid; remap observation centers explicitly."""
    geo = np.array([product.grid.center(i) for i in range(product.grid.size)])
    south, west = geo.min(axis=0)
    north, east = geo.max(axis=0)
    m_lon = M_PER_DEG_LAT * math.cos(math.radians(south))
    mpp = math.ceil(max((north - south) * M_PER_DEG_LAT, (east - west) * m_lon) / 126 / 10) * 10
    world = Grid(south - mpp / M_PER_DEG_LAT, west - mpp / m_lon, mpp, 128, 128)
    burning = {world.locate(*geo[i]) for i in np.flatnonzero(product.observed)} - {None}
    if any(world.locate(r["lat"], r["lon"]) is None for r in residents):
        raise ValueError("historical request outside explicitly remapped demonstration grid")
    safe = [i for i in (0, world.cols - 1, world.size - world.cols, world.size - 1) if i not in burning]
    if len(safe) < 2:
        raise ValueError("no two safe synthetic station corners; commander review")
    stations = [
        {
            "id": i + 1,
            "name": f"Synthetic station {i + 1}",
            "lat": world.center(cid)[0],
            "lon": world.center(cid)[1],
        }
        for i, cid in enumerate((safe[0], safe[-1]))
    ]
    units = [
        {
            "id": i + 1,
            "station_id": i // 2 + 1,
            "callsign": f"SIM-{i + 1}",
            "kind": "ambulance",
            "capacity": 8,
            "status": "available",
            "free_at_s": 0.0,
        }
        for i in range(4)
    ]
    return world, burning, stations, units


def physical_plan(world, burning, residents, stations, units, *, wind=Wind(0, 0), requests=None, queue=()):
    """The unchanged danger/planning functions used by live agents, in sim seconds."""
    p10, p50 = ensemble_arrival(
        world,
        FuelMap.uniform(world, seed=FUEL_SEED),
        {i: 0.0 for i in burning},
        wind,
        now_s=0.0,
        horizon_s=10800.0,
        ens=Ensemble(members=16),
    )
    forecast = {int(i): float(p10.flat[i]) for i in np.flatnonzero(np.isfinite(p10)) if i not in burning}
    points = [(r["request_id"], r["lat"], r["lon"], r["headcount"], r["needs"]) for r in residents]
    assessments, travel = assess_requests(
        world, 0.0, points, [(s["id"], s["lat"], s["lon"]) for s in stations], forecast, burning, []
    )
    by_id = {a["request_id"]: a for a in assessments}
    if requests is None:
        requests = [
            {
                "id": r["request_id"],
                "headcount": r["headcount"],
                "needs": r["needs"],
                "status": "pending",
                "location_purged": False,
                "pinned_station_id": 0,
                "created_sim_s": 0.0,
                **{k: v for k, v in by_id[r["request_id"]].items() if k != "request_id"},
            }
            for r in residents
        ]
    else:
        requests = [
            {**r, **{k: v for k, v in by_id.get(r["id"], {}).items() if k != "request_id"}} for r in requests
        ]
    inp = build_plan_input(0.0, requests, travel, units, stations, queue=queue)
    plan, problems = validate_plan(inp, LookaheadPolicy().plan(inp))
    if problems:
        raise ValueError(f"Lookahead contract problems: {problems}")
    cells = [
        {
            "cell_id": i,
            "arrival_early_s": t,
            "arrival_median_s": float(p50.flat[i]) if math.isfinite(p50.flat[i]) else 10800.0,
        }
        for i, t in forecast.items()
    ]
    return {
        "input": inp,
        "plan": plan,
        "forecast": cells,
        "assessments": assessments,
        "travel": travel,
        "static_extraction_projection": asdict(evaluate(inp, plan)),
        "completed_handoffs": None,
        "handoff_reason": "station agents are stubs; no execution/handoff simulator on this main baseline",
    }


async def publish_demo(product, grid_record, residents, *, server, database):
    """Real reducer/subscription test, guarded against any shared/cloud target."""
    from ..stdb import ReducerError, SpacetimeClient

    parsed = urlparse(server)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("demonstration may write only an explicit loopback server")
    if not database.startswith("wrq-codex-"):
        raise ValueError("isolated Codex database name must start wrq-codex-")
    world, burning, stations, units = make_demo(product, residents)
    clients = []

    def client(name):
        result = SpacetimeClient(f"supervised-demo-{name}", http=server, db=database)
        clients.append(result)
        return result

    command, hazard, danger, delegation = [client(n) for n in ("command", "hazard", "danger", "delegation")]
    checks = {}
    try:
        await command.call("claim_operator", "codex-isolated-fixture", "commander", 0, "Synthetic commander")
        await command.call(
            "load_scenario",
            "Codex historical contract demo",
            world.origin_lat,
            world.origin_lon,
            world.cell_size_m,
            world.rows,
            world.cols,
            stations,
            [{k: u[k] for k in ("id", "station_id", "callsign", "kind", "capacity")} for u in units],
            1.0,
            0.0,
            0.0,
        )
        for c, role in ((hazard, "hazard"), (danger, "danger"), (delegation, "delegation")):
            await c.call("register_agent", "codex-isolated-fixture", role, f"Synthetic {role}", 0, "")
        await command.connect(
            ["SELECT * FROM ops_request", "SELECT * FROM ops_queue", "SELECT * FROM fire_risk_meta"]
        )
        await hazard.call(
            "upsert_fire_cells",
            [{"cell_id": i, "ignited_s": 0.0, "intensity": 1.0} for i in sorted(burning)],
            False,
            "sim",
        )
        versions = (await hazard.sql("SELECT * FROM world_version"))[0]
        args = risk_arguments(product, grid_record, versions, 0.0)
        await hazard.call("publish_fire_risk", *args, timeout=90.0)
        registered, actual = [], []
        for index, r in enumerate(residents):
            c = client(f"resident-{index}")
            await c.call(
                "submit_help_request", r["lat"], r["lon"], r["headcount"], r["needs"], "Synthetic fixture", 15
            )
            cards = await c.sql("SELECT * FROM my_requests")
            active = [
                card
                for card in cards
                if card["status"] in {"pending", "queued", "assigned", "en_route", "on_scene"}
            ]
            assert len(active) == 1
            actual.append({**r, "request_id": active[0]["request_id"]})
            registered.append(c)
        await registered[0].connect(["SELECT * FROM my_requests"])
        checks["resident_view_scoped"] = len(list(registered[0].table("my_requests"))) >= 1 and all(
            row["request_id"] == actual[0]["request_id"]
            for row in registered[0].table("my_requests")
            if row["status"] in {"pending", "queued", "assigned"}
        )
        checks["hazard_cannot_read_people"] = not await hazard.sql("SELECT * FROM ops_request")
        initial = physical_plan(world, burning, actual, stations, units)
        await hazard.call(
            "publish_forecast",
            versions["weather"],
            versions["fire"],
            0.0,
            10800.0,
            16,
            initial["forecast"],
            timeout=90.0,
        )
        await danger.call("publish_danger", initial["assessments"], initial["travel"])
        await delegation.call("publish_plan", *plan_to_reducer_args(initial["plan"]))
        before = await command.sql("SELECT * FROM ops_queue")
        checks["plan_published"] = len(before) == len(initial["plan"].entries)
        responder = client("station-view")
        await responder.call(
            "claim_operator", "codex-isolated-fixture", "responder", 1, "Synthetic responder"
        )
        scoped_queue = await responder.sql("SELECT * FROM ops_queue")
        scoped_requests = await responder.sql("SELECT * FROM ops_request")
        checks["station_views_scoped"] = {q["request_id"] for q in scoped_queue} == {
            q["request_id"] for q in before if q["station_id"] == 1
        } and {r["id"] for r in scoped_requests} == {q["request_id"] for q in scoped_queue}
        assigned_units = [u for u in await command.sql("SELECT * FROM unit") if u["current_request"]]
        if assigned_units:
            first_unit = assigned_units[0]
            station_actor = client("station-lifecycle")
            await station_actor.call(
                "register_agent",
                "codex-isolated-fixture",
                "station",
                "Synthetic crew",
                first_unit["station_id"],
                "",
            )
            await station_actor.call("unit_en_route", first_unit["id"], 300.0, 1800.0)
            checks["en_route_status_receipt"] = (
                next(u for u in await command.sql("SELECT * FROM unit") if u["id"] == first_unit["id"])[
                    "status"
                ]
                == "en_route"
            )
        else:
            checks["en_route_status_receipt"] = False
        if before:
            pinned = before[0]
            await command.call(
                "override_assignment", pinned["request_id"], pinned["station_id"], "Synthetic commander pin"
            )
        committed = {
            u["id"]: u["current_request"]
            for u in await command.sql("SELECT * FROM unit")
            if u["current_request"]
        }
        await command.call("set_weather", 8.0, 90.0, 8.0, "synthetic")
        try:
            await hazard.call(
                "publish_forecast",
                versions["weather"],
                versions["fire"],
                0.0,
                10800.0,
                16,
                initial["forecast"],
                timeout=90.0,
            )
            checks["stale_physical_forecast_rejected"] = False
        except ReducerError as exc:
            checks["stale_physical_forecast_rejected"] = "stale physical forecast snapshot" in str(exc)
        try:
            await hazard.call("publish_fire_risk", *args, timeout=90.0)
            checks["stale_snapshot_rejected"] = False
        except ReducerError as exc:
            checks["stale_snapshot_rejected"] = "stale risk snapshot" in str(exc)
        updated_requests = await command.sql("SELECT * FROM ops_request")
        updated_units = await command.sql("SELECT * FROM unit")
        changed = physical_plan(
            world,
            burning,
            actual,
            stations,
            updated_units,
            wind=Wind(8.0, 90.0),
            requests=updated_requests,
            queue=before,
        )
        v2 = (await hazard.sql("SELECT * FROM world_version"))[0]
        try:
            await hazard.call(
                "publish_fire_risk", *risk_arguments(product, grid_record, v2, -1.0), timeout=90.0
            )
            checks["stale_clock_rejected"] = False
        except ReducerError as exc:
            checks["stale_clock_rejected"] = "stale risk snapshot" in str(exc)
        await hazard.call(
            "publish_forecast", v2["weather"], v2["fire"], 0.0, 10800.0, 16, changed["forecast"], timeout=90.0
        )
        await danger.call("publish_danger", changed["assessments"], changed["travel"])
        await delegation.call("publish_plan", *plan_to_reducer_args(changed["plan"]))
        after = await command.sql("SELECT * FROM ops_queue")
        checks["committed_missions_preserved"] = all(
            u["current_request"] == committed[u["id"]]
            for u in await command.sql("SELECT * FROM unit")
            if u["id"] in committed
        )
        checks["pin_preserved"] = not before or any(
            q["request_id"] == pinned["request_id"] and q["station_id"] == pinned["station_id"] for q in after
        )
        checks["no_duplicate_queue_requests"] = len(after) == len({q["request_id"] for q in after})
        revoked_id = actual[-1]["request_id"]
        await registered[-1].call("close_my_request", revoked_id, "", "revoked")
        closed = next(r for r in await command.sql("SELECT * FROM ops_request") if r["id"] == revoked_id)
        checks["consent_withdrawal_purges_location"] = (
            closed["location_purged"] and closed["lat"] == closed["lon"] == 0
        )
        try:
            await registered[0].call("publish_fire_risk", *risk_arguments(product, grid_record, v2, 0.0))
            checks["unauthorized_risk_write_rejected"] = False
        except ReducerError:
            checks["unauthorized_risk_write_rejected"] = True
        await asyncio.sleep(0.2)
        checks["subscription_risk_update_received"] = command.table("fire_risk_meta").one() is not None
        checks["subscription_queue_update_received"] = bool(list(command.table("ops_queue"))) or not after
        return {
            "status": "passed" if all(checks.values()) else "failed",
            "checks": checks,
            "database": database,
            "server": server,
            "synthetic_requests": len(actual),
            "initial_queue_entries": len(before),
            "queue_after_wind_change": len(after),
            "static_extraction_projection": initial["static_extraction_projection"],
            "completed_handoffs": None,
            "handoff_reason": initial["handoff_reason"],
            "consent_expiry_timer": "source inspected; fifteen-minute timer not wall-clock waited",
            "full_uagents_asi1_frontend": "not launched; uagents dependency/Agentverse credentials/frontend unavailable",
        }
    finally:
        for c in clients:
            await c.close()


def demonstrate(dataset, checkpoint, metadata, output, *, server=None, database="wrq-codex-supervised"):
    from .unet import NativePredictor

    data = load_dataset(dataset)
    pair = sorted(primary_pairs(data, "validation"), key=lambda p: p["pair_id"])[0]
    record = next(r for r in data["sequences"] if r["sequence_id"] == pair["sequence_id"])
    seq = load_sequence(record)
    result = NativePredictor(checkpoint, metadata).predict(seq, pair)
    grid = grid_from_record(record["grid"])
    current = seq["masks"][pair["from_index"]]
    product = ForecastProduct(
        grid,
        pair["issue_s"],
        [pair["horizon_s"]],
        result["probability"][None],
        seq["valid"],
        current,
        str(result["model_version"]),
        "learned",
        quality_flags=[
            *result.get("quality_flags", []),
            "experimental isolated replay; physical route timing retained",
        ],
    )
    residents = synthetic_residents(grid, product.valid, pair_id=pair["pair_id"], observed=current)
    world, burning, stations, units = make_demo(product, residents)
    plan = physical_plan(world, burning, residents, stations, units)
    routes = {
        r["request_id"]: min(
            t["travel_s"] for t in plan["travel"] if t["request_id"] == r["request_id"] and t["reachable"]
        )
        for r in residents
        if any(t["request_id"] == r["request_id"] and t["reachable"] for t in plan["travel"])
    }
    risk = assess_residents(product, residents, travel_s=routes)
    receipt = {
        "synthetic": True,
        "pair": pair,
        "residents": risk,
        "plan": asdict(plan["plan"]),
        "static_extraction_projection": plan["static_extraction_projection"],
        "completed_handoffs": None,
        "handoff_reason": plan["handoff_reason"],
        "dispatch_effect": "coarse learned risk supplementary; minute-level physics and Lookahead remain unchanged",
        "integration": asyncio.run(
            publish_demo(product, record["grid"], residents, server=server, database=database)
        )
        if server
        else {"status": "isolated_pure_functions_only"},
    }
    atomic_json(output, receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("dataset", "checkpoint", "metadata", "output"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--server")
    parser.add_argument("--database", default="wrq-codex-supervised")
    args = parser.parse_args()
    receipt = demonstrate(
        args.dataset, args.checkpoint, args.metadata, args.output, server=args.server, database=args.database
    )
    print(json.dumps(receipt.get("integration"), indent=2))


if __name__ == "__main__":
    main()
