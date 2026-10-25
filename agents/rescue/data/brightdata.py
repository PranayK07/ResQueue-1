"""Bright Data Web Scraper API: the pre-built X (Twitter) Posts scraper.

The news agent reads trusted wildfire accounts on X (news/sources.py) through two endpoints of one dataset
(gd_lwxkxvnf1cynvib9co), so we never scrape a site ourselves:

  Discover by profile url  POST /datasets/v3/trigger?dataset_id=..&type=discover_new&discover_by=profile_url
                           body {"input": [{"url": "https://x.com/CAL_FIRE"}, ..], "limit_per_input": N}
                           -> {"snapshot_id": ".."}; poll GET /datasets/v3/progress/<id> until "ready",
                           then GET /datasets/v3/snapshot/<id>?format=json -> [posts]. Always async.
  Collect by URL           POST /datasets/v3/scrape?dataset_id=..  body {"input": [{"url": "https://x.com/<h>/status/<id>"}]}
                           -> [posts] if it finishes within ~1 min, else 202 {"snapshot_id"} (then poll as above)

Auth: Authorization: Bearer <BRIGHTDATA_API_KEY>. Billed per record (post) returned, so discovery caps posts
per account with limit_per_input. With include_errors=true a bad input (wrong handle, deleted post) comes back
as a row with an "error" field instead of failing the whole job: see input_errors().
"""
from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import httpx

API = "https://api.brightdata.com"
X_POSTS_DATASET = "gd_lwxkxvnf1cynvib9co"
_NOT_READY = ("building", "running", "starting", "collecting", "digesting")
_STATUS_URL = re.compile(r"^/([A-Za-z0-9_]{1,15})/status(?:es)?/(\d+)")


class BrightDataError(RuntimeError):
    pass


@dataclass
class Post:
    url: str
    handle: str  # without the @
    name: str  # display name
    text: str  # the post, plus the post it quotes
    published_raw: str
    published_micros: int  # 0 = unknown
    hashtags: list[str]
    likes: int
    reposts: int
    views: int


def parse_published(raw: str) -> int:
    """'2018-11-08T15:30:00.000Z' (what the X scraper delivers) -> UTC micros; 0 if unparseable."""
    raw = (raw or "").strip()
    if not raw:
        return 0
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return 0
    return int((dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp() * 1_000_000)


def x_post_url(url: str) -> str | None:
    """Canonical https://x.com/<handle>/status/<id> for an x.com / twitter.com post link, else None."""
    u = urlparse((url or "").strip())
    host = (u.hostname or "").removeprefix("www.").removeprefix("mobile.")
    m = _STATUS_URL.match(u.path)
    if host not in ("x.com", "twitter.com") or not m:
        return None
    return f"https://x.com/{m.group(1)}/status/{m.group(2)}"


def _int(v) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _hashtags(v) -> list[str]:
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except json.JSONDecodeError:
            v = v.split(",")
    return [str(t).strip().lstrip("#") for t in (v or []) if str(t).strip().lstrip("#")]


def normalize(row: dict) -> Post | None:
    """One X Posts record -> Post (None for error rows and rows without a post)."""
    url = str(row.get("url") or "").strip()
    text = str(row.get("description") or "").strip()
    if not url.startswith("http") or not text:
        return None
    handle = str(row.get("user_posted") or "").strip().lstrip("@")
    if not handle:
        m = _STATUS_URL.match(urlparse(url).path)
        handle = m.group(1) if m else ""
    quoted = row.get("quoted_post")
    if isinstance(quoted, dict) and quoted.get("description"):
        who = quoted.get("user_posted") or quoted.get("profile_name") or "a post"
        text += f"\n\nQuoting {'@' if quoted.get('user_posted') else ''}{who}: {str(quoted['description']).strip()}"
    raw = str(row.get("date_posted") or "")
    return Post(
        url=url, handle=handle, name=str(row.get("name") or "").strip(), text=text,
        published_raw=raw, published_micros=parse_published(raw), hashtags=_hashtags(row.get("hashtags")),
        likes=_int(row.get("likes")), reposts=_int(row.get("reposts")), views=_int(row.get("views")),
    )


def input_errors(rows: list[dict]) -> list[str]:
    """'<input url>: <error>' for every error row (include_errors=true), e.g. a handle that doesn't exist."""
    out = []
    for r in rows:
        if r.get("error") and not r.get("description"):
            inp = r.get("input") if isinstance(r.get("input"), dict) else {}
            out.append(f"{inp.get('url') or r.get('url') or '?'}: {str(r['error'])[:160]}")
    return out


def load_fixture(path: str | Path) -> list[dict]:
    """A saved export: a JSON array, or an NDJSON archive (news_archive/<incident>.jsonl)."""
    return parse_rows(Path(path).read_text()) or []


def parse_rows(text: str) -> list[dict] | None:
    """Rows from a snapshot / scrape body, or None if the snapshot is still being built.

    Bright Data returns a JSON array with format=json, NDJSON (one object per line) otherwise."""
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
                raise BrightDataError(f"line {n} is not JSON ({e}): {line[:120]}") from e
        return [r for r in rows if isinstance(r, dict)]
    if isinstance(body, list):
        return [r for r in body if isinstance(r, dict)]
    if isinstance(body, dict):
        if body.get("status") in _NOT_READY and not body.get("url"):
            return None
        if ("status" in body or "error" in body) and "message" in body and not body.get("url"):
            raise BrightDataError(f"unexpected response: {text[:300]}")
        return [body]  # a single record
    raise BrightDataError(f"unexpected response: {text[:300]}")


def _client(api_key: str, transport: httpx.AsyncBaseTransport | None) -> httpx.AsyncClient:
    if not api_key:
        raise BrightDataError("BRIGHTDATA_API_KEY is required")
    return httpx.AsyncClient(base_url=API, headers={"Authorization": f"Bearer {api_key}"}, timeout=60, transport=transport)


def _snapshot_id(r: httpx.Response, what: str) -> str:
    try:
        sid = r.json().get("snapshot_id")
    except (json.JSONDecodeError, AttributeError):
        sid = None
    if not sid:
        raise BrightDataError(f"{what} returned no snapshot_id ({r.status_code}): {r.text[:300]}")
    return sid


async def _wait_for_snapshot(c: httpx.AsyncClient, sid: str, timeout_s: float, poll_s: float) -> list[dict]:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout_s
    while loop.time() < end:
        p = await c.get(f"/datasets/v3/progress/{sid}")
        if p.status_code >= 400:
            raise BrightDataError(f"progress of {sid} failed ({p.status_code}): {p.text[:300]}")
        status = p.json().get("status")
        if status == "failed":
            raise BrightDataError(f"snapshot {sid} failed: {p.text[:300]}")
        if status == "ready":
            d = await c.get(f"/datasets/v3/snapshot/{sid}", params={"format": "json"})
            if d.status_code == 200:
                rows = parse_rows(d.text)
                if rows is not None:
                    return rows
            elif "empty" in d.text.lower():  # a job that found nothing has no snapshot to download
                return []
            elif d.status_code != 202:
                raise BrightDataError(f"snapshot {sid} download failed ({d.status_code}): {d.text[:300]}")
        await asyncio.sleep(poll_s)
    raise BrightDataError(f"snapshot {sid} not ready after {timeout_s:.0f}s")


async def discover_posts(
    api_key: str,
    inputs: list[dict],
    *,
    dataset_id: str = X_POSTS_DATASET,
    limit_per_input: int = 20,
    timeout_s: float = 900,
    poll_s: float = 10.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[dict]:
    """Discover by profile url: the newest posts (<= limit_per_input each) of every {"url": "https://x.com/<handle>"}."""
    params = {"dataset_id": dataset_id, "include_errors": "true", "type": "discover_new", "discover_by": "profile_url"}
    async with _client(api_key, transport) as c:
        r = await c.post("/datasets/v3/trigger", params=params, json={"input": inputs, "limit_per_input": limit_per_input})
        if r.status_code >= 400:
            raise BrightDataError(f"trigger failed ({r.status_code}): {r.text[:300]}")
        return await _wait_for_snapshot(c, _snapshot_id(r, "trigger"), timeout_s, poll_s)


async def collect_posts(
    api_key: str,
    urls: list[str],
    *,
    dataset_id: str = X_POSTS_DATASET,
    timeout_s: float = 300,
    poll_s: float = 5.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[dict]:
    """Collect by URL: specific posts. Synchronous when Bright Data finishes within its ~1 min limit."""
    params = {"dataset_id": dataset_id, "notify": "false", "include_errors": "true"}
    async with _client(api_key, transport) as c:
        r = await c.post("/datasets/v3/scrape", params=params, json={"input": [{"url": u} for u in urls]}, timeout=90)
        if r.status_code == 202:  # ran past the sync limit: Bright Data finishes it as a snapshot
            return await _wait_for_snapshot(c, _snapshot_id(r, "scrape"), timeout_s, poll_s)
        if r.status_code >= 400:
            raise BrightDataError(f"scrape failed ({r.status_code}): {r.text[:300]}")
        rows = parse_rows(r.text)
        if rows is None:
            return await _wait_for_snapshot(c, _snapshot_id(r, "scrape"), timeout_s, poll_s)
        return rows
