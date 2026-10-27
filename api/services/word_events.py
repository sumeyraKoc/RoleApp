"""Raw word events behind the Spell Book (roleApp spec 4.1).

Every signal about a word is stored as one row; the Spell Book view is always
recomputed from these rows by services/spell_book.py.
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from models.models import WordEvent
from services.spell_book import (
    DailyExposure,
    WordEventData,
    build_spell_book,
    find_used_words,
    normalize_lemma,
    select_focus_words,
)
from shared.schemas import ExtractionResult

# Extraction error types that mean the word's meaning was not understood.
MEANING_ERROR_TYPES = {"sense", "lexical_choice"}


def record_word_event(
    db: Session,
    *,
    user_id: int,
    lemma: str,
    event_type: str,
    location: Optional[str] = None,
    surface_form: Optional[str] = None,
    example: Optional[str] = None,
) -> None:
    normalized = normalize_lemma(lemma)
    if not normalized:
        return
    db.add(
        WordEvent(
            user_id=user_id,
            lemma=normalized,
            surface_form=surface_form,
            event_type=event_type,
            location=location,
            example=example,
        )
    )


def record_extraction_words(
    db: Session,
    *,
    user_id: int,
    location: Optional[str],
    result: ExtractionResult,
    utterance: str,
) -> None:
    """Correct turns -> active_success per word; rejected turns -> usage/meaning fail.

    Rejected utterances are never stored as examples (same privacy rule as
    LearningAnalyticsService.record_extraction).
    """
    if result.outcome == "correct":
        for finding in result.vocabulary:
            record_word_event(
                db,
                user_id=user_id,
                lemma=finding.lemma,
                event_type="active_success",
                location=location,
                surface_form=finding.surface_form,
                example=utterance,
            )
        return
    for finding in result.vocabulary:
        record_word_event(
            db,
            user_id=user_id,
            lemma=finding.lemma,
            event_type="meaning_fail" if finding.error_type in MEANING_ERROR_TYPES else "usage_fail",
            location=location,
            surface_form=finding.surface_form,
        )


def load_spell_book(db: Session, user_id: int, now: Optional[datetime] = None) -> list[dict]:
    rows = db.query(WordEvent).filter(WordEvent.user_id == user_id).all()
    return build_spell_book(_rows_to_events(rows), now or datetime.now(timezone.utc))


def _rows_to_events(rows) -> list[WordEventData]:
    return [
        WordEventData(
            lemma=row.lemma,
            event_type=row.event_type,
            created_at=row.created_at or datetime.now(timezone.utc),
            location=row.location,
            surface_form=row.surface_form,
            example=row.example,
        )
        for row in rows
    ]


def focus_words_for(db: Session, user_id: int, location: str, now: Optional[datetime] = None) -> list[str]:
    """Red/yellow words an NPC at `location` may weave into its next reply (roleApp 4.5)."""
    now = now or datetime.now(timezone.utc)
    rows = db.query(WordEvent).filter(WordEvent.user_id == user_id).all()
    if not rows:
        return []
    book = build_spell_book(_rows_to_events(rows), now)

    start_of_day = now.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    exposure: dict[str, DailyExposure] = {}
    for row in rows:
        if row.event_type != "passive_encounter" or row.created_at is None:
            continue
        created = row.created_at if row.created_at.tzinfo else row.created_at.replace(tzinfo=timezone.utc)
        if created < start_of_day or created >= start_of_day + timedelta(days=1):
            continue
        seen = exposure.get(row.lemma, DailyExposure())
        exposure[row.lemma] = DailyExposure(
            count=seen.count + 1,
            locations=seen.locations | ({row.location} if row.location else set()),
        )
    return select_focus_words(book, location, exposure)


def record_npc_exposure(
    db: Session,
    *,
    user_id: int,
    location: str,
    npc_reply: str,
    focus_words: list[str],
) -> list[str]:
    """Writes passive_encounter for focus words the NPC really used; returns them."""
    used = find_used_words(npc_reply, focus_words)
    for lemma in used:
        record_word_event(
            db,
            user_id=user_id,
            lemma=lemma,
            event_type="passive_encounter",
            location=location,
            example=npc_reply,
        )
    return used
