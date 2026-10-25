"""Resident risk composition shared by live orchestration and replay tests.

The learned model supplies exposure. Routing and accepted evidence supply
assistance feasibility. Hour-scale probability brackets never become physical
p10 deadlines. All output fields are typed by RequestRiskInput in schema.ts.
"""

from __future__ import annotations

import hashlib
import json
import math

from .slack import MARGIN_S, level_for, slack_s

# A credible resident sighting means fire is close. If the learned model gives the shortest horizon less than this
# probability for that cell, the two sources disagree and a human should look; the sooner physical ETA is kept.
SIGHTING_MODEL_GAP = 0.25


def news_context(situation) -> dict | None:
    """Hints from the news agent (Situation fields). None = news unavailable, so no news flags are added."""
    if situation is None or not situation.news_ok:
        return None
    return dict(news_evacuation=bool(situation.news_evacuation), news_closures=int(situation.news_closures))


def context_flags(context, w, probabilities, state) -> list[str]:
    """Flags from the other agents. They never change numbers: news is a hint, and resident evidence is already
    applied to the physical ETA by the danger engine."""
    flags = []
    if context:
        if context.get("news_evacuation"):
            flags.append("news: evacuation reported for the incident area (unverified hint)")
        if context.get("news_closures"):
            flags.append(
                f"news: {context['news_closures']} road-closure post(s) reported; travel times do not reflect them"
            )
    if w and w.fire_credible:
        if probabilities and probabilities[0] < SIGHTING_MODEL_GAP:
            flags.append(
                f"resident fire sighting not reflected by learned exposure ({probabilities[0]:.0%} at the shortest "
                "horizon); the sooner physical ETA is used"
            )
        elif not probabilities:
            flags.append(f"resident fire sighting while learned exposure is {state}; the sighting is trusted")
    return flags


def units_stamp(units):
    return "|".join(f"{u['id']}:{u.get('updated_at', 0)}" for u in sorted(units, key=lambda u: u["id"]))


def risk_snapshot(now_s, scenario, versions, units, meta=None, pipeline=None):
    return dict(
        scenario=scenario,
        assessed_at_s=now_s,
        units_stamp=units_stamp(units),
        weather_version=versions["weather"],
        fire_version=versions["fire"],
        roads_version=versions["roads"],
        requests_version=versions["requests"],
        forecast_version=versions["forecast"],
        risk_updated_at=(meta or {}).get("updated_at", 0),
        pipeline_updated_at=(pipeline or {}).get("updated_at", 0),
    )


def compose_risks(
    snapshot, requests, assessments, travel, units, weighed, *, meta=None, cells=(), pipeline=None, responses=None, context=None, committed=None
):
    """Return one complete risk record for each physically assessed active request.

    Travel/wait use the committed truck when supplied, otherwise the earliest station-unit option.
    Missing units/routes and unknown exposure remain explicit optional values.
    Accepted evidence has already adjusted assessments; it is not applied twice.
    """
    now = snapshot["assessed_at_s"]
    reqs = {r["id"]: r for r in requests}
    product, state = None, "unavailable"
    flags = []
    if pipeline and pipeline["status"] != "ready":
        state = pipeline["status"]
        flags.append(pipeline["reason"])
    elif meta:
        if (
            meta.get("scenario") != snapshot["scenario"]
            or meta["time_basis"] != "simulation"
            or meta["weather_version"] != snapshot["weather_version"]
            or meta["fire_version"] != snapshot["fire_version"]
        ):
            state = "stale_or_incompatible"
        elif now >= meta["issue_s"] + meta["horizons_s"][-1]:
            state = "expired"
        else:
            try:
                from ..forecast_ml.bridge import product_from_rows

                product = product_from_rows(meta, list(cells))
                state = "ready"
                flags.extend(product.quality_flags)
            except (ValueError, KeyError, ImportError, RuntimeError) as exc:
                state = "invalid"
                flags.append(f"risk reconstruction failed: {type(exc).__name__}: {exc}")
    free = {}
    for unit in units:
        if unit["status"] == "out_of_service":
            continue
        at = (
            now
            if unit["status"] == "available"
            else max(now, unit["free_at_s"] if unit["free_at_s"] > now else now + 1800)
        )
        free[unit["station_id"]] = min(free.get(unit["station_id"], math.inf), at)
    routes = {}
    for leg in travel:
        if leg["reachable"] and leg["station_id"] in free and math.isfinite(leg["travel_s"]):
            routes.setdefault(leg["request_id"], []).append(leg)
    out = []
    for danger in assessments:
        rid = danger["request_id"]
        r, w = reqs[rid], weighed.get(rid)
        legs = routes.get(rid, [])
        leg = min(legs, key=lambda t: free[t["station_id"]] + t["travel_s"]) if legs else None
        assigned = (committed or {}).get(rid)
        if assigned:
            leg = assigned if assigned['reachable'] else None
        drive = leg["travel_s"] if leg else None
        wait = max(0.0, free[leg["station_id"]] - now) if leg else None
        if assigned and leg:
            wait = 0.0
        if responses is not None:
            leg = responses.get(rid)
            drive = leg['travel_s'] if leg else None
            wait = leg['wait_s'] if leg else None
            if leg:
                value = slack_s(danger['fire_eta_s'], now, wait, drive, danger['extract_s'])
                danger = {**danger, 'slack_s': round(value, 1),
                          'level': 'unreachable' if danger.get('observed_fire') else level_for(value)}
        scheduled = (
            danger["fire_eta_s"] - now - drive - wait - danger["extract_s"] - MARGIN_S if leg else None
        )
        window, probabilities, request_state = {}, [], state
        lower_slack = upper_slack = None
        if product:
            cid = product.grid.locate(r["lat"], r["lon"])
            if cid is None:
                request_state = "outside_forecast"
            else:
                window = product.window(cid)
                if window["status"] == "unknown":
                    request_state = "unknown_cell"
                else:
                    probabilities = [float(p[product.grid.rc(cid)]) for p in product.probabilities]
                    request_state = window["status"]
                    if leg:
                        duration = now + drive + wait + danger["extract_s"] + MARGIN_S
                        lower_slack = window["lower_s"] - duration if window["lower_s"] is not None else None
                        upper_slack = window["upper_s"] - duration if window["upper_s"] is not None else None
        reason = (
            f"Physical risk {danger['level']}; immediate slack {danger['slack_s'] / 60:.1f} min. "
            + (
                f"{leg.get('callsign', 'Station ' + str(leg['station_id']))}: travel {drive / 60:.1f} min, wait {wait / 60:.1f} min, "
                f"extraction {danger['extract_s'] / 60:.1f} min; scheduled slack {scheduled / 60:.1f} min. "
                if leg
                else "No station-unit route is currently available. "
            )
            + (
                f"Learned exposure {probabilities[-1]:.1%} by {product.horizons_s[-1] / 3600:g} h; "
                f"timing state {request_state}. "
                if probabilities
                else f"Learned exposure {request_state}. "
            )
            + (f"Accepted evidence: {w.note}." if w and w.note else "No accepted world-evidence adjustment.")
        )
        row_flags = list(flags)
        if lower_slack is not None and upper_slack is not None and lower_slack <= 0 <= upper_slack:
            row_flags.append("coarse exposure interval straddles assistance completion; review needed")
        if not leg:
            row_flags.append("no station-unit route estimate available")
        other = context_flags(context, w, probabilities, request_state)
        row_flags.extend(other)
        if other:
            reason += " Other agents: " + "; ".join(other) + "."
        row = dict(
            request_id=rid,
            schema_version="resident-risk-v1",
            **{k: danger[k] for k in ("level", "slack_s", "fire_eta_s", "extract_s")},
            station_id=leg["station_id"] if leg else 0,
            travel_s=drive,
            wait_s=wait,
            scheduled_slack_s=scheduled,
            reachable=bool(leg),
            headcount=w.headcount if w else r["headcount"],
            needs=w.needs if w else r["needs"],
            credibility=w.credibility if w else 0.0,
            reported_urgency=w.reported_urgency if w else 0.0,
            trapped=w.trapped if w else False,
            injured=w.injured if w else False,
            report_note=w.note if w else "",
            forecast_id=(meta or {}).get("forecast_id", ""),
            forecast_issue_s=(meta or {}).get("issue_s", 0.0),
            model_id=(meta or {}).get("model_id", ""),
            forecast_state=request_state,
            horizons_s=product.horizons_s if probabilities else [],
            probabilities=probabilities,
            arrival_lower_s=window.get("lower_s"),
            arrival_upper_s=window.get("upper_s"),
            exposure_slack_lower_s=lower_slack,
            exposure_slack_upper_s=upper_slack,
            quality_flags=row_flags,
            reason=reason,
        )
        payload = json.dumps([snapshot, row], sort_keys=True, allow_nan=False)
        row["assessment_id"] = hashlib.sha256(payload.encode()).hexdigest()[:24]
        out.append(row)
    return out
