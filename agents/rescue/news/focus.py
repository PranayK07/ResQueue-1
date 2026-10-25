"""WHERE and WHEN the news agent looks, resolved from the shared tables. Pure data: no network.

  WHERE  the latest location ping (news_focus row, set by ping_news from the web app, the commander, a script or
         another agent), else the selected incident's catalog center, else the stations' centroid.
  WHEN   the incident row: present = its window [news_from, news_to] (a replay: a catalog fire, or any custom
         range such as 2020-09-27 -> 2020-10-20); absent = live, the last NEWS_LIVE_LOOKBACK_H hours.

Shifting from today to 2020 is therefore one reducer call (set_incident, or clear_incident to go back to live),
and moving the area is another (ping_news); the news agent reacts to both."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass(frozen=True)
class Focus:
    lat: float | None
    lon: float | None
    label: str  # place name of the ping / incident location ('' = unnamed)
    where: str  # ping | incident | stations | none
    scope: str  # incident key, '' = live: the tag on news_article rows
    window_from: int  # UTC micros, inclusive
    window_to: int
    live: bool

    @property
    def center(self) -> tuple[float, float] | None:
        return (self.lat, self.lon) if self.lat is not None and self.lon is not None else None

    def contains(self, micros: int) -> bool:
        return micros > 0 and self.window_from <= micros <= self.window_to

    def signature(self) -> tuple:
        """Changes when the agent should look again: a new scope, a move of more than ~1 km, or a new label.
        (A live window sliding forward is the poll timer's job, not a focus change.)"""
        c = self.center
        return self.scope, (round(c[0], 2), round(c[1], 2)) if c else None, self.label

    def describe(self) -> str:
        day = lambda m: datetime.fromtimestamp(m / 1e6, timezone.utc).strftime("%Y-%m-%d")  # noqa: E731
        where = (f"{self.label + ' ' if self.label else ''}({self.lat:.3f}, {self.lon:.3f})" if self.center
                 else "no location (statewide accounts only)")
        hours = (self.window_to - self.window_from) / 3.6e9
        when = f"live, last {hours:.0f} h" if self.live else f"{day(self.window_from)} → {day(self.window_to)}"
        return f"{where} · {when}"


def resolve(focus_row: dict | None, incident_row: dict | None, catalog_center: tuple[float, float] | None,
            stations: list[dict], *, now_micros: int, live_lookback_h: float) -> Focus:
    if focus_row:
        lat, lon, label, where = focus_row["lat"], focus_row["lon"], focus_row["label"], "ping"
    elif catalog_center:
        (lat, lon), label, where = catalog_center, incident_row["location"] if incident_row else "", "incident"
    elif stations:
        lat = sum(s["lat"] for s in stations) / len(stations)
        lon = sum(s["lon"] for s in stations) / len(stations)
        label, where = "", "stations"
    else:
        lat = lon = None
        label, where = "", "none"
    if incident_row:
        return Focus(lat, lon, label, where, incident_row["key"], incident_row["news_from"], incident_row["news_to"], False)
    return Focus(lat, lon, label, where, "", now_micros - int(live_lookback_h * 3.6e9), now_micros, True)
