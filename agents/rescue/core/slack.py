"""Slack: how much time is left once help could arrive.

    slack = T_fire_arrival(p10) - (now + T_wait + T_travel + T_extract) - margin

Everything is in absolute sim seconds except the durations.
"""
from __future__ import annotations

MARGIN_S = 300.0

_NEED_EXTRA_S = {
    "mobility": 420.0,
    "medical": 480.0,
    "oxygen": 360.0,
    "infant": 120.0,
    "elderly": 180.0,
    "pets": 120.0,
    "language": 60.0,
}
_NEED_WEIGHT = {"mobility": 0.5, "medical": 0.6, "oxygen": 0.6, "infant": 0.4, "elderly": 0.3}


def parse_needs(needs: str) -> list[str]:
    return [n for n in (x.strip() for x in needs.split(",")) if n]


def extract_time_s(headcount: int, needs: str) -> float:
    """Time on scene: base + per person + specific needs."""
    return 240.0 + 45.0 * max(1, headcount) + sum(_NEED_EXTRA_S.get(n, 0.0) for n in parse_needs(needs))


def vulnerability(headcount: int, needs: str) -> float:
    """Reward weight for reaching this request in time (people x need)."""
    return max(1, headcount) * (1.0 + sum(_NEED_WEIGHT.get(n, 0.0) for n in parse_needs(needs)))


def slack_s(fire_eta_s: float, now_s: float, wait_s: float, travel_s: float, extract_s: float, margin_s: float = MARGIN_S) -> float:
    return fire_eta_s - (now_s + wait_s + travel_s + extract_s) - margin_s


def level_for(slack: float) -> str:
    if slack < 600:
        return "critical"
    if slack < 1800:
        return "high"
    if slack < 3600:
        return "moderate"
    return "low"


def fmt_min(seconds: float) -> str:
    if seconds == float("inf"):
        return "∞"
    m = round(seconds / 60)
    return f"{m} min" if abs(m) < 120 else f"{m / 60:.1f} h"
