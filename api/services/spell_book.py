"""Spell Book scoring (roleApp spec, section 4).

Pure functions only: no database or web imports, so the formula can be unit
tested and recomputed from raw word events whenever the weights change.

    S = min(100, max(0, sum(w(e) * 2 ** (-age_days(e) / 14))))

Status: red S >= 60, yellow 30 <= S < 60, green S < 30 with >= 2 successes,
otherwise new.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Optional

HALF_LIFE_DAYS = 14.0
RED_THRESHOLD = 60.0
YELLOW_THRESHOLD = 30.0
GREEN_MIN_SUCCESSES = 2

# Event type -> weight. Positive = struggle, negative = progress.
WEIGHTS: dict[str, float] = {
    "meaning_fail": 25.0,
    "pronunciation_fail": 20.0,
    "usage_fail": 15.0,
    "passive_encounter": -3.0,
    "context_success": -10.0,
    "active_success": -15.0,
}

FAIL_TYPES = {"meaning_fail", "pronunciation_fail", "usage_fail"}
SUCCESS_TYPES = {"context_success", "active_success"}


@dataclass(frozen=True)
class WordEventData:
    lemma: str
    event_type: str
    created_at: datetime
    location: Optional[str] = None
    surface_form: Optional[str] = None
    example: Optional[str] = None


def normalize_lemma(text: str) -> str:
    return " ".join(text.strip().lower().split())


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def decay(age_days: float) -> float:
    return 2.0 ** (-max(0.0, age_days) / HALF_LIFE_DAYS)


def struggle_score(events: Iterable[WordEventData], now: datetime) -> float:
    now_utc = _as_utc(now)
    total = 0.0
    for event in events:
        weight = WEIGHTS.get(event.event_type)
        if weight is None:
            continue
        age_days = (now_utc - _as_utc(event.created_at)).total_seconds() / 86400.0
        total += weight * decay(age_days)
    return round(min(100.0, max(0.0, total)), 1)


def status_for(score: float, successes: int) -> str:
    if score >= RED_THRESHOLD:
        return "red"
    if score >= YELLOW_THRESHOLD:
        return "yellow"
    if successes >= GREEN_MIN_SUCCESSES:
        return "green"
    return "new"


_STATUS_ORDER = {"red": 0, "yellow": 1, "new": 2, "green": 3}


def build_spell_book(events: Iterable[WordEventData], now: datetime) -> list[dict]:
    """Groups raw events by lemma and returns one entry per word, hardest first."""
    by_lemma: dict[str, list[WordEventData]] = {}
    for event in events:
        lemma = normalize_lemma(event.lemma)
        if lemma:
            by_lemma.setdefault(lemma, []).append(event)

    entries = []
    for lemma, word_events in by_lemma.items():
        word_events.sort(key=lambda e: _as_utc(e.created_at))
        score = struggle_score(word_events, now)
        counts = {t: 0 for t in WEIGHTS}
        for e in word_events:
            if e.event_type in counts:
                counts[e.event_type] += 1
        successes = sum(counts[t] for t in SUCCESS_TYPES)
        sources = sorted({e.location for e in word_events if e.location})
        examples = [e.example for e in word_events if e.example]
        last = word_events[-1]
        entries.append(
            {
                "lemma": lemma,
                "status": status_for(score, successes),
                "struggle_score": score,
                "meaning_fails": counts["meaning_fail"],
                "pronunciation_fails": counts["pronunciation_fail"],
                "usage_fails": counts["usage_fail"],
                "active_successes": successes,
                "sources": sources,
                "example": examples[-1] if examples else None,
                "last_event_at": _as_utc(last.created_at).isoformat(),
            }
        )

    entries.sort(key=lambda e: (_STATUS_ORDER[e["status"]], -e["struggle_score"], e["lemma"]))
    return entries


# --- NPC injection (roleApp 4.5) -------------------------------------------

MAX_FOCUS_WORDS = 2
DAILY_WORD_LIMIT = 3
DAILY_NPC_LIMIT = 2
SAME_PLACE_BONUS = 1.5


@dataclass(frozen=True)
class DailyExposure:
    """How often a word was already put into NPC replies today, and where."""

    count: int = 0
    locations: frozenset[str] = frozenset()


def select_focus_words(
    entries: Iterable[dict],
    location: str,
    exposure_today: dict[str, DailyExposure] | None = None,
    limit: int = MAX_FOCUS_WORDS,
) -> list[str]:
    """Picks up to `limit` red/yellow words for an NPC at `location`.

    Priority = struggle_score, x1.5 when the word was met at this place (a cheap
    stand-in for the spec's embedding-based context fit). Daily quota: a word is
    injected at most 3 times a day and by at most 2 different places.
    """
    exposure_today = exposure_today or {}
    candidates = []
    for entry in entries:
        if entry.get("status") not in ("red", "yellow"):
            continue
        lemma = entry["lemma"]
        seen = exposure_today.get(lemma, DailyExposure())
        if seen.count >= DAILY_WORD_LIMIT:
            continue
        if location not in seen.locations and len(seen.locations) >= DAILY_NPC_LIMIT:
            continue
        priority = float(entry.get("struggle_score", 0.0))
        if location in entry.get("sources", []):
            priority *= SAME_PLACE_BONUS
        red_first = 0 if entry["status"] == "red" else 1
        candidates.append((red_first, -priority, lemma))
    candidates.sort()
    return [lemma for _, _, lemma in candidates[:limit]]


def find_used_words(text: str, words: Iterable[str]) -> list[str]:
    """Words from `words` that appear in `text` (whole word, simple inflections)."""
    used = []
    lowered = text.lower()
    for word in words:
        lemma = normalize_lemma(word)
        if not lemma:
            continue
        pattern = r"\b" + re.escape(lemma) + r"(?:s|es|ed|d|ing)?\b"
        if re.search(pattern, lowered):
            used.append(lemma)
    return used
