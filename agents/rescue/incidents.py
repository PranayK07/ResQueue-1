"""Incident catalog: real fires the demo can replay, with their news date window.

An incident ties together the real-world time that sim T+0 represents, the
window of news coverage that counts, and the names/places that identify it.
It is written to the `incident` table so every agent shares one definition:
that row is the system's WHEN (absent = live). A custom window (adhoc) works
the same way as a catalog fire. select() also points the news focus (WHERE)
at the incident's center."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
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
    queries: list[str]  # names that identify the fire in posts ("Camp Fire" also matches #CampFire)
    places: list[str]
    # News agent only (not stored in the incident table): where "nearby" X accounts are measured from,
    # accounts always followed for this incident, and specific posts collected by URL on every refresh.
    center: tuple[float, float] | None = None
    accounts: list[str] = field(default_factory=list)
    posts: list[str] = field(default_factory=list)

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
            center=tuple(v["center"]) if v.get("center") else None,
            accounts=list(v.get("accounts", [])), posts=list(v.get("posts", [])),
        )
    return out


def adhoc(start: str, end: str, *, location: str = "", center: tuple[float, float] | None = None,
          names: list[str] = (), places: list[str] = ()) -> Incident:
    """A custom time window (YYYY-MM-DD, inclusive) that isn't in the catalog, e.g. adhoc("2020-09-27", "2020-10-20")."""
    news_from, news_to = _day(start), _day(end, end=True)
    if news_to < news_from:
        raise ValueError(f"window ends ({end}) before it starts ({start})")
    return Incident(key=f"window-{start}-{end}", name=f"Custom window {start} → {end}" + (f" ({location})" if location else ""),
                    start=news_from, news_from=news_from, news_to=news_to, location=location,
                    queries=list(names), places=list(places), center=center)


async def select(db, inc: Incident) -> None:
    """Make `inc` the shared WHEN (incident row) and, when it has a center, the news WHERE (news_focus).
    `db` is a SpacetimeClient registered as a commander or scenario agent."""
    await db.call("set_incident", *inc.reducer_args())
    if inc.center:
        await db.call("ping_news", float(inc.center[0]), float(inc.center[1]), inc.location)


def get(key: str) -> Incident:
    cat = load_catalog()
    if key not in cat:
        raise KeyError(f"unknown incident '{key}'. Available: {', '.join(cat)}")
    return cat[key]
