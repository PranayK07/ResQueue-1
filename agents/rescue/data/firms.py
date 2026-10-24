"""NASA FIRMS active-fire detections (https://firms.modaps.eosdis.nasa.gov/api/area/).

GET /api/area/csv/{MAP_KEY}/{PRODUCT}/{west,south,east,north}/{DAYS}[/{YYYY-MM-DD}]
Responses are cached under .agent-state/ so a replay works offline and does
not burn the 5000-requests/10-min key quota.
"""
from __future__ import annotations

import csv
import hashlib
import io
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

from ..config import STATE_DIR

BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"


@dataclass
class Detection:
    lat: float
    lon: float
    at: datetime  # UTC acquisition time
    frp: float  # fire radiative power (MW), intensity proxy
    confidence: str


def _parse(text: str) -> list[Detection]:
    if not text.lstrip().lower().startswith("latitude"):
        raise ValueError(f"unexpected FIRMS response: {text[:120]!r}")
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        t = row.get("acq_time", "0000").zfill(4)
        at = datetime.strptime(f"{row['acq_date']} {t}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)
        out.append(Detection(
            lat=float(row["latitude"]), lon=float(row["longitude"]), at=at,
            frp=float(row.get("frp") or 0.0), confidence=str(row.get("confidence", "")),
        ))
    out.sort(key=lambda d: d.at)
    return out


async def fetch(map_key: str, product: str, bbox: tuple[float, float, float, float], days: int, date: str = "", *, cache: bool = True) -> list[Detection]:
    area = ",".join(f"{x:.4f}" for x in bbox)
    url = f"{BASE}/{map_key}/{product}/{area}/{max(1, min(5, days))}" + (f"/{date}" if date else "")
    key = hashlib.sha1(url.replace(map_key, "KEY").encode()).hexdigest()[:16]
    path = STATE_DIR / f"firms-{key}.csv"
    if cache and date and path.exists():  # historical data never changes
        return _parse(path.read_text())
    async with httpx.AsyncClient(timeout=30.0) as http:
        r = await http.get(url)
        r.raise_for_status()
    path.write_text(r.text)
    return _parse(r.text)
