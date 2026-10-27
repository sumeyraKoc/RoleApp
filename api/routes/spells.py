import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from core.auth import authenticated_user
from core.database import get_db
from models.models import User
from services import spells
from services.adventure_progress import after_quests
from services.adventure_quests import completes_spell_quest
from services.ai_client import check_sentence
from shared.schemas import SentenceCheckRequest

router = APIRouter()


def _locked(db: Session, user: User) -> User:
    return db.query(User).filter(User.id == user.id).populate_existing().with_for_update().one()


def _gate(gate_id: str) -> spells.GateRule:
    gate = spells.gate_rule(gate_id)
    if gate is None:
        raise HTTPException(status_code=404, detail="Unknown gate")
    return gate


@router.get("/{gate_id}")
def get_spell(gate_id: str, db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    player = _locked(db, user)
    view = spells.spell_for(db, player, _gate(gate_id))
    db.commit()
    return view.model_dump()


class CastRequest(BaseModel):
    text: str = Field(min_length=1, max_length=300)
    # Free play (roleplay mode): the sentence still counts as word practice, but the gate is not
    # saved as open and no quest moves, so the story's own rune-gate quest stays intact.
    practice: bool = False


@router.post("/{gate_id}/cast")
async def cast(gate_id: str, request: CastRequest, db: Session = Depends(get_db),
               user: User = Depends(authenticated_user)):
    player = _locked(db, user)
    view = spells.spell_for(db, player, _gate(gate_id))
    text = request.text.strip()
    if view.opened and not request.practice:
        db.commit()
        return {"success": True, "already_open": True, "spell": view.model_dump()}
    hint = spells.precheck(text, view)
    if hint:
        db.commit()
        return {"success": False, "hint": hint, "spell": view.model_dump()}
    try:
        check = await check_sentence(SentenceCheckRequest(utterance=text, target_word=view.word))
    except httpx.HTTPError as error:
        db.commit()
        raise HTTPException(status_code=503, detail="The runes flicker… the magic is busy. Try again in a moment.") from error
    if not check.accepted:
        db.commit()
        return {
            "success": False, "spell": view.model_dump(), "correction": check.correction,
            "hint": "The runes flicker but stay shut. Try a clearer, more natural sentence.",
        }
    if request.practice:
        spells.record_practice(db, player, view, text)
        db.commit()
        return {"success": True, "practice": True, "spell": {**view.model_dump(), "opened": True}}
    spells.open_gate(db, player, view, text)
    completed = completes_spell_quest(player.adventure_stage, gate_id)
    if completed:
        before = player.adventure_stage
        player.adventure_stage += 1
        after_quests(db, player, before, player.adventure_stage)
    db.commit()
    return {"success": True, "spell": {**view.model_dump(), "opened": True}, "quest_completed": completed,
            "stage": player.adventure_stage}
