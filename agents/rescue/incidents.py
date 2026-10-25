"""Incident catalog: real fires the demo can replay, with their news date window.

An incident ties together the real-world time that sim T+0 represents, the
window of news coverage that counts, and the queries/places used to find it.
It is written to the `incident` table so every agent shares one definition."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from .config import AGENTS_ROOT

CATALOG = AGENTS_ROOT / "incidents.json"


@dataclass(frozen=True)
class Incident:
    key: str
    name: str
    start: datetime  # real time of sim T+0 (UTC)
    news_from: datetime  # inclusive, UTC midnight
    news_to: datetime  # inclusive of the whole day
    location: str
    queries: list[str]
    places: list[str]

    def reducer_args(self) -> list:
        us = lambda d: int(d.timestamp() * 1_000_000)  # noqa: E731
        return [self.key, self.name, us(self.start), us(self.news_from), us(self.news_to),
                self.location, "|".join(self.queries), ",".join(self.places)]


def _day(s: str, end: bool = False) -> datetime:
    d = datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
    return d + timedelta(days=1) - timedelta(microseconds=1) if end else d


def load_catalog() -> dict[str, Incident]:
    raw = json.loads(CATALOG.read_text())
    out = {}
    for key, v in raw.items():
        if key.startswith("_"):
            continue
        out[key] = Incident(
            key=key, name=v["name"], start=datetime.fromisoformat(v["start"].replace("Z", "+00:00")),
            news_from=_day(v["news_from"]), news_to=_day(v["news_to"], end=True),
            location=v["location"], queries=list(v["queries"]), places=list(v["places"]),
        )
    return out


def get(key: str) -> Incident:
    cat = load_catalog()
    if key not in cat:
        raise KeyError(f"unknown incident '{key}'. Available: {', '.join(cat)}")
    return cat[key]
