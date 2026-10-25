"""Turn an article into hints for the commander: evacuations, road closures,
containment, size, and how relevant it is to THIS incident. Hints only —
nothing here changes roads or queues; the commander decides."""
from __future__ import annotations

import re
import time
from dataclasses import dataclass

_EVAC = re.compile(r"\bevacuat(?:e|ed|ion|ions|ing)\b|\bshelter[- ]in[- ]place\b", re.I)
_ROAD = r"(?:Highway|Hwy\.?|Road|Rd\.?|Route|I-\d+|Interstate|Skyway|Blvd\.?|Boulevard|Avenue|Ave\.?|Freeway|Parkway)"
_CLOSE = re.compile(r"\b(?:clos(?:e|ed|ing|ure|ures)|shut(?: down)?|blocked)\b", re.I)
_ROADRE = re.compile(_ROAD, re.I)
_CONTAIN = re.compile(r"(\d{1,3})\s?%\s*(?:contain|of the (?:fire|blaze))|contain(?:ed|ment)[^.%]{0,40}?(\d{1,3})\s?%", re.I)
_ACRES = re.compile(r"(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(thousand|million)?\s*acres", re.I)
_FIRE_WORDS = ("wildfire", "fire", "blaze", "evacuat", "red flag", "containment", "cal fire", "burn")
_SENT = re.compile(r"(?<=[.!?])\s+|\n+")


@dataclass
class Signals:
    summary: str
    evacuation: bool
    closures: str  # " | "-joined sentences
    containment_pct: float  # -1 unknown
    acres: float  # -1 unknown
    location_match: str  # comma list
    relevance: float


def extract(title: str, content: str, published_micros: int, places: list[str], *, now_s: float | None = None,
            fixed_recency: float | None = None) -> Signals:
    """`fixed_recency` replaces the wall-clock recency term: pass 1.0 when the article has already
    been date-filtered into an incident's news window (a 2020 article is not 'stale' for a 2020 replay)."""
    text = f"{title}\n{content}"
    sentences = [s.strip() for s in _SENT.split(content) if s.strip()]
    closures = [s for s in sentences if _CLOSE.search(s) and _ROADRE.search(s)]
    contain = [int(a or b) for a, b in _CONTAIN.findall(text) if 0 <= int(a or b) <= 100]
    acres = []
    for num, mult in _ACRES.findall(text):
        v = float(num.replace(",", ""))
        acres.append(v * (1_000 if (mult or "").lower() == "thousand" else 1_000_000 if mult else 1))
    low = text.lower()
    matched = [p for p in places if p and re.search(rf"\b{re.escape(p.lower())}\b", low)]

    # relevance: topic (0.35) + incident location (0.4) + recency (0.25)
    topic = min(1.0, sum(w in low for w in _FIRE_WORDS) / 3)
    loc = min(1.0, len(matched) / 2)
    if fixed_recency is not None:
        recency = fixed_recency
    elif published_micros > 0:
        age_days = ((now_s or time.time()) - published_micros / 1e6) / 86400
        recency = 1.0 if age_days <= 2 else 0.6 if age_days <= 7 else 0.2 if age_days <= 30 else 0.0
    else:
        recency = 0.3
    relevance = round(0.35 * topic + 0.4 * loc + 0.25 * recency, 3)
    if not matched:
        relevance = min(relevance, 0.4)  # not about our incident area

    summary = content.strip().replace("\n", " ")
    if len(summary) > 600:
        summary = summary[:597].rsplit(" ", 1)[0] + "..."
    return Signals(
        summary=summary,
        evacuation=bool(_EVAC.search(text)),
        closures=" | ".join(c[:250] for c in closures[:4]),
        containment_pct=float(max(contain)) if contain else -1.0,
        acres=max(acres) if acres else -1.0,
        location_match=",".join(matched),
        relevance=relevance,
    )
