"""Spells for rune gates (Kademe 3): an English word, used correctly, is the magic.

Each gate asks for one word. It comes from the player's own Spell Book (the
hardest red or yellow word first), or from the gate's fallback list when the
book has none. The choice is stored in users.story_flags so it does not change.
A cast succeeds when the sentence contains the word (any common inflection),
is long enough, and the language evaluator accepts it. A success opens the
gate, counts as an active success for that word in the Spell Book, and can
finish a spell_cast quest.
"""

import json
import os
import re
from functools import lru_cache
from typing import Optional

from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from models.models import User
from services.spell_book import normalize_lemma
from services.word_events import load_spell_book, record_word_event

SPELLS_FILE = os.path.join(os.path.dirname(__file__), "..", "game_data", "spells.json")


class GateRule(BaseModel):
    gate_id: str
    name: str
    min_words: int = Field(default=4, ge=1)
    fallback_words: list[str] = Field(min_length=1)


class SpellsContent(BaseModel):
    gates: list[GateRule] = Field(min_length=1)


class SpellView(BaseModel):
    gate_id: str
    gate_name: str
    word: str
    source: str  # "spellbook" or "gate"
    min_words: int
    opened: bool


@lru_cache(maxsize=1)
def load_spells(path: str = SPELLS_FILE) -> SpellsContent:
    with open(path, encoding="utf-8") as handle:
        return SpellsContent.model_validate(json.load(handle))


def gate_rule(gate_id: str) -> Optional[GateRule]:
    return next((g for g in load_spells().gates if g.gate_id == gate_id), None)


def _flags(user: User) -> dict:
    return dict(user.story_flags or {})


def opened_gates(user: User) -> list[str]:
    return list(_flags(user).get("opened_gates", []))


def spell_for(db: Session, user: User, gate: GateRule) -> SpellView:
    """The word this gate asks this player for, chosen once and remembered."""
    flags = _flags(user)
    words = dict(flags.get("spell_words", {}))
    chosen = words.get(gate.gate_id)
    if not chosen:
        book = [entry for entry in load_spell_book(db, user.id) if entry["status"] in ("red", "yellow")]
        candidate = next((e["lemma"] for e in book if re.fullmatch(r"[a-z][a-z'-]{1,20}", e["lemma"])), None)
        if candidate:
            chosen = {"word": candidate, "source": "spellbook"}
        else:
            chosen = {"word": gate.fallback_words[user.id % len(gate.fallback_words)], "source": "gate"}
        words[gate.gate_id] = chosen
        flags["spell_words"] = words
        user.story_flags = flags  # reassign so SQLAlchemy notices the JSON change
    return SpellView(
        gate_id=gate.gate_id, gate_name=gate.name, word=chosen["word"], source=chosen["source"],
        min_words=gate.min_words, opened=gate.gate_id in opened_gates(user),
    )


def uses_word(text: str, word: str) -> bool:
    """The word or a common inflection of it (opens, opened, opening, lighter…)."""
    base = re.escape(normalize_lemma(word))
    stem = re.escape(normalize_lemma(word)[:-1]) if word.endswith("e") else base
    pattern = rf"\b(?:{base}(?:s|es|d|ed|er|est|ing|ly)?|{stem}(?:ing|ed|er))\b"
    return re.search(pattern, text.lower()) is not None


def precheck(text: str, spell: SpellView) -> Optional[str]:
    """Cheap checks before the language evaluator; returns a hint when the cast cannot work."""
    if not uses_word(text, spell.word):
        return f'The runes stay dark. Use the word "{spell.word}" in your sentence.'
    if len(re.findall(r"[A-Za-z']+", text)) < spell.min_words:
        return f"The spell is too short. Say a full sentence of at least {spell.min_words} words."
    return None


def record_practice(db: Session, user: User, spell: SpellView, sentence: str) -> None:
    """A spell cast in free play: count the word as used, without opening the gate for good."""
    record_word_event(db, user_id=user.id, lemma=spell.word, event_type="active_success",
                      location="isles", example=sentence)


def open_gate(db: Session, user: User, spell: SpellView, sentence: str) -> None:
    flags = _flags(user)
    gates = list(flags.get("opened_gates", []))
    if spell.gate_id not in gates:
        gates.append(spell.gate_id)
    flags["opened_gates"] = gates
    user.story_flags = flags
    record_word_event(db, user_id=user.id, lemma=spell.word, event_type="active_success",
                      location="isles", example=sentence)
