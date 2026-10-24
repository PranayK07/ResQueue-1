"""National Weather Service observations (api.weather.gov, no key needed).

points/{lat},{lon} -> observationStations -> stations/{id}/observations/latest
Units come back as km/h and degrees; we return m/s. Requires a User-Agent.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx

BASE = "https://api.weather.gov"


@dataclass
class Observation:
    station: str
    observed_at: str
    wind_speed_mps: float
    wind_from_deg: float
    gust_mps: float | None
    humidity_pct: float | None
    temperature_c: float | None


def _val(props: dict, key: str) -> float | None:
    v = (props.get(key) or {}).get("value")
    return float(v) if v is not None else None


class NWSClient:
    def __init__(self, user_agent: str):
        self._http = httpx.AsyncClient(timeout=15.0, headers={"User-Agent": user_agent, "Accept": "application/geo+json"})
        self._stations: list[str] = []
        self._for: tuple[float, float] | None = None

    async def stations_near(self, lat: float, lon: float) -> list[str]:
        if self._for == (round(lat, 3), round(lon, 3)) and self._stations:
            return self._stations
        r = await self._http.get(f"{BASE}/points/{lat:.4f},{lon:.4f}")
        r.raise_for_status()
        url = r.json()["properties"]["observationStations"]
        r = await self._http.get(url, params={"limit": 5})
        r.raise_for_status()
        self._stations = [f["properties"]["stationIdentifier"] for f in r.json()["features"]]
        self._for = (round(lat, 3), round(lon, 3))
        return self._stations

    async def latest(self, lat: float, lon: float, max_age: timedelta = timedelta(hours=3)) -> Observation | None:
        """Latest observation from the nearest station that reports wind
        recently (small RAWS stations often go quiet for days)."""
        for sid in await self.stations_near(lat, lon):
            r = await self._http.get(f"{BASE}/stations/{sid}/observations/latest")
            if r.status_code != 200:
                continue
            p = r.json()["properties"]
            try:
                age = datetime.now(timezone.utc) - datetime.fromisoformat(p.get("timestamp", ""))
            except ValueError:
                continue
            if age > max_age:
                continue
            speed_kmh, direction = _val(p, "windSpeed"), _val(p, "windDirection")
            if speed_kmh is None or (direction is None and speed_kmh > 0):
                continue
            gust = _val(p, "windGust")
            return Observation(
                station=sid,
                observed_at=p.get("timestamp", ""),
                wind_speed_mps=speed_kmh / 3.6,
                wind_from_deg=direction or 0.0,
                gust_mps=gust / 3.6 if gust is not None else None,
                humidity_pct=_val(p, "relativeHumidity"),
                temperature_c=_val(p, "temperature"),
            )
        return None

    async def close(self) -> None:
        await self._http.aclose()
