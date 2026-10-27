"""Authoritative inventory changes and deterministic adventure progression."""

import re

from sqlalchemy.orm import Session

from models.models import Dialogue, InventoryEvent, InventoryItem, User
from services.adventure_quests import completes_inventory_quest, item_catalog
from shared.schemas import InventoryTransfer


def item_display_name(item_id: str) -> str:
    """Derive English UI text even for items saved before English-only labels."""
    known = item_catalog().get(item_id)
    return known.name if known else item_id.replace("_", " ").title()


def inventory_snapshot(db: Session, user_id: int) -> list[dict]:
    rows = (
        db.query(InventoryItem)
        .filter(InventoryItem.user_id == user_id, InventoryItem.quantity > 0)
        .order_by(InventoryItem.item_id)
        .all()
    )
    return [
        {"item_id": row.item_id, "name": item_display_name(row.item_id), "quantity": row.quantity}
        for row in rows
    ]


def apply_inventory_transfers(
    db: Session,
    user: User,
    npc_dialogue: Dialogue,
    transfers: list[InventoryTransfer],
    *,
    location: str,
    npc_role: str,
) -> list[dict]:
    """Persist proposed changes once; never let AI overdraw player stock."""
    changes: list[dict] = []
    seen: set[str] = set()
    for transfer in transfers:
        item_id = transfer.item_id.strip().lower()
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,79}", item_id) or item_id in seen or transfer.delta == 0:
            continue
        seen.add(item_id)
        already_recorded = (
            db.query(InventoryEvent.id)
            .filter(InventoryEvent.dialogue_id == npc_dialogue.id, InventoryEvent.item_id == item_id)
            .first()
        )
        if already_recorded:
            continue
        row = (
            db.query(InventoryItem)
            .filter(InventoryItem.user_id == user.id, InventoryItem.item_id == item_id)
            .first()
        )
        if transfer.delta < 0 and (row is None or row.quantity < -transfer.delta):
            continue
        display_name = item_display_name(item_id)
        if row is None:
            row = InventoryItem(user_id=user.id, item_id=item_id, name=display_name, quantity=0)
            db.add(row)
        elif row.name != display_name:
            row.name = display_name
        row.quantity += transfer.delta
        db.add(InventoryEvent(
            user_id=user.id,
            dialogue_id=npc_dialogue.id,
            item_id=item_id,
            delta=transfer.delta,
            reason="dialogue_transfer",
        ))
        changes.append({"item_id": item_id, "name": row.name, "quantity": transfer.delta})
        if completes_inventory_quest(user.adventure_stage, location, npc_role, item_id, transfer.delta, transfer.category):
            user.adventure_stage += 1
    return changes
