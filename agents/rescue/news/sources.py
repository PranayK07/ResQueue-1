"""Trusted X accounts the news agent follows, and which of them are near an incident.

news_sources.json lists accounts (fire agencies, sheriffs / county OES, NWS offices, Caltrans districts, relief
orgs, trackers) with the area each one covers. For an incident the agent follows the accounts whose area includes
it: first the most local account of each CORE_KINDS, so the feed always has a fire agency, an evacuation authority,
a relief org and a forecaster when one exists, then the most local of the rest. Pure data: no network."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ..core.geo import haversine_m

CORE_KINDS = ("fire", "emergency", "relief", "weather")
LOCAL_RADIUS_KM = 250.0  # an account covering at most this much is "local" (statewide / national ones are not)
UNLISTED_TRUST = 0.4  # an account that isn't in the registry, e.g. a post the commander asked to track


@dataclass(frozen=True)
class Account:
    handle: str
    name: str
    kind: str  # fire | emergency | relief | weather | transport | utility | tracker | other
    official: bool  # a government agency
    lat: float
    lon: float
    radius_km: float  # 0 = covers nowhere in particular (unlisted)

    @property
    def url(self) -> str:
        return f"https://x.com/{self.handle}"

    @property
    def trust(self) -> float:
        return 1.0 if self.official else UNLISTED_TRUST if self.kind == "other" else 0.7

    def distance_km(self, lat: float, lon: float) -> float:
        return haversine_m(self.lat, self.lon, lat, lon) / 1000

    def covers(self, lat: float, lon: float) -> bool:
        return self.radius_km > 0 and self.distance_km(lat, lon) <= self.radius_km

    def is_local(self, lat: float, lon: float) -> bool:
        return self.radius_km <= LOCAL_RADIUS_KM and self.covers(lat, lon)


def load_registry(path: Path) -> dict[str, Account]:
    """Accounts keyed by lowercase handle (X handles are case-insensitive)."""
    raw = json.loads(path.read_text())
    out = {}
    for a in raw["accounts"]:
        acct = Account(handle=a["handle"].lstrip("@"), name=a["name"], kind=a["kind"], official=bool(a["official"]),
                       lat=float(a["lat"]), lon=float(a["lon"]), radius_km=float(a["radius_km"]))
        out[acct.handle.lower()] = acct
    return out


def unlisted(handle: str) -> Account:
    handle = handle.strip().lstrip("@")
    return Account(handle=handle, name=handle, kind="other", official=False, lat=0.0, lon=0.0, radius_km=0.0)


def lookup(registry: dict[str, Account], handle: str) -> Account:
    return registry.get(handle.strip().lstrip("@").lower()) or unlisted(handle)


def select(registry: dict[str, Account], center: tuple[float, float] | None, *, pinned: list[str] = (),
           limit: int = 8) -> list[Account]:
    """Pinned handles first (the incident's own + NEWS_ACCOUNTS), then nearby accounts as described above.
    Without a center only the wide-area (statewide / national) accounts qualify."""
    picked: dict[str, Account] = {}
    for h in pinned:
        if h.strip().lstrip("@"):
            a = lookup(registry, h)
            picked.setdefault(a.handle.lower(), a)
    if center:
        lat, lon = center
        nearby = sorted((a for a in registry.values() if a.covers(lat, lon)),
                        key=lambda a: (a.radius_km, a.distance_km(lat, lon)))
    else:
        nearby = sorted((a for a in registry.values() if a.radius_km > LOCAL_RADIUS_KM), key=lambda a: a.radius_km)
    have = {a.kind for a in picked.values()}
    for kind in CORE_KINDS:
        best = next((a for a in nearby if a.kind == kind and a.handle.lower() not in picked), None)
        if best and kind not in have:
            picked[best.handle.lower()] = best
    for a in nearby:
        picked.setdefault(a.handle.lower(), a)
    return list(picked.values())[:max(1, limit)]
