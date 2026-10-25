"""Turn a post into hints for the commander: evacuations, road closures, shelters and relief, containment, size,
and how relevant it is to THIS incident. Hints only — nothing here changes roads or queues; the commander decides."""
from __future__ import annotations

import re
import time
from dataclasses import dataclass

_EVAC = re.compile(r"\bevac(?:uat(?:e|ed|ion|ions|ing))?\b|\bshelter[- ]in[- ]place\b", re.I)
_ROAD = (r"(?:Highway|Hwy\.?|Road|Rd\.?|Route|SR[- ]?\d+|I-\d+|Interstate|Skyway|Blvd\.?|Boulevard|Avenue|Ave\.?|"
         r"Freeway|Parkway|Trail)")
_CLOSE = re.compile(r"\b(?:clos(?:e|ed|ing|ure|ures)|shut(?: down)?|blocked)\b", re.I)
_ROADRE = re.compile(_ROAD, re.I)
_RELIEF = re.compile(r"\b(?:shelters?|evacuation (?:cent(?:er|re)s?|points?|sites?)|temporary evacuation points?|"
                     r"red cross|relief|donations?|(?:assistance|resource|recovery) cent(?:er|re)s?|"
                     r"(?:food|water|supplies) distribution|large animals?)\b", re.I)
_SHELTER_IN_PLACE = re.compile(r"shelter(?:ing)?[- ]in[- ]place", re.I)
_CONTAIN = re.compile(r"(\d{1,3})\s?%\s*(?:contain|of the (?:fire|blaze))|contain(?:ed|ment)[^.%]{0,40}?(\d{1,3})\s?%", re.I)
_ACRES = re.compile(r"(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(thousand|million|k)?\s*acres", re.I)
_FIRE_WORDS = ("wildfire", "fire", "blaze", "evacuat", "red flag", "contain", "cal fire", "burn", "smoke")
# Sentence breaks, but not after the abbreviations in place and road names ("St. Helena", "Hwy. 70").
_SENT = re.compile(r"(?<!\bSt\.)(?<!\bMt\.)(?<!\bRd\.)(?<!\bHwy\.)(?<!\bAve\.)(?<=[.!?])\s+|\n+")


@dataclass
class Signals:
    summary: str
    evacuation: bool
    closures: str  # " | "-joined sentences
    relief: str  # shelter / relief sentences, " | "-joined
    containment_pct: float  # -1 unknown
    acres: float  # -1 unknown
    location_match: str  # comma list
    relevance: float


def _squash(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def extract(text: str, published_micros: int, places: list[str], *, terms: list[str] = (), trust: float = 0.4,
            local_source: bool = False, now_s: float | None = None, fixed_recency: float | None = None) -> Signals:
    """`terms` name the incident ("Camp Fire" also matches #CampFire). `trust` is the account's (sources.Account.trust);
    `local_source` = the account covers the incident area, so its posts are about it even without a place name.
    `fixed_recency` replaces the wall-clock recency term: pass 1.0 when the post has already been date-filtered into
    an incident's news window (a 2020 post is not 'stale' for a 2020 replay)."""
    sentences = [s.strip() for s in _SENT.split(text) if s.strip()]
    closures = [s for s in sentences if _CLOSE.search(s) and _ROADRE.search(s)]
    relief = [s for s in sentences if _RELIEF.search(_SHELTER_IN_PLACE.sub("", s))]
    contain = [int(a or b) for a, b in _CONTAIN.findall(text) if 0 <= int(a or b) <= 100]
    acres = []
    for num, mult in _ACRES.findall(text):
        v = float(num.replace(",", ""))
        acres.append(v * {"thousand": 1_000, "k": 1_000, "million": 1_000_000}.get((mult or "").lower(), 1))
    low = text.lower()
    matched = [p for p in places if p and re.search(rf"\b{re.escape(p.lower())}\b", low)]
    squashed = _squash(text)
    named = any(len(_squash(t)) >= 5 and _squash(t) in squashed for t in terms)

    # relevance: topic (0.3) + incident place / name (0.35) + recency (0.2) + account trust (0.15)
    topic = min(1.0, sum(w in low for w in _FIRE_WORDS) / 2)
    place = 1.0 if named else min(1.0, len(matched) / 2)
    if local_source:
        place = max(place, 0.5)
    if fixed_recency is not None:
        recency = fixed_recency
    elif published_micros > 0:
        age_days = ((now_s or time.time()) - published_micros / 1e6) / 86400
        recency = 1.0 if age_days <= 2 else 0.6 if age_days <= 7 else 0.2 if age_days <= 30 else 0.0
    else:
        recency = 0.3
    relevance = round(0.3 * topic + 0.35 * place + 0.2 * recency + 0.15 * trust, 3)
    if not (matched or named or local_source):
        relevance = min(relevance, 0.4)  # not about our incident area

    summary = text.strip().replace("\n", " ")
    if len(summary) > 600:
        summary = summary[:597].rsplit(" ", 1)[0] + "..."
    return Signals(
        summary=summary,
        evacuation=bool(_EVAC.search(text)),
        closures=" | ".join(c[:250] for c in closures[:4]),
        relief=" | ".join(r[:250] for r in relief[:3]),
        containment_pct=float(max(contain)) if contain else -1.0,
        acres=max(acres) if acres else -1.0,
        location_match=",".join(matched),
        relevance=relevance,
    )
