"""Plain-assert checks for field reports: intake reading (offline), the commander's weighing, and how it reaches
danger, the policy input and the Situation. No network, no model calls. Run: ../venv/bin/python scripts/test_reports.py"""
from __future__ import annotations

import asyncio
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rescue.core.danger import assess_requests, local_hazard  # noqa: E402
from rescue.core.geo import Grid  # noqa: E402
from rescue.core.policy import LookaheadPolicy  # noqa: E402
from rescue.core.reports import (ACCESS_PENALTY_S, CREDIBLE, Claims, LocalHazard, corroboration, credibility,  # noqa: E402
                                 plausibility, spot_radius_m, summarize, weigh)
from rescue.messages import Assessment  # noqa: E402
from rescue.core.situation import FEATURE_NAMES, Situation  # noqa: E402
from rescue.intake.analysis import Analyzer, ReportIn, VisionAnalyzer, keyword_reading, parse_reading, to_assessment  # noqa: E402
from rescue.planning import build_plan_input  # noqa: E402

NOW = 1000.0
NEAR = LocalHazard(now_s=NOW, fire_eta_s=NOW + 2400, nearest_burning_m=1200)  # hazard model sees fire close by
QUIET = LocalHazard(now_s=NOW, fire_eta_s=math.inf, nearest_burning_m=math.inf)  # hazard model sees nothing


def claims(rid=1, lat=39.76, lon=-121.62, t=0.0, **kw):
    return Claims(request_id=rid, lat=lat, lon=lon, updated_s=t, **kw)


# ── weighing ────────────────────────────────────────────────────────────────

# Party claims: form-level trust, applied without credibility (the form already allows ticking "medical").
w = weigh(claims(people=4, needs="mobility", injured=True, confidence=0.1), 2, "infant", QUIET)
assert w.headcount == 4 and w.needs == "infant,mobility,medical" and w.injured, w
assert w.fire_eta_hint_s is None and w.access_penalty_s == 0  # nothing about the world claimed

# Photo shows the fire, hazard model agrees: credible -> ETA moves earlier, road penalty applies.
fire = dict(fire_seen=True, fire_distance_m=300, media_supports=True, road_blocked=True, confidence=0.8, urgency=0.9)
w = weigh(claims(**fire), 2, "", NEAR, head_kmh=3.6)
assert w.credibility >= CREDIBLE, w.credibility
assert w.fire_eta_hint_s is not None and abs(w.fire_eta_hint_s - (NOW + 300)) < 1e-6, w.fire_eta_hint_s  # 300 m at 1 m/s
assert w.access_penalty_s == ACCESS_PENALTY_S and "fire sighting" in w.note and "not acted on" not in w.note

# Same words, no supporting photo: never applied on their own, wherever the person is, and the plan reason says so.
words = dict(fire, media_supports=False)
for hz in (NEAR, QUIET):
    w = weigh(claims(**words), 2, "", hz)
    assert w.fire_eta_hint_s is None and w.access_penalty_s == 0 and w.credibility < CREDIBLE, w
    assert "fire seen and road blocked reported but not acted on (text only" in w.note, w.note
# Their own party (trapped / injured) is applied, not held back.
w = weigh(claims(trapped=True, injured=True, confidence=0.6), 1, "", NEAR)
assert w.trapped and w.injured and "not acted on" not in w.note, w

# Plausibility is location + fire + weather: burning cells within the (wind-dependent) spotting radius, or the
# forecast reaching them soon, fit; nothing near and no fire for hours doesn't.
assert spot_radius_m(0) == 1500 and spot_radius_m(12) == 2800 and spot_radius_m(100) == 6000
assert plausibility(claims(**words), NEAR) == 1.0
assert plausibility(claims(**dict(words, fire_distance_m=-1)), LocalHazard(NOW, NOW + 3000, 9000)) == 0.8  # forecast arrives within the hour
assert plausibility(claims(**words), QUIET) == 0.1
calm = LocalHazard(NOW, math.inf, 4000, spot_radius_m=spot_radius_m(0))  # nearest flames 4 km away, calm wind
windy = LocalHazard(NOW, math.inf, 4000, spot_radius_m=spot_radius_m(20))  # same, but embers can fly 4 km
assert plausibility(claims(**words), calm) < plausibility(claims(**words), windy) == 1.0
assert plausibility(claims(**dict(words, fire_distance_m=100)), LocalHazard(NOW, NOW + 3000, 9000)) == 0.4  # flames "100 m" away, burning 9 km off

# Text carries a higher bar than pictures: words alone never cross CREDIBLE, however confident and however
# well they match the hazard model, while the same claim with a photo showing it does.
assert credibility(claims(**dict(words, confidence=1.0)), NEAR) < CREDIBLE
assert credibility(claims(**dict(fire, confidence=0.6)), NEAR) >= CREDIBLE

# Neighbours reporting fire within 1.5 km and 30 min corroborate; text needs two of them to be applied.
cs = [claims(1, **words), claims(2, lat=39.765, t=600, **words), claims(3, lat=39.80, t=0, **words)]  # #3 is ~4.5 km away
corr = corroboration(cs)
assert corr == {1: 1, 2: 1, 3: 0}, corr
assert credibility(cs[0], QUIET, 1) > credibility(cs[0], QUIET, 0)
assert credibility(claims(**dict(words, confidence=0.8)), NEAR, 1) < CREDIBLE  # one neighbour: still a responder's call
assert credibility(claims(**dict(words, confidence=0.8)), NEAR, 2) >= CREDIBLE  # two neighbours + hazard model agree

# A report never pushes the fire LATER than the model.
late = weigh(claims(**dict(fire, fire_distance_m=50_000)), 2, "", NEAR)
assert late.fire_eta_hint_s is None, late.fire_eta_hint_s

# Analyzer output is untrusted: confidence 1.0 with nothing but words still can't pass on its own when the model disagrees.
w = weigh(claims(**dict(words, confidence=1.0)), 2, "", QUIET)
assert w.fire_eta_hint_s is None, w

s = summarize([weigh(claims(**fire), 2, "", NEAR), weigh(claims(2, **words), 2, "", NEAR),
               weigh(claims(3, trapped=True, confidence=0.5), 1, "", QUIET)])
assert s == dict(reports_active=3, reports_fire_credible=1, reports_road_blocks=1, reports_trapped=1), s

# ── danger: accepted adjustments reach slack ────────────────────────────────

grid = Grid.from_row({"id": 0, "origin_lat": 39.70, "origin_lon": -121.70, "rows": 40, "cols": 40, "cell_size_m": 250.0})
assert grid.valid
rlat, rlon = grid.center(grid.cell_id(20, 20))
slat, slon = grid.center(grid.cell_id(5, 5))
forecast = {grid.cell_id(20, 20): NOW + 3600}
burning = {grid.cell_id(20, 30)}
hz = local_hazard(grid, NOW, rlat, rlon, forecast, burning)
assert hz.fire_eta_s == NOW + 3600 and 2000 < hz.nearest_burning_m < 3000, hz
base, travel = assess_requests(grid, NOW, [(1, rlat, rlon, 2, "")], [(1, slat, slon)], forecast, burning, [])
adj, _ = assess_requests(grid, NOW, [(1, rlat, rlon, 2, "")], [(1, slat, slon)], forecast, burning, [],
                         adjust={1: (NOW + 900, ACCESS_PENALTY_S)})
assert adj[0]["fire_eta_s"] == NOW + 900 and adj[0]["extract_s"] == base[0]["extract_s"] + ACCESS_PENALTY_S
assert adj[0]["slack_s"] < base[0]["slack_s"] - 2700, (base[0], adj[0])

# ── planning: held requests and report features ─────────────────────────────

stations = [{"id": 1, "name": "A"}]
units = [{"id": 1, "station_id": 1, "callsign": "A1", "status": "available", "free_at_s": 0.0}]


def req(i):
    return {"id": i, "headcount": 2, "needs": "", "status": "pending", "fire_eta_s": NOW + 3000, "extract_s": 330.0,
            "pinned_station_id": 0, "created_sim_s": 0.0, "location_purged": False}


tr = [{"request_id": i, "station_id": 1, "travel_s": 600.0, "reachable": True} for i in (1, 2, 3)]
weighed = {1: weigh(claims(1, people=5, trapped=True, **fire), 2, "", NEAR)}
inp = build_plan_input(NOW, [req(1), req(2), req(3)], tr, units, stations, weighed=weighed, hold={2, 3},
                       queue=[{"request_id": 3, "station_id": 1}])
ids = [r.id for r in inp.requests]
assert ids == [1, 3], ids  # 2 waits for intake; 3 is already queued, so it keeps its place
r1 = inp.requests[0]
assert r1.headcount == 5 and r1.trapped and r1.credibility >= CREDIBLE and r1.reported_urgency > 0 and r1.report_note
plan = LookaheadPolicy().plan(inp)
assert any("resident reports" in e.reason for e in plan.entries if e.request_id == 1), [e.reason for e in plan.entries]

# ── Situation feature vector ────────────────────────────────────────────────

sit = Situation(sim_s=0, incident="", fire_area_sq_km=1, fire_growth_sq_km=0, fire_heading_deg=0, fire_head_kmh=1,
                wind_speed_mps=5, wind_from_deg=0, gust_mps=7, humidity_pct=20, red_flag=False, news_ok=True,
                news_relevant=1, news_evacuation=False, news_closures=0, news_max_containment_pct=-1, news_max_acres=-1,
                stations_json="[]", summary="", **s)
vec = sit.feature_vector()
assert len(vec) == len(FEATURE_NAMES) == 28, (len(vec), len(FEATURE_NAMES))
assert vec[-4:] == [0.3, 0.1, 0.1, 0.1], vec[-4:]
assert set(s) <= set(sit.to_row())  # record_situation gets the report counts

# ── intake reading (offline) ────────────────────────────────────────────────

rd = keyword_reading(["3 of us, grandma uses a wheelchair. Flames about 200 feet behind the house, "
                      "tree down across the road, we can't get out"], has_media=False)
assert rd.people == 3 and {"mobility", "elderly"} <= set(rd.needs), rd
assert rd.fire_seen and abs(rd.fire_distance_m - 60.96) < 0.01 and rd.road_blocked and rd.trapped, rd
assert not rd.media_supports  # keywords never vouch for a photo

a = to_assessment(7, 2, rd, "keywords")
assert a["request_id"] == 7 and a["needs"] == ",".join(rd.needs) and 0 <= a["confidence"] <= 1
assert Assessment(**a).dict() == a  # what intake sends the commander is exactly what publish_assessment takes
form = {"id": 7, "headcount": 1, "needs": "", "note": ""}
assert asyncio.run(Analyzer("keywords", "").assess(form, []))["analyzer"] == "form"  # bare ping: released at once
got = asyncio.run(Analyzer("keywords", "").assess(form, [ReportIn(1, "voice", "smoke everywhere, my son is hurt", "", ())]))
assert got["analyzer"] == "keywords" and got["injured"] and got["smoke"] and got["report_count"] == 1, got
assert Analyzer("hf", "Qwen/Qwen3-VL-30B-A3B-Instruct", token="").name == "keywords"  # no HF_TOKEN: offline mode

# What the vision model would be sent: text as delimited resident data, photos and video frames by URL, newest 8 images.
rows = [ReportIn(1, "text", "fire behind us", "", ()), ReportIn(2, "image", "", "https://x/p.jpg", ()),
        ReportIn(3, "video", "", "https://x/v.mp4", tuple(f"https://x/f{i}.jpg" for i in range(9)))]
content = VisionAnalyzer._content(None, "1 people", rows)  # type: ignore[arg-type]
imgs = [c["image_url"]["url"] for c in content if c["type"] == "image_url"]
assert len(imgs) == 8 and "https://x/p.jpg" not in imgs and "https://x/v.mp4" not in imgs, imgs
assert any("<resident_text>" in c.get("text", "") for c in content)

# Model output: JSON inside a code fence is fine, unknown needs are dropped, missing fields fail (-> keyword fallback).
out = parse_reading('```json\n{"people": 2, "needs": ["mobility", "jetpack"], "injured": false, "trapped": true, '
                    '"fire_seen": true, "fire_distance_m": 120, "smoke": true, "road_blocked": false, "road_note": "", '
                    '"media_supports": true, "confidence": 0.8, "urgency": 0.9, "summary": "s", "resident_reply": "r"}\n```')
assert out.needs == ["mobility"] and out.trapped and out.media_supports, out
try:
    parse_reading('{"people": 2}')
    raise AssertionError("incomplete reading accepted")
except ValueError:
    pass

print("report checks passed (weighing, text bar, plausibility, corroboration, danger adjust, hold, features, intake reading)")
