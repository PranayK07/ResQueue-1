"""Plain-assert checks for the news pipeline (X accounts via Bright Data), offline: the Bright Data API is mocked.
Run: ../venv/bin/python scripts/test_news.py"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rescue import incidents  # noqa: E402
from rescue.config import AGENTS_ROOT  # noqa: E402
from rescue.data import brightdata  # noqa: E402
from rescue.news import sources  # noqa: E402
from rescue.news.focus import resolve  # noqa: E402
from rescue.news.signals import extract  # noqa: E402

registry = sources.load_registry(AGENTS_ROOT / "news_sources.json")
camp = incidents.get("camp-fire-2018")
glass = incidents.get("glass-fire-2020")

# ── nearby account selection ────────────────────────────────────────────────
paradise = sources.select(registry, camp.center, limit=8)
handles = [a.handle for a in paradise]
assert len(paradise) == 8, handles
assert handles[:4] == ["CALFIRE_ButteCo", "ButteSheriff", "RedCross", "NWSSacramento"], handles  # one per core kind
assert "CALFIRELNU" not in handles and "NWSBayArea" not in handles, handles  # Napa / Bay Area accounts don't cover Paradise
napa = [a.handle for a in sources.select(registry, glass.center, limit=8)]
assert napa[:4] == ["CALFIRELNU", "CountyofNapa", "RedCross", "NWSBayArea"], napa
assert "CALFIRE_ButteCo" not in napa, napa
pinned = sources.select(registry, camp.center, pinned=["@SomeLocalReporter", "butteSHERIFF", ""], limit=3)
assert [a.handle for a in pinned] == ["SomeLocalReporter", "ButteSheriff", "CALFIRE_ButteCo"], pinned
assert pinned[0].trust == sources.UNLISTED_TRUST and pinned[1].trust == 1.0
assert all(a.radius_km > sources.LOCAL_RADIUS_KM for a in sources.select(registry, None))  # no center: wide-area only
assert registry["calfire_butteco"].is_local(*camp.center)
assert not registry["redcross"].is_local(*camp.center)  # national: covers it, but not local

# ── focus: where (ping > incident center > stations) and when (incident window > live) ─────
NOW = 1_700_000_000_000_000  # 2023-11-14, micros
inc_row = dict(zip(["key", "name", "start", "news_from", "news_to", "location", "queries", "places"], glass.reducer_args()))
ping = {"lat": 38.578, "lon": -122.579, "label": "Calistoga"}
stations = [{"lat": 39.0, "lon": -121.0}, {"lat": 39.2, "lon": -121.2}]
f = resolve(ping, inc_row, glass.center, stations, now_micros=NOW, live_lookback_h=72)
assert (f.where, f.center, f.scope, f.live) == ("ping", (38.578, -122.579), "glass-fire-2020", False), f
assert f.contains(glass.news_from.timestamp() * 1e6) and not f.contains(NOW) and not f.contains(0)
assert f.describe() == "Calistoga (38.578, -122.579) · 2020-09-27 → 2020-10-20", f.describe()
f = resolve(None, inc_row, glass.center, stations, now_micros=NOW, live_lookback_h=72)
assert (f.where, f.center, f.label) == ("incident", glass.center, glass.location), f
f = resolve(None, None, None, stations, now_micros=NOW, live_lookback_h=72)
assert f.where == "stations" and abs(f.lat - 39.1) < 1e-9 and f.live and f.scope == ""
assert f.contains(NOW - 3600e6) and not f.contains(NOW - 73 * 3600e6) and f.describe().endswith("live, last 72 h")
f = resolve(None, None, None, [], now_micros=NOW, live_lookback_h=72)
assert f.center is None and f.where == "none"
assert resolve(ping, None, None, [], now_micros=NOW, live_lookback_h=72).signature() == \
    resolve({**ping, "lat": 38.5801}, None, None, [], now_micros=NOW + 60e6, live_lookback_h=72).signature()  # same place, a minute later
assert resolve(ping, None, None, [], now_micros=NOW, live_lookback_h=72).signature() != \
    resolve(ping, inc_row, None, [], now_micros=NOW, live_lookback_h=72).signature()  # live -> 2020 is a change
w = incidents.adhoc("2020-09-27", "2020-10-20", location="Calistoga")
assert w.key == "window-2020-09-27-2020-10-20" and w.news_to.hour == 23 and w.queries == [] and w.reducer_args()[6] == ""
try:
    incidents.adhoc("2020-10-20", "2020-09-27")
    raise AssertionError("a reversed window must be rejected")
except ValueError:
    pass

# ── X Posts records ─────────────────────────────────────────────────────────
assert brightdata.x_post_url("https://twitter.com/CAL_FIRE/status/123?s=20") == "https://x.com/CAL_FIRE/status/123"
assert brightdata.x_post_url("https://mobile.x.com/CAL_FIRE/status/123") == "https://x.com/CAL_FIRE/status/123"
assert brightdata.x_post_url("https://x.com/CAL_FIRE") is None
assert brightdata.x_post_url("https://example.com/CAL_FIRE/status/123") is None

row = {"id": "1", "user_posted": "CAL_FIRE", "name": "CAL FIRE", "description": "#CampFire update",
       "date_posted": "2018-11-08T18:00:00.000Z", "url": "https://x.com/CAL_FIRE/status/1", "hashtags": ["#CampFire"],
       "likes": "12", "views": None, "quoted_post": {"user_posted": "ButteSheriff", "description": "Evacuate Paradise now."}}
p = brightdata.normalize(row)
assert p.handle == "CAL_FIRE" and p.hashtags == ["CampFire"] and p.likes == 12 and p.views == 0
assert p.published_micros == 1541700000_000000, p.published_micros
assert "Quoting @ButteSheriff: Evacuate Paradise now." in p.text
assert brightdata.normalize({**row, "user_posted": None}).handle == "CAL_FIRE"  # handle from the URL
err = {"error": "Profile does not exist", "error_code": "dead_page", "input": {"url": "https://x.com/not_real_123"}}
assert brightdata.normalize(err) is None
assert brightdata.input_errors([row, err]) == ["https://x.com/not_real_123: Profile does not exist"]
assert brightdata.parse_rows('{"status": "building", "message": "not ready"}') is None
assert len(brightdata.parse_rows(json.dumps(row) + "\n" + json.dumps(err) + "\n")) == 2  # NDJSON

fixture = brightdata.load_fixture(AGENTS_ROOT / "fixtures" / "news_sample.json")
posts = [brightdata.normalize(r) for r in fixture]
assert len(posts) == 5 and all(posts) and all(q.published_micros > 0 for q in posts)

# ── signals and relevance ───────────────────────────────────────────────────
places = camp.places
evac, relief, wx, glass_post, fog = posts


def score(post, inc=camp):
    acct = sources.lookup(registry, post.handle)
    return extract(post.text, post.published_micros, inc.places, terms=inc.queries, trust=acct.trust,
                   local_source=acct.is_local(*inc.center), fixed_recency=1.0)


s = score(evac)
assert s.evacuation and "Skyway is closed" in s.closures and s.containment_pct == 0 and s.acres == 20_000, s
assert s.relevance >= 0.9 and not s.relief, s
s = score(relief)
assert "Shelters are open in Chico" in s.relief and "Large animals" in s.relief and s.relevance >= 0.5, s
s = score(wx)
assert 0.5 <= s.relevance < 0.9 and not s.location_match, s  # local forecaster, no place named: still relevant
assert score(glass_post).relevance <= 0.4  # a Napa fire is not about Paradise
assert score(glass_post, glass).relevance >= 0.9
assert score(glass_post, glass).closures == "Highway 29 is closed between St. Helena and Calistoga."
assert score(fog).relevance <= 0.4
sip = extract("Shelter in place in Magalia, do not evacuate", 0, places, trust=1.0)
assert sip.evacuation and not sip.relief, sip  # shelter-in-place is an order, not a shelter
assert extract("Fire grew to 12k acres", 0, [], trust=1.0).acres == 12_000


# ── Bright Data API (mocked) ────────────────────────────────────────────────
def mock(handler):
    calls = []

    def wrapped(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        return handler(req, len(calls))
    return httpx.MockTransport(wrapped), calls


def discover_flow(req: httpx.Request, n: int) -> httpx.Response:
    if req.url.path == "/datasets/v3/trigger":
        return httpx.Response(200, json={"snapshot_id": "s_test"})
    if req.url.path == "/datasets/v3/progress/s_test":
        return httpx.Response(200, json={"status": "running" if n < 3 else "ready"})
    if req.url.path == "/datasets/v3/snapshot/s_test":
        if n < 5:
            return httpx.Response(202, json={"status": "building", "message": "try again"})
        return httpx.Response(200, json=[row, err])
    return httpx.Response(404)


transport, calls = mock(discover_flow)
inputs = [{"url": a.url} for a in paradise[:2]]
rows = asyncio.run(brightdata.discover_posts("k", inputs, limit_per_input=7, poll_s=0, transport=transport))
assert rows == [row, err], rows
trig = calls[0]
assert trig.method == "POST" and trig.headers["authorization"] == "Bearer k"
assert dict(trig.url.params) == {"dataset_id": brightdata.X_POSTS_DATASET, "include_errors": "true",
                                 "type": "discover_new", "discover_by": "profile_url"}, trig.url.params
assert json.loads(trig.content) == {"input": inputs, "limit_per_input": 7}
assert [c.url.path for c in calls[1:]] == ["/datasets/v3/progress/s_test"] * 2 + ["/datasets/v3/snapshot/s_test",
                                                                              "/datasets/v3/progress/s_test", "/datasets/v3/snapshot/s_test"]

transport, calls = mock(lambda req, n: httpx.Response(200, json=[row]))
assert asyncio.run(brightdata.collect_posts("k", ["https://x.com/CAL_FIRE/status/1"], transport=transport)) == [row]
assert calls[0].url.path == "/datasets/v3/scrape" and json.loads(calls[0].content) == {"input": [{"url": "https://x.com/CAL_FIRE/status/1"}]}


def slow_scrape(req: httpx.Request, n: int) -> httpx.Response:
    if req.url.path == "/datasets/v3/scrape":
        return httpx.Response(202, json={"snapshot_id": "s_slow", "message": "still running"})
    if req.url.path.startswith("/datasets/v3/progress/"):
        return httpx.Response(200, json={"status": "ready"})
    return httpx.Response(200, text=json.dumps(row) + "\n")


transport, _ = mock(slow_scrape)
assert asyncio.run(brightdata.collect_posts("k", ["u"], poll_s=0, transport=transport)) == [row]

transport, _ = mock(lambda req, n: httpx.Response(200, json={"snapshot_id": "s_x"}) if n == 1
                    else httpx.Response(200, json={"status": "failed", "error": "bad input"}))
try:
    asyncio.run(brightdata.discover_posts("k", inputs, poll_s=0, transport=transport))
    raise AssertionError("a failed snapshot must raise")
except brightdata.BrightDataError as e:
    assert "failed" in str(e)
try:
    asyncio.run(brightdata.discover_posts("", inputs))
    raise AssertionError("a missing key must raise")
except brightdata.BrightDataError:
    pass

print("news checks passed")
