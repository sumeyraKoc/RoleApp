"""NPC memory, player relationships and one-hop gossip (roleApp 6.1, 7.5, 7.6).

Memories are never written by the LLM. Each one is rendered from a template and
tied to a real game event (an inventory transfer or a completed quest), so an
NPC can only "remember" things that actually happened. The witness NPC stores a
"witnessed" memory; its friends from game_data/npcs.json store a "heard" one and
feel a share of the witness's relationship change.

The NPC roster, social graph and relationship rules live in
api/game_data/npcs.json, so tuning them is a content change.
"""

import json
import os
from functools import lru_cache
from typing import Optional

from pydantic import BaseModel, Field, model_validator
from sqlalchemy.orm import Session

from models.models import NpcMemory, NpcRelationship

NPCS_FILE = os.path.join(os.path.dirname(__file__), "..", "game_data", "npcs.json")

SYMPATHY_RANGE = (-100, 100)
TRUST_RANGE = (0, 100)


class NpcDef(BaseModel):
    id: str
    name: str
    location: str
    npc_role: str
    friends: list[str] = Field(default_factory=list)
    # Can arrange meetings with the player (services/plans.py).
    meets: bool = False


class Change(BaseModel):
    sympathy: int = 0
    trust: int = 0


class Tier(BaseModel):
    name: str
    max: int


class RelationshipRules(BaseModel):
    start: Change
    events: dict[str, Change]
    max_turn_sympathy_per_conversation: int = Field(ge=0)
    gossip_share: float = Field(ge=0, le=1)
    tiers: list[Tier] = Field(min_length=1)


class MemoryRules(BaseModel):
    prompt_limit: int = Field(ge=0, le=20)


class NpcContent(BaseModel):
    npcs: list[NpcDef] = Field(min_length=1)
    relationship: RelationshipRules
    memory: MemoryRules

    @model_validator(mode="after")
    def _consistent(self):
        ids = [npc.id for npc in self.npcs]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate npc id")
        for npc in self.npcs:
            unknown = [friend for friend in npc.friends if friend not in ids or friend == npc.id]
            if unknown:
                raise ValueError(f"{npc.id} has unknown friends: {unknown}")
        missing = {"accepted_turn", "npc_gave_item", "player_gave_item", "quest_completed",
                   "plan_kept", "plan_missed", "apology"} - set(self.relationship.events)
        if missing:
            raise ValueError(f"relationship events missing: {sorted(missing)}")
        maxes = [tier.max for tier in self.relationship.tiers]
        if maxes != sorted(maxes) or maxes[-1] < SYMPATHY_RANGE[1]:
            raise ValueError("tiers must be sorted by max and cover the whole sympathy range")
        return self


class RelationshipView(BaseModel):
    npc_id: str
    name: str
    sympathy: int
    trust: int
    tier: str


@lru_cache(maxsize=1)
def load_npcs(path: str = NPCS_FILE) -> NpcContent:
    with open(path, encoding="utf-8") as handle:
        return NpcContent.model_validate(json.load(handle))


def npc_by_id(npc_id: str) -> Optional[NpcDef]:
    return next((npc for npc in load_npcs().npcs if npc.id == npc_id), None)


def npc_for(location: str, npc_role: str) -> Optional[NpcDef]:
    return next(
        (npc for npc in load_npcs().npcs if (npc.location, npc.npc_role) == (location, npc_role)),
        None,
    )


def tier_for(sympathy: int) -> str:
    return next(tier.name for tier in load_npcs().relationship.tiers if sympathy <= tier.max)


def _clamp(value: int, bounds: tuple[int, int]) -> int:
    return max(bounds[0], min(bounds[1], value))


def _relationship(db: Session, user_id: int, npc_id: str) -> NpcRelationship:
    row = (
        db.query(NpcRelationship)
        .filter(NpcRelationship.user_id == user_id, NpcRelationship.npc_id == npc_id)
        .first()
    )
    if row is None:
        start = load_npcs().relationship.start
        row = NpcRelationship(
            user_id=user_id, npc_id=npc_id, sympathy=start.sympathy, trust=start.trust, turn_sympathy_gained=0,
        )
        db.add(row)
        db.flush()
    return row


def _apply(row: NpcRelationship, change: Change) -> Change:
    """Apply a change within bounds and return what actually changed."""
    before = (row.sympathy, row.trust)
    row.sympathy = _clamp(row.sympathy + change.sympathy, SYMPATHY_RANGE)
    row.trust = _clamp(row.trust + change.trust, TRUST_RANGE)
    return Change(sympathy=row.sympathy - before[0], trust=row.trust - before[1])


def relationship_view(db: Session, user_id: int, npc: NpcDef) -> RelationshipView:
    row = _relationship(db, user_id, npc.id)
    return RelationshipView(
        npc_id=npc.id, name=npc.name, sympathy=row.sympathy, trust=row.trust, tier=tier_for(row.sympathy),
    )


def memories_for_prompt(db: Session, user_id: int, npc: NpcDef) -> list[str]:
    """Most recent memories, oldest first, phrased for the NPC's own prompt."""
    limit = load_npcs().memory.prompt_limit
    if limit == 0:
        return []
    rows = (
        db.query(NpcMemory)
        .filter(NpcMemory.user_id == user_id, NpcMemory.npc_id == npc.id)
        .order_by(NpcMemory.created_at.desc(), NpcMemory.id.desc())
        .limit(limit)
        .all()
    )
    return [f"({row.kind}) {row.text}" for row in reversed(rows)]


def record_accepted_turn(db: Session, user_id: int, session_id: int, npc: NpcDef) -> None:
    """Small talk warms an NPC up, capped per conversation."""
    rules = load_npcs().relationship
    row = _relationship(db, user_id, npc.id)
    if row.turn_session_id != session_id:
        row.turn_session_id = session_id
        row.turn_sympathy_gained = 0
    room = max(0, rules.max_turn_sympathy_per_conversation - row.turn_sympathy_gained)
    step = rules.events["accepted_turn"]
    applied = _apply(row, Change(sympathy=min(step.sympathy, room), trust=step.trust))
    row.turn_sympathy_gained += max(0, applied.sympathy)


def _remember(db: Session, user_id: int, npc_id: str, kind: str, text: str, source_type: str,
              source_id: str, heard_from: Optional[str] = None) -> bool:
    exists = (
        db.query(NpcMemory.id)
        .filter(
            NpcMemory.user_id == user_id, NpcMemory.npc_id == npc_id,
            NpcMemory.source_type == source_type, NpcMemory.source_id == source_id,
        )
        .first()
    )
    if exists:
        return False
    db.add(NpcMemory(
        user_id=user_id, npc_id=npc_id, kind=kind, text=text,
        source_type=source_type, source_id=source_id, heard_from=heard_from,
    ))
    return True


def _record_event(db: Session, user_id: int, witness: NpcDef, *, source_type: str, source_id: str,
                  witnessed_text: str, heard_text: str, change: Change, player_text: str) -> Optional[str]:
    """Store the witness memory, apply the change, and pass the news one hop on.

    Returns a player-facing line for the dialogue panel, or None if already recorded.
    """
    if not _remember(db, user_id, witness.id, "witnessed", witnessed_text, source_type, source_id):
        return None  # already recorded; never count the same event twice
    applied = _apply(_relationship(db, user_id, witness.id), change)
    share = load_npcs().relationship.gossip_share
    listeners: list[str] = []
    for friend_id in witness.friends:
        friend = npc_by_id(friend_id)
        if friend is None:
            continue
        if _remember(db, user_id, friend.id, "heard", heard_text, source_type, source_id, heard_from=witness.id):
            _apply(_relationship(db, user_id, friend.id), Change(sympathy=round(applied.sympathy * share)))
            listeners.append(friend.name)
    if listeners:
        names = listeners[0] if len(listeners) == 1 else f"{', '.join(listeners[:-1])} and {listeners[-1]}"
        player_text += f" Word gets around: {names} will hear about it."
    return player_text


def record_plan_event(db: Session, user_id: int, npc: NpcDef, *, appointment_id: int, event: str,
                      witnessed_text: str, heard_text: str, player_text: str) -> Optional[str]:
    """A kept, missed or apologised-for meeting: remembered, felt and gossiped like any event."""
    return _record_event(
        db, user_id, npc, source_type="appointment", source_id=f"{appointment_id}:{event}",
        witnessed_text=witnessed_text, heard_text=heard_text,
        change=load_npcs().relationship.events[event], player_text=player_text,
    )


def _quantity(count: int, name: str) -> str:
    return f"{count} × {name}"


def record_inventory_event(db: Session, user_id: int, npc: NpcDef, *, event_id: int,
                           item_name: str, delta: int) -> Optional[str]:
    rules = load_npcs().relationship.events
    count = abs(delta)
    if delta > 0:
        witnessed = f"You gave the player {_quantity(count, item_name)}."
        heard = f"{npc.name} mentioned giving the player {_quantity(count, item_name)}."
        change = rules["npc_gave_item"]
        player = f"{npc.name} will remember giving you {_quantity(count, item_name)}."
    else:
        witnessed = f"The player gave you {_quantity(count, item_name)}."
        heard = f"{npc.name} mentioned that the player gave {npc.name} {_quantity(count, item_name)}."
        change = rules["player_gave_item"]
        player = f"{npc.name} will remember your gift: {_quantity(count, item_name)}."
    return _record_event(
        db, user_id, npc, source_type="inventory_event", source_id=str(event_id),
        witnessed_text=witnessed, heard_text=heard, change=change, player_text=player,
    )


def record_quest_completed(db: Session, user_id: int, npc: NpcDef, *, quest_id: str,
                           quest_title: str) -> Optional[str]:
    return _record_event(
        db, user_id, npc, source_type="quest", source_id=quest_id,
        witnessed_text=f'You helped the player finish the quest "{quest_title}".',
        heard_text=f'{npc.name} mentioned helping the player finish the quest "{quest_title}".',
        change=load_npcs().relationship.events["quest_completed"],
        player_text=f'{npc.name} will remember helping you with "{quest_title}".',
    )
