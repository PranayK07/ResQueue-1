"""The commander's decision for one request, as chat lines. Pure: takes the rows the commander already holds."""
from __future__ import annotations

from .slack import fmt_min

AGENT_FLAG_PREFIXES = ("news:", "resident fire sighting")


def decision_lines(rid, request, queue, risk, assessment, weighed_note, station_name, unit_callsign, now_s, situation) -> list[str]:
    """`risk` is the assessment dict of the request's ops_risk card (or None), `queue` its ops_queue row (or None).
    Markdown, so ASI:One renders it as a headed list instead of one run-on paragraph."""
    level = (risk or request or {}).get("level", "unknown")
    danger = str(level).upper()
    if risk and risk["slack_s"] <= -1e8:  # placeholder for "no route reaches it before the fire"
        danger += " — no unit can reach this location before the fire does"
    elif risk:
        m = risk["slack_s"] / 60
        danger += (f" — {m:.0f} min of slack after travel and extraction" if m >= 0
                   else f" — the fire arrives about {-m:.0f} min before a rescue can finish")
    if queue:
        station = f"{station_name}, rank {queue['rank']} in its queue"
        station += (f"; {unit_callsign} dispatched, ETA about {fmt_min(queue['eta_s'] - now_s)}" if queue["unit_id"]
                    else f"; ETA about {fmt_min(queue['eta_s'] - now_s)} once a unit frees up")
        station += f" (policy: {queue['policy']})"
    elif str(level) == "unreachable":
        station = "none — escalated to the commander to request other resources (air, mutual aid)"
    else:
        station = "not placed in a queue yet (still being scored)"
    lines = [f"### 🚨 Decision for signal #{rid}", "", f"- **Danger:** {danger}", f"- **Station:** {station}"]
    if risk and risk["probabilities"]:
        lines.append(f"- **Learned fire exposure:** {risk['probabilities'][-1]:.0%} within {risk['horizons_s'][-1] / 3600:g} h "
                     f"(timing: {risk['forecast_state']})")
    elif risk:
        lines.append(f"- **Learned fire exposure:** unavailable ({risk['forecast_state']})")
    lines += ["", "#### How the agents got there", ""]
    if assessment:
        lines.append(f"- **Intake** read it ({assessment['analyzer']}): {assessment['summary']}")
    if weighed_note:
        lines.append(f"- **Commander** weighed the claims: {weighed_note}")
    if situation:
        lines.append(f"- **Hazard:** fire {situation.fire_area_sq_km:.1f} km², wind {situation.wind_speed_mps:.0f} m/s; "
                     f"learned model {'ready' if risk and risk['probabilities'] else 'not available'}")
        lines.append(f"- **News:** {situation.news_relevant} relevant X post(s)"
                     + ("; evacuation reported" if situation.news_evacuation else "")
                     + (f"; {situation.news_closures} closure post(s)" if situation.news_closures else ""))
    if queue:
        lines.append(f"- **Dispatch policy:** {queue['reason']}")
    notes = [f for f in (risk or {}).get("quality_flags", []) if f.startswith(AGENT_FLAG_PREFIXES)]
    if notes:
        lines += ["", "> Notices: " + "; ".join(notes)]
    return lines
