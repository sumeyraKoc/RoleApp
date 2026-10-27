"""Use Groq to read whether the latest exchange settled, cancelled or apologised for a meeting."""

import json
import os

from modules.groq_client import build_groq_client, groq_chat_json, json_schema_instruction
from shared.schemas import PlanDecisionRequest, PlanDecisionResponse


INSTRUCTION = """You track meeting plans between the player and an NPC friend in an English role-play game.
Read the latest exchange (player_text, then npc_reply); use previous_dialogue only to resolve references.
Return JSON with: action, place_id, time, day, apologized.
- action "create": in the latest exchange both sides clearly agreed on ONE place and ONE time
  (the NPC's reply accepts or confirms it). Use place_id from places (match names and aliases);
  time as 24-hour "HH:MM" ("six" in the evening = "18:00", "noon" = "12:00", "half past four pm" =
  "16:30"; "six" with no hint means 18:00); day "tomorrow" only when said, else "today".
  A changed time or place for an existing current_plan is also "create" only when the player
  explicitly asks for a change and the NPC agrees.
- When current_plan exists and the player merely confirms or repeats it (e.g. "let's keep
  our plan for ten tomorrow"), action is "none". Never shift an existing plan because
  relative words such as "tomorrow" now refer to a different game day.
- action "cancel": the player and NPC agree to call off current_plan without a new time.
- action "none": anything else — a suggestion, a question, a plan still missing place or time, the
  NPC refusing, talk about a past plan, or a place not in places.
- apologized: true only when missed_plan is set and the player apologises for it in player_text.
Never invent places or times that are not in the latest exchange."""


def decide_plan(payload: PlanDecisionRequest) -> PlanDecisionResponse:
    key = os.getenv("GROQ_API_KEY", "").strip()
    if not key:
        raise RuntimeError("GROQ_API_KEY is required for plan decisions")
    with build_groq_client(key, timeout=30.0) as client:
        raw = groq_chat_json(
            client,
            model=os.getenv("GROQ_PLAN_MODEL") or os.getenv("GROQ_INVENTORY_MODEL") or "openai/gpt-oss-120b",
            system_instruction=INSTRUCTION + json_schema_instruction(PlanDecisionResponse.model_json_schema()),
            user_content=json.dumps(payload.model_dump(), ensure_ascii=False),
        )
    return PlanDecisionResponse.model_validate_json(raw)
