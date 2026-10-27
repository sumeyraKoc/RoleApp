import logging
from typing import Literal

import httpx

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from core.auth import authenticated_user
from core.database import SessionLocal, get_db
from models.models import Dialogue, GameSession, InventoryEvent, LearningTurnEvent, User
from services.adventure_inventory import apply_inventory_transfers, inventory_snapshot
from services.adventure_progress import after_quests
from services.adventure_quests import completes_talk_quest, item_catalog, story_notes, tier_for_stage
from services.ai_client import decide_inventory_transfers, decide_plan, evaluate_and_respond, extract_utterance
from services import phone, plans, world_clock
from services.dialogue_history import build_evaluator_history
from services.extraction_eligibility import should_extract_after_turn
from services.learning_analytics import LearningAnalyticsService
from services import npc_memory
from services.reward_engine import RewardEngine
from services.scenario_engine import ScenarioEngine
from services.word_events import focus_words_for, record_npc_exposure
from shared.schemas import (
    EvaluateRequest,
    EvaluateResponse,
    ExtractionRequest,
    InventoryDecisionRequest,
    InventoryDecisionResponse,
    KnownItem,
    PlanDecisionRequest,
    RewardInfo,
)

router = APIRouter()
logger = logging.getLogger(__name__)


async def _record_extraction_background(
    payload: ExtractionRequest,
    *,
    outcome: Literal["correct", "incorrect"],
    user_id: int,
    session_id: int,
    dialogue_id: int | None,
    utterance: str,
    location: str | None = None,
) -> None:

    db = SessionLocal()
    try:
        extraction_result = await extract_utterance(payload, outcome)
        if extraction_result is None:
            return
        LearningAnalyticsService.record_extraction(
            db,
            user_id=user_id,
            session_id=session_id,
            dialogue_id=dialogue_id,
            utterance=utterance,
            result=extraction_result,
            location=location,
        )
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Language extraction failed for session %s", session_id)
    finally:
        db.close()


class TurnRequest(BaseModel):
    user_text: str
    # Set by the client during an interactive cutscene step or right after a scene.
    scene_note: str | None = Field(default=None, max_length=800)


@router.post("/{session_id}/turn", response_model=EvaluateResponse)
async def process_turn(
    session_id: int,
    request: TurnRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(authenticated_user),
):
    session = db.query(GameSession).filter(GameSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="This session belongs to another player")
    if not session.is_active:
        raise HTTPException(status_code=400, detail="Session is closed")




    previous_turn = (
        db.query(LearningTurnEvent)
        .filter(LearningTurnEvent.session_id == session.id)
        .order_by(LearningTurnEvent.created_at.desc(), LearningTurnEvent.id.desc())
        .first()
    )
    should_extract = should_extract_after_turn(
        previous_turn.outcome if previous_turn is not None else None
    )


    if session.location == "town" and session.npc_role == "friend":
        # Sam remembers both texts and face-to-face talks as one conversation.
        dialogues = [row for row, _ in phone.conversation_rows(
            db, session.user_id, session.location, session.npc_role, limit=40,
        )]
    else:
        dialogues = (
            db.query(Dialogue)
            .filter(Dialogue.session_id == session.id)
            .order_by(Dialogue.created_at.asc(), Dialogue.id.asc())
            .all()
        )
    dialogue_history = build_evaluator_history(dialogues)

    # Spell Book words this NPC may use in its reply (roleApp 4.5).
    try:
        focus_words = focus_words_for(db, session.user_id, session.location)
    except Exception:
        logger.exception("Could not pick focus words for session %s", session.id)
        db.rollback()  # nothing has been written yet; keep the session usable
        focus_words = []

    # What this NPC remembers about the player and how it feels about them (roleApp 6.1, 7.3).
    npc = npc_memory.npc_for(session.location, session.npc_role)
    npc_memories = npc_memory.memories_for_prompt(db, session.user_id, npc) if npc else []
    relationship = npc_memory.relationship_view(db, session.user_id, npc) if npc else None

    payload = EvaluateRequest(
        location=session.location,
        npc_role=session.npc_role,
        scenario_state=session.scenario_state or {},
        dialogue_history=dialogue_history,
        user_text=request.user_text,
        focus_words=focus_words,
        npc_memories=npc_memories,
        relationship_tier=relationship.tier if relationship else None,
    )
    if request.scene_note:
        payload.scene_note = request.scene_note.strip()
    if session.mode in ("adventure", "phone"):
        stage = db.get(User, session.user_id).adventure_stage
        payload.cefr_level = tier_for_stage(stage).cefr
        # The story so far, and what this NPC should do for the current quest.
        notes = story_notes(stage, session.location, session.npc_role) if session.mode == "adventure" else []
        if notes:
            payload.scene_note = " ".join(filter(None, [payload.scene_note, *notes]))
    if npc is not None and npc.meets:
        owner = db.get(User, session.user_id)
        payload.world_time = world_clock.view(owner.game_seconds).label
        payload.plan_notes = plans.plan_notes(db, owner, npc)



    try:
        result = await evaluate_and_respond(payload)
    except httpx.HTTPError as error:
        # Both AI providers were busy or down: tell the player instead of a bare 500.
        logger.warning("AI service failed for session %s: %s", session.id, error)
        who = npc.name if npc is not None else "The character"
        raise HTTPException(
            status_code=503,
            detail=f"{who} couldn't answer right now because the AI service is busy. Please try again in a moment.",
        ) from error

    inventory_decision = InventoryDecisionResponse()
    if session.mode == "adventure" and result.accepted and result.response_speaker == "npc":
        try:
            inventory_decision = await decide_inventory_transfers(
                InventoryDecisionRequest(
                    location=session.location,
                    npc_role=session.npc_role,
                    player_text=request.user_text,
                    npc_reply=result.npc_response,
                    previous_dialogue=dialogue_history[-6:],
                    inventory=inventory_snapshot(db, session.user_id),
                    known_items=[
                        KnownItem(item_id=item.item_id, name=item.name, aliases=item.aliases)
                        for item in item_catalog().values()
                    ],
                )
            )
        except Exception:
            logger.exception("Groq inventory judgment failed for session %s", session.id)
            result.adventure_notice = "Inventory could not be checked right now. You can try this exchange again."





    reward_info = RewardEngine.process_turn_reward(
        db=db, user_id=session.user_id, is_accepted=result.accepted
    )
    if reward_info:
        result.rewards = RewardInfo(**reward_info)

    dialogue_id: int | None = None
    if result.accepted:
        user_dialogue = Dialogue(
            session_id=session.id,
            speaker="user",
            text=request.user_text,
            is_natural=True,
        )
        db.add(user_dialogue)
        db.flush()
        dialogue_id = user_dialogue.id

    npc_dialogue: Dialogue | None = None
    if result.response_speaker == "npc":
        npc_dialogue = Dialogue(
            session_id=session.id,
            speaker="npc",
            text=result.npc_response,
        )
        db.add(npc_dialogue)
        db.flush()

    # Quests advance in Adventure and through the phone (Kademe 2), never in free Roleplay.
    if session.mode in ("adventure", "phone"):
        # Serialize stage changes for this player, including simultaneous sessions.
        player = (
            db.query(User)
            .filter(User.id == session.user_id)
            .populate_existing()
            .with_for_update()
            .one()
        )
        stage_before = player.adventure_stage
        if npc_dialogue is not None and inventory_decision.transfers:
            result.inventory_changes = apply_inventory_transfers(
                db, player, npc_dialogue, inventory_decision.transfers,
                location=session.location,
                npc_role=session.npc_role,
            )
        if result.accepted and result.response_speaker == "npc":
            if completes_talk_quest(player.adventure_stage, session.location, session.npc_role):
                player.adventure_stage += 1
        result.adventure_stage = player.adventure_stage

        # Turn confirmed handovers and finished quests into NPC memories and gossip.
        if npc is not None and npc_dialogue is not None and result.inventory_changes:
            db.flush()
            events = (
                db.query(InventoryEvent)
                .filter(InventoryEvent.dialogue_id == npc_dialogue.id)
                .order_by(InventoryEvent.id)
                .all()
            )
            names = {change["item_id"]: change["name"] for change in result.inventory_changes}
            for event in events:
                text = npc_memory.record_inventory_event(
                    db, session.user_id, npc, event_id=event.id,
                    item_name=names.get(event.item_id, event.item_id.replace("_", " ")), delta=event.delta,
                )
                if text:
                    result.new_memories.append(text)
        for helper_id, text in after_quests(db, player, stage_before, player.adventure_stage):
            if npc is not None and helper_id == npc.id:
                result.new_memories.append(text)
        result.adventure_stage = player.adventure_stage  # after_quests may skip quests already done




    if npc is not None and npc.meets and result.accepted and result.response_speaker == "npc":
        owner = db.get(User, session.user_id)
        try:
            decision = await decide_plan(PlanDecisionRequest(
                npc_name=npc.name,
                world_time=payload.world_time or world_clock.view(owner.game_seconds).label,
                player_text=request.user_text,
                npc_reply=result.npc_response,
                previous_dialogue=dialogue_history[-6:],
                **plans.decision_context(db, owner, npc),
            ))
            update, plan_memories = plans.apply_decision(
                db, owner, npc, decision, owner.game_seconds, npc_dialogue.id if npc_dialogue else None,
                player_text=request.user_text,
            )
            if update is not None:
                result.plan_update = update.model_dump()
                if update.status == "rejected" and npc_dialogue is not None:
                    # The AI may have agreed before the server checked the clock.
                    # Keep both the visible reply and saved history consistent with the real plan.
                    existing = plans.planned(db, owner.id, npc.id)
                    result.npc_response = (
                        "Sorry, I can't make that plan. "
                        + ("Our earlier plan still stands." if existing else "Could we choose another time or place?")
                    )
                    npc_dialogue.text = result.npc_response
            result.new_memories.extend(plan_memories)
        except Exception:
            logger.exception("Plan judgment failed for session %s", session.id)

    if result.response_speaker == "npc" and focus_words:
        result.used_focus_words = record_npc_exposure(
            db,
            user_id=session.user_id,
            location=session.location,
            npc_reply=result.npc_response,
            focus_words=focus_words,
        )

    if npc is not None:
        if result.accepted and result.response_speaker == "npc":
            npc_memory.record_accepted_turn(db, session.user_id, session.id, npc)
        db.flush()
        result.relationship = npc_memory.relationship_view(db, session.user_id, npc).model_dump()

    db.add(
        LearningTurnEvent(
            user_id=session.user_id,
            session_id=session.id,
            dialogue_id=dialogue_id,
            location=session.location,
            outcome="correct" if result.accepted else "incorrect",
        )
    )

    session.scenario_state = result.updated_scenario_state



    is_completed, completion_rewards = ScenarioEngine.is_scenario_completed(
        session.location, session.scenario_state
    )

    if is_completed:
        session.is_active = False

        bonus_xp = completion_rewards.get("completion_xp_bonus", 0)
        bonus_coin = completion_rewards.get("completion_coin_bonus", 0)

        bonus_user = db.query(User).filter(User.id == session.user_id).first()
        bonus_user.xp += bonus_xp
        bonus_user.coins += bonus_coin

        if result.rewards:
            result.rewards.gained_xp += bonus_xp
            result.rewards.gained_coins += bonus_coin
            result.rewards.total_xp = bonus_user.xp
            result.rewards.total_coins = bonus_user.coins
        else:
            result.rewards = RewardInfo(
                gained_xp=bonus_xp,
                gained_coins=bonus_coin,
                total_xp=bonus_user.xp,
                total_coins=bonus_user.coins,
            )

    db.commit()

    if should_extract:
        background_tasks.add_task(
            _record_extraction_background,
            ExtractionRequest(utterance=request.user_text),
            outcome="correct" if result.accepted else "incorrect",
            user_id=session.user_id,
            session_id=session.id,
            dialogue_id=dialogue_id,
            utterance=request.user_text,
            location=session.location,
        )

    return result
