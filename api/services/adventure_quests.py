"""Adventure content: tiers (kademe), chapter text, familiar items and quest completion rules.

Everything here is loaded from api/game_data/adventure.json, the single source
for quests. The client receives the same content from GET /api/adventure/state,
so adding or editing a quest is a content change, not a code change.

A player's progress is one number, users.adventure_stage: the index of the
active quest in all tiers' quests laid end to end. Tier 1 holds quests 0–2, so
existing progress keeps its meaning when later tiers are appended.

NPCs never receive these rules; they only consume confirmed game events
(an item that actually entered the inventory, an accepted conversation, a kept
or missed meeting, a watched scene, a place reached with the right items).
"""

import json
import os
from functools import lru_cache
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field, model_validator

ADVENTURE_FILE = os.path.join(os.path.dirname(__file__), "..", "game_data", "adventure.json")
SCENARIOS_DIR = os.path.join(os.path.dirname(__file__), "..", "game_data", "scenarios")
CUTSCENES_DIR = os.path.join(os.path.dirname(__file__), "..", "game_data", "cutscenes")

ItemCategory = Literal["food", "drink", "other"]
ITEM_ID_PATTERN = r"^[a-z][a-z0-9_]{0,79}$"


class Chapter(BaseModel):
    id: str
    label: str
    title: str
    intro: str
    complete_title: str
    complete_text: str


class AdventureItem(BaseModel):
    item_id: str = Field(pattern=ITEM_ID_PATTERN)
    name: str
    description: str
    category: ItemCategory
    aliases: list[str] = Field(default_factory=list)


class ReceiveItemRule(BaseModel):
    """Complete when the player actually receives a matching item from this NPC."""

    type: Literal["receive_item"]
    location: str
    npc_role: str
    item_id: Optional[str] = Field(default=None, pattern=ITEM_ID_PATTERN)
    categories: list[ItemCategory] = Field(default_factory=list)

    @model_validator(mode="after")
    def _needs_a_target(self):
        if not self.item_id and not self.categories:
            raise ValueError("receive_item needs item_id or categories")
        return self


class TalkRule(BaseModel):
    """Complete after an accepted conversation turn with this NPC (face to face or by phone)."""

    type: Literal["talk"]
    location: str
    npc_role: str


class SceneTrigger(BaseModel):
    """Where and when the client starts the scene (client-side check)."""

    near_building: Optional[str] = None
    # Only in this world ("town" by default); with no near_building it starts on arrival.
    world: str = "town"
    from_: str = Field(alias="from")
    to: str

    model_config = {"populate_by_name": True}


class SceneRule(BaseModel):
    """Complete when the player has watched this cutscene."""

    type: Literal["scene"]
    scene_id: str
    trigger: SceneTrigger


class PlanRule(BaseModel):
    """Complete when a meeting with this NPC ends, kept or missed."""

    type: Literal["plan_resolved"]
    npc_id: str


class ReachRule(BaseModel):
    """Complete when the player reaches a meeting place holding these items; plays scene_id."""

    type: Literal["reach_place"]
    place_id: str
    scene_id: Optional[str] = None
    items: list[str] = Field(default_factory=list)


class SpellRule(BaseModel):
    """Complete when the player opens this rune gate with a spell (game_data/spells.json)."""

    type: Literal["spell_cast"]
    gate_id: str


CompletionRule = Annotated[
    Union[ReceiveItemRule, TalkRule, SceneRule, PlanRule, ReachRule, SpellRule], Field(discriminator="type"),
]


class PhoneText(BaseModel):
    npc_id: str
    text: str


class OnComplete(BaseModel):
    phone: list[PhoneText] = Field(default_factory=list)


class Quest(BaseModel):
    id: str
    title: str
    place: str
    detail: str
    complete_when: CompletionRule
    on_complete: OnComplete = Field(default_factory=OnComplete)
    # Told to the NPC this quest is about (talk / receive_item) while the quest is current.
    npc_note: Optional[str] = None


class Tier(BaseModel):
    tier: int = Field(ge=1)
    cefr: str
    # The world this tier takes place in; reaching the tier unlocks travel there.
    world: str = "town"
    # What every NPC in this chapter knows about the story so far.
    story_note: Optional[str] = None
    chapter: Chapter
    quests: list[Quest] = Field(min_length=1)


class AdventureContent(BaseModel):
    items: list[AdventureItem]
    tiers: list[Tier] = Field(min_length=1)

    @property
    def quests(self) -> list[Quest]:
        """All tiers' quests end to end; users.adventure_stage indexes this list."""
        return [quest for tier in self.tiers for quest in tier.quests]

    @model_validator(mode="after")
    def _consistent(self):
        item_ids = [item.item_id for item in self.items]
        if len(item_ids) != len(set(item_ids)):
            raise ValueError("duplicate item_id in adventure items")
        if [t.tier for t in self.tiers] != list(range(1, len(self.tiers) + 1)):
            raise ValueError("tiers must be numbered 1, 2, 3… in order")
        quest_ids = [quest.id for quest in self.quests]
        if len(quest_ids) != len(set(quest_ids)):
            raise ValueError("duplicate quest id")
        for quest in self.quests:
            rule = quest.complete_when
            if isinstance(rule, ReceiveItemRule) and rule.item_id and rule.item_id not in item_ids:
                raise ValueError(f"quest {quest.id} needs unknown item {rule.item_id}")
            if isinstance(rule, ReachRule):
                unknown = [item for item in rule.items if item not in item_ids]
                if unknown:
                    raise ValueError(f"quest {quest.id} needs unknown items {unknown}")
        return self


@lru_cache(maxsize=1)
def load_adventure(path: str = ADVENTURE_FILE) -> AdventureContent:
    with open(path, encoding="utf-8") as handle:
        return AdventureContent.model_validate(json.load(handle))


def adventure_content_for_client() -> dict:
    content = load_adventure()
    return {"tiers": [tier.model_dump(mode="json", by_alias=True) for tier in content.tiers]}


def item_catalog() -> dict[str, AdventureItem]:
    return {item.item_id: item for item in load_adventure().items}


def current_quest(stage: int) -> Optional[Quest]:
    quests = load_adventure().quests
    return quests[stage] if 0 <= stage < len(quests) else None


def unlocked_worlds(stage: int) -> list[str]:
    """Worlds the player may travel to: town, plus each later tier's world once that tier starts."""
    worlds = ["town"]
    start = 0
    for tier in load_adventure().tiers:
        if stage >= start and tier.world not in worlds:
            worlds.append(tier.world)
        start += len(tier.quests)
    return worlds


def tier_for_stage(stage: int) -> Tier:
    """The tier the player is in (the last one once everything is done)."""
    start = 0
    tiers = load_adventure().tiers
    for tier in tiers:
        if stage < start + len(tier.quests):
            return tier
        start += len(tier.quests)
    return tiers[-1]


def completes_inventory_quest(stage: int, location: str, npc_role: str, item_id: str, delta: int, category: str) -> bool:
    """True when this confirmed item handover finishes the active quest."""
    quest = current_quest(stage)
    if delta <= 0 or quest is None:
        return False
    rule = quest.complete_when
    if not isinstance(rule, ReceiveItemRule):
        return False
    if (location, npc_role) != (rule.location, rule.npc_role):
        return False
    return item_id == rule.item_id or category in rule.categories


def completes_talk_quest(stage: int, location: str, npc_role: str) -> bool:
    """True when an accepted conversation turn finishes the active quest."""
    quest = current_quest(stage)
    if quest is None:
        return False
    rule = quest.complete_when
    return isinstance(rule, TalkRule) and (location, npc_role) == (rule.location, rule.npc_role)


def completes_scene_quest(stage: int, scene_id: str) -> bool:
    quest = current_quest(stage)
    return quest is not None and isinstance(quest.complete_when, SceneRule) and quest.complete_when.scene_id == scene_id


def completes_plan_quest(stage: int, npc_id: str) -> bool:
    quest = current_quest(stage)
    return quest is not None and isinstance(quest.complete_when, PlanRule) and quest.complete_when.npc_id == npc_id


def completes_spell_quest(stage: int, gate_id: str) -> bool:
    quest = current_quest(stage)
    return quest is not None and isinstance(quest.complete_when, SpellRule) and quest.complete_when.gate_id == gate_id


def reach_rule(stage: int, place_id: str) -> Optional[ReachRule]:
    quest = current_quest(stage)
    if quest is not None and isinstance(quest.complete_when, ReachRule) and quest.complete_when.place_id == place_id:
        return quest.complete_when
    return None


def load_cutscene(scene_id: str) -> Optional[dict]:
    if not scene_id.replace("_", "").isalnum():
        return None
    path = os.path.join(CUTSCENES_DIR, f"{scene_id}.json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def story_notes(stage: int, location: str, npc_role: str) -> list[str]:
    """Story context for an NPC prompt: the chapter's note, plus the current quest's note if it is about this NPC."""
    notes: list[str] = []
    tier = tier_for_stage(stage)
    if tier.story_note:
        notes.append(tier.story_note)
    quest = current_quest(stage)
    rule = quest.complete_when if quest is not None else None
    if quest is not None and quest.npc_note and isinstance(rule, (TalkRule, ReceiveItemRule)) \
            and rule.location == location and rule.npc_role == npc_role:
        notes.append(quest.npc_note)
    return notes
