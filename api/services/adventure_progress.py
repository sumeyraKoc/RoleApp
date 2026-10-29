"""What happens when quests complete: NPC memories and scripted phone texts.

Every path that advances users.adventure_stage (inventory, talk, scene, plan,
place) calls after_quests() with the quests it just finished.
"""

from typing import Optional

from sqlalchemy.orm import Session

from models.models import InventoryItem, User
from services import npc_memory, phone
from services.adventure_quests import PlanRule, Quest, ReceiveItemRule, SpellRule, TalkRule, current_quest, load_adventure


def quest_npc(quest: Quest) -> Optional[npc_memory.NpcDef]:
    """The NPC who helped with a quest, for its memory of it."""
    rule = quest.complete_when
    if isinstance(rule, (ReceiveItemRule, TalkRule)):
        return npc_memory.npc_for(rule.location, rule.npc_role)
    if isinstance(rule, PlanRule):
        return npc_memory.npc_by_id(rule.npc_id)
    return None


def after_quests(db: Session, user: User, stage_before: int, stage_after: int) -> list[tuple[str, str]]:
    """Record memories and send on_complete texts, then skip quests the player already did early.
    Returns (npc_id, player-facing memory) pairs."""
    lines = _record(db, user, stage_before, stage_after)
    lines += catch_up(db, user)
    return lines


def catch_up(db: Session, user: User) -> list[tuple[str, str]]:
    """Finish quests whose one-time action is already done.

    A rune gate opened before its quest came up stays open, so the spell can't be cast
    again; a quest item already in the inventory can't be received again. When such a
    quest becomes current it counts as done right away.
    """
    lines: list[tuple[str, str]] = []
    opened = set((user.story_flags or {}).get("opened_gates", []))
    owned = {
        row.item_id for row in db.query(InventoryItem)
        .filter(InventoryItem.user_id == user.id, InventoryItem.quantity > 0)
    }
    while True:
        quest = current_quest(user.adventure_stage)
        rule = quest.complete_when if quest is not None else None
        gate_done = isinstance(rule, SpellRule) and rule.gate_id in opened
        # A quest item (e.g. the Mist Lantern) received before its quest came up still counts.
        item_done = isinstance(rule, ReceiveItemRule) and rule.item_id is not None and rule.item_id in owned
        if not (gate_done or item_done):
            return lines
        before = user.adventure_stage
        user.adventure_stage += 1
        lines += _record(db, user, before, user.adventure_stage)


def _record(db: Session, user: User, stage_before: int, stage_after: int) -> list[tuple[str, str]]:
    lines: list[tuple[str, str]] = []
    for quest in load_adventure().quests[stage_before:stage_after]:
        helper = quest_npc(quest)
        if helper is not None:
            text = npc_memory.record_quest_completed(db, user.id, helper, quest_id=quest.id, quest_title=quest.title)
            if text:
                lines.append((helper.id, text))
        for message in quest.on_complete.phone:
            sender = npc_memory.npc_by_id(message.npc_id)
            if sender is not None:
                phone.send_from_npc(db, user, sender, message.text)
    return lines
