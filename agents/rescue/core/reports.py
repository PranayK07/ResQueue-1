"""How much a resident's field reports may move the picture. Pure: no network, no uAgents, so the RL
simulator can call it too.

The intake agent turns what a resident sent (text, voice transcript, photos, video frames) into CLAIMS
(report_assessment). The commander weighs them here before they touch danger or queues:

  claims about the resident's own party   people, needs, injured, trapped
      Same trust as the request form, which already lets anyone tick "medical": no new way to jump the
      queue. Applied right away (needs are unioned, headcount takes the larger number).

  claims about the world                  fire seen nearby, road blocked
      These would push THIS request up (an earlier fire ETA = less slack), so they must earn it, and words must
      earn more than pictures. Each request gets a credibility in [0, 1]:
        analyzer confidence (does the text/media hold together)
        x 1.0 if the photos / video frames themselves show it (vision model), x TEXT_WEIGHT if it's only words
        x a factor from PLAUSIBILITY: 1.15 when the fire model agrees with where they are, down to 0.57 when it doesn't
        + 0.2 per other resident reporting fire within CORROBORATE_M in the last CORROBORATE_S (max +0.4)
        TEXT ALONE NEVER CROSSES CREDIBLE: without supporting media it is capped just below, unless at least
        TEXT_CORROBORATORS other residents nearby report the same
      >= CREDIBLE : applied. The fire ETA moves earlier (never later) to when fire at the reported distance
                    would arrive at the fire's head speed; a blocked road adds ACCESS_PENALTY_S on scene
                    (crews finish on foot or clear the road). Both feed danger -> slack -> every policy.
      below CREDIBLE : not applied; recorded and shown to responders next to the raw reports, which they always see
                    unfiltered. There is no review queue: responders read the evidence themselves, and the agent only
                    decides how much of it moves the automatic queue order.

None of this assigns stations: routing (time-dependent shortest paths on the grid) gives each request a
travel time per station, and the policy (heuristic or RL) chooses."""
from __future__ import annotations

import math
from dataclasses import dataclass

from .geo import haversine_m

CREDIBLE = 0.6
CORROBORATE_M = 1500.0
CORROBORATE_S = 1800.0  # real seconds between the two residents' assessments
ACCESS_PENALTY_S = 600.0
TEXT_WEIGHT = 0.5  # words alone count half of what a photo / video showing it counts
TEXT_CORROBORATORS = 2  # other residents nearby needed before text alone can be applied
DEFAULT_FIRE_DISTANCE_M = 800.0  # "I can see flames" with no distance given
DEFAULT_HEAD_KMH = 2.0
MIN_HINT_S = 120.0
NEAR_FIRE_M = 3000.0  # default spotting radius: embers start new fires this far ahead of the front
NEAR_ETA_S = 3600.0
FAR_ETA_S = 7200.0


def spot_radius_m(wind_mps: float) -> float:
    """How far ahead of the front embers can start new fires: grows with wind (12 m/s -> 2.8 km)."""
    return max(1500.0, min(6000.0, 1000.0 + 150.0 * max(0.0, wind_mps)))

KNOWN_NEEDS = ("mobility", "medical", "oxygen", "infant", "elderly", "pets", "language")


@dataclass(frozen=True)
class Claims:
    """One request's report_assessment row (what the intake agent read), plus where the request is."""
    request_id: int
    lat: float
    lon: float
    updated_s: float  # real unix seconds of the assessment
    report_count: int = 0
    people: int = 0
    needs: str = ""
    injured: bool = False
    trapped: bool = False
    fire_seen: bool = False
    fire_distance_m: float = -1.0
    smoke: bool = False
    road_blocked: bool = False
    road_note: str = ""
    media_supports: bool = False
    confidence: float = 0.0
    urgency: float = 0.0
    summary: str = ""

    @classmethod
    def from_row(cls, row: dict, lat: float, lon: float) -> "Claims":
        return cls(
            request_id=row["request_id"], lat=lat, lon=lon, updated_s=row["updated_at"] / 1e6,
            report_count=row["report_count"], people=row["people"], needs=row["needs"], injured=row["injured"],
            trapped=row["trapped"], fire_seen=row["fire_seen"], fire_distance_m=row["fire_distance_m"], smoke=row["smoke"],
            road_blocked=row["road_blocked"], road_note=row["road_note"], media_supports=row["media_supports"],
            confidence=row["confidence"], urgency=row["urgency"], summary=row["summary"],
        )


@dataclass(frozen=True)
class LocalHazard:
    """What the hazard model says at the request's location."""
    now_s: float  # sim seconds
    fire_eta_s: float  # p10 arrival from the forecast (absolute sim s); inf = beyond the horizon
    nearest_burning_m: float  # distance to the nearest burning cell; inf = none
    spot_radius_m: float = NEAR_FIRE_M  # wind-dependent spotting distance (spot_radius_m(wind))


@dataclass
class Weighed:
    """What the commander applies for one request."""
    request_id: int
    credibility: float
    headcount: int
    needs: str
    trapped: bool
    injured: bool
    fire_eta_hint_s: float | None  # earliest fire arrival implied by a credible sighting (absolute sim s)
    access_penalty_s: float  # added to on-scene time for a credible blocked road
    reported_urgency: float  # analyzer urgency x credibility, 0..1 (a policy feature)
    note: str  # one line for the commander / plan reason

    @property
    def fire_credible(self) -> bool:
        return self.fire_eta_hint_s is not None


def merge_needs(*lists: str) -> str:
    seen: list[str] = []
    for item in ",".join(lists).split(","):
        n = item.strip().lower()
        if n in KNOWN_NEEDS and n not in seen:
            seen.append(n)
    return ",".join(seen)


def corroboration(claims: list[Claims]) -> dict[int, int]:
    """For each fire sighting: how many OTHER requests also report fire nearby at about the same time."""
    sightings = [c for c in claims if c.fire_seen]
    out: dict[int, int] = {}
    for c in sightings:
        out[c.request_id] = sum(
            1 for o in sightings
            if o.request_id != c.request_id and abs(o.updated_s - c.updated_s) <= CORROBORATE_S
            and haversine_m(c.lat, c.lon, o.lat, o.lon) <= CORROBORATE_M)
    return out


def plausibility(c: Claims, hazard: LocalHazard) -> float:
    """How well a sighting fits the fire model and weather AT THIS PERSON'S LOCATION, 0..1.

    Flames near them are plausible if the fire is burning within spotting range, or the forecast brings it here
    soon; implausible if nothing is burning near and the forecast has no fire here for hours. A claim that puts
    flames much closer than the burning cells are is penalised. A blocked road alone is plausible anywhere
    (trees, wires and traffic block roads in wind storms and evacuations), so it scores a flat 0.7."""
    if not c.fire_seen:
        return 0.7 if c.road_blocked else 1.0
    eta_left = hazard.fire_eta_s - hazard.now_s
    if hazard.nearest_burning_m <= hazard.spot_radius_m:
        p = 1.0
    elif eta_left <= NEAR_ETA_S:
        p = 0.8
    elif eta_left <= FAR_ETA_S:
        p = 0.4
    else:
        p = 0.1
    if c.fire_distance_m >= 0 and math.isfinite(hazard.nearest_burning_m) and c.fire_distance_m + hazard.spot_radius_m < hazard.nearest_burning_m:
        p *= 0.5  # says flames are closer than the burning cells could have thrown embers
    return p


def credibility(c: Claims, hazard: LocalHazard, corroborators: int = 0) -> float:
    score = max(0.0, min(1.0, c.confidence)) * (1.0 if c.media_supports else TEXT_WEIGHT)
    if c.fire_seen:
        score *= 0.5 + 0.65 * plausibility(c, hazard)  # 1.15 when it fits the picture, 0.57 when it doesn't
    score += 0.2 * min(corroborators, 2)
    if not c.media_supports and corroborators < TEXT_CORROBORATORS:
        score = min(score, CREDIBLE - 0.01)  # words nobody corroborates never move the automatic queue
    return max(0.0, min(1.0, score))


def weigh(c: Claims, headcount: int, needs: str, hazard: LocalHazard, *, corroborators: int = 0,
          head_kmh: float | None = None) -> Weighed:
    cred = credibility(c, hazard, corroborators)
    party_needs = merge_needs(needs, c.needs, "medical" if c.injured else "")
    party_size = max(headcount, min(c.people, 50))

    hint = None
    if c.fire_seen and cred >= CREDIBLE:
        dist = c.fire_distance_m if c.fire_distance_m >= 0 else DEFAULT_FIRE_DISTANCE_M
        speed = max(head_kmh or DEFAULT_HEAD_KMH, 0.5) / 3.6
        hint = hazard.now_s + max(MIN_HINT_S, dist / speed)
        if hint >= hazard.fire_eta_s:
            hint = None  # the model already expects it sooner; a report never pushes fire later
    penalty = ACCESS_PENALTY_S if c.road_blocked and cred >= CREDIBLE else 0.0

    # World claims below the bar are not applied. Say so in the plan reason, so a commander reading it knows the
    # resident said something the automatic order did not act on.
    unapplied = [] if cred >= CREDIBLE else [
        what for what, said in (("fire seen", c.fire_seen), ("road blocked", c.road_blocked)) if said]

    bits = []
    if hint is not None:
        bits.append(f"credible fire sighting ~{(c.fire_distance_m if c.fire_distance_m >= 0 else DEFAULT_FIRE_DISTANCE_M):.0f} m away")
    if penalty:
        bits.append("road reported blocked")
    if c.trapped:
        bits.append("people trapped")
    if c.injured:
        bits.append("injured")
    if unapplied:
        bits.append(f"{' and '.join(unapplied)} reported but not acted on ({'photo/video' if c.media_supports else 'text only'}, "
                    f"credibility {cred:.2f})")
    return Weighed(
        request_id=c.request_id, credibility=round(cred, 3), headcount=party_size, needs=party_needs,
        trapped=c.trapped, injured=c.injured, fire_eta_hint_s=hint,
        access_penalty_s=penalty, reported_urgency=round(max(0.0, min(1.0, c.urgency)) * cred, 3),
        note="; ".join(bits),
    )


def summarize(weighed: list[Weighed]) -> dict:
    """Counts for the `situation` record (and the policy's feature vector)."""
    return dict(
        reports_active=len(weighed),
        reports_fire_credible=sum(w.fire_credible for w in weighed),
        reports_road_blocks=sum(w.access_penalty_s > 0 for w in weighed),
        reports_trapped=sum(w.trapped for w in weighed),
    )
