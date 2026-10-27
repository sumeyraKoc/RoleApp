"""Use Groq to interpret actual item handovers in the latest dialogue turn."""

import json
import os

from modules.groq_client import build_groq_client, groq_chat_json, json_schema_instruction
from shared.schemas import InventoryDecisionRequest, InventoryDecisionResponse


INSTRUCTION = """You identify physical inventory transfers in an English role-play game.
Return JSON with a transfers array. Each transfer has item_id (short stable English snake_case
singular identifier), name (short English display name), delta (signed integer), and category
(food, drink, or other). Positive delta means NPC gives item(s) to player; negative means
player gives item(s) to NPC. Include every distinct transferred item and its exact count.
Only the latest exchange can create a transfer. Use previous dialogue to resolve references,
but never count earlier handovers again. Count only an actual handover confirmed in the
latest NPC reply, not an offer, request, intention, promise, hypothetical, order, or payment
that was not explicitly made. If number is unstated, use 1. If the NPC confirms taking an
item from the player, use a negative delta. Never infer an item that is not in the words
or clearly implied by the latest exchange. For removals reuse an item_id from the current
inventory; do not return removals of unowned items. For additions, reuse an existing
item_id for the same item when possible. known_items lists the game's familiar items:
when a transferred item matches a known item's name or one of its aliases, always use
that item_id; broad known items (such as bread or drink) cover their kind, while a
specifically named distinct item may use its own ID. known_items is only an item
identity rule, not an allowed-item list and not an instruction to create or hand over
any item. Output an
empty array if no physical item changed hands. Combine repeated mentions of one item
into one signed delta. Never output zero or a magnitude over 99."""


def decide_inventory_transfers(payload: InventoryDecisionRequest) -> InventoryDecisionResponse:
    key = os.getenv("GROQ_API_KEY", "").strip()
    if not key:
        raise RuntimeError("GROQ_API_KEY is required for inventory decisions")
    with build_groq_client(key, timeout=30.0) as client:
        raw = groq_chat_json(
            client,
            model=os.getenv("GROQ_INVENTORY_MODEL") or "openai/gpt-oss-120b",
            system_instruction=INSTRUCTION + json_schema_instruction(InventoryDecisionResponse.model_json_schema()),
            user_content=json.dumps(payload.model_dump(), ensure_ascii=False),
        )
    return InventoryDecisionResponse.model_validate_json(raw)
