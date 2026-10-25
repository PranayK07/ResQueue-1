"""Bright Data Scraper Studio (formerly Web Scraper IDE) batch API.

POST /dca/trigger?collector=c_..&queue_next=1   body: JSON array of inputs -> {"collection_id": "j_.."}
GET  /dca/dataset?id=j_..                       202 {"status":"building"} until done, then 200 [rows]

Auth: Authorization: Bearer <BRIGHTDATA_API_KEY>. Billed per page load, so
the news agent polls slowly and NEWS_SOURCE=file replays a saved export.
"""
from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

API = "https://api.brightdata.com"
_ET = ZoneInfo("America/New_York")
_ZONES = {"ET": _ET, "EST": _ET, "EDT": _ET, "PT": ZoneInfo("America/Los_Angeles"),
          "PST": ZoneInfo("America/Los_Angeles"), "PDT": ZoneInfo("America/Los_Angeles"), "UTC": ZoneInfo("UTC")}


class BrightDataError(RuntimeError):
    pass


@dataclass
class Article:
    title: str
    url: str
    author: str
    published_raw: str
    published_micros: int  # 0 = unknown
    category: str
    tags: str  # comma list
    content: str


def parse_published(raw: str) -> int:
    """'Jan 23, 2022, 2:47 AM ET' (CNN style; also 'Updated 9:03 PM EST, Sun January 23, 2022') -> UTC micros."""
    raw = (raw or "").strip()
    m = re.search(r"([A-Z][a-z]{2,8})\.? (\d{1,2}), (\d{4}),? (\d{1,2}:\d{2}) ?([AP]M) ?([A-Z]{2,3})?", raw)
    if not m:
        return 0
    mon, day, year, hm, ampm, tz = m.groups()
    for fmt in ("%b %d %Y %I:%M %p", "%B %d %Y %I:%M %p"):
        try:
            dt = datetime.strptime(f"{mon[:3] if fmt.startswith('%b') else mon} {day} {year} {hm} {ampm}", fmt)
            break
        except ValueError:
            continue
    else:
        return 0
    return int(dt.replace(tzinfo=_ZONES.get(tz or "ET", _ET)).timestamp() * 1_000_000)


def normalize(row: dict) -> Article | None:
    url = str(row.get("url") or "").strip()
    if not url.startswith("http"):
        return None
    tags = row.get("tags") or []
    if isinstance(tags, str):
        try:
            tags = json.loads(tags)
        except json.JSONDecodeError:
            tags = [t for t in tags.split(",")]
    raw = str(row.get("published_date") or row.get("updated_date") or "")
    return Article(
        title=str(row.get("title") or "").strip(),
        url=url,
        author=re.sub(r"^By\s+", "", str(row.get("author") or "")).strip(),
        published_raw=raw,
        published_micros=parse_published(raw) or parse_published(str(row.get("updated_date") or "")),
        category=str(row.get("category") or ""),
        tags=",".join(str(t).strip() for t in tags if str(t).strip()),
        content=str(row.get("article_content") or row.get("content") or ""),
    )


def load_fixture(path: str | Path) -> list[dict]:
    return json.loads(Path(path).read_text())


def parse_rows(text: str) -> list[dict] | None:
    """Rows from a /dca/dataset body, or None if the job is still building.

    Bright Data delivers JSON in whichever format the scraper's Delivery
    preferences say: a JSON array, or NDJSON (one object per line)."""
    text = text.strip()
    if not text:
        return []
    try:
        body = json.loads(text)
    except json.JSONDecodeError:
        rows = []
        for n, line in enumerate(text.splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise BrightDataError(f"dataset line {n} is not JSON ({e}): {line[:120]}") from e
        return [r for r in rows if isinstance(r, dict)]
    if isinstance(body, list):
        return [r for r in body if isinstance(r, dict)]
    if isinstance(body, dict):
        if body.get("status") in ("building", "running"):
            return None
        if "status" in body and "message" in body and not body.get("url"):
            raise BrightDataError(f"unexpected dataset response: {text[:300]}")
        return [body]  # a single record
    raise BrightDataError(f"unexpected dataset response: {text[:300]}")


async def trigger_and_collect(
    api_key: str,
    collector_id: str,
    inputs: list[dict],
    *,
    timeout_s: float = 600,
    deadline: str = "10m",
    poll_s: float = 5.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[dict]:
    """Run one batch collection and return its rows (may be [])."""
    if not api_key or not collector_id:
        raise BrightDataError("BRIGHTDATA_API_KEY and BRIGHTDATA_COLLECTOR_ID are required")
    headers = {"Authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(base_url=API, headers=headers, timeout=60, transport=transport) as c:
        r = await c.post("/dca/trigger", params={"collector": collector_id, "queue_next": 1,
                                                 "no_downloads": 1, "deadline": deadline}, json=inputs)
        if r.status_code >= 400:
            raise BrightDataError(f"trigger failed ({r.status_code}): {r.text[:300]}")
        cid = r.json().get("collection_id")
        if not cid:
            raise BrightDataError(f"trigger returned no collection_id: {r.text[:300]}")
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout_s
        while loop.time() < end:
            d = await c.get("/dca/dataset", params={"id": cid})
            if d.status_code == 200:
                rows = parse_rows(d.text)
                if rows is not None:
                    return rows
            elif d.status_code == 404:
                raise BrightDataError(f"collection {cid} not found (expired or bad id)")
            elif d.status_code != 202:
                raise BrightDataError(f"dataset fetch failed ({d.status_code}): {d.text[:300]}")
            await asyncio.sleep(poll_s)
        raise BrightDataError(f"collection {cid} not ready after {timeout_s:.0f}s")
