from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from core.auth import authenticated_user
from core.database import get_db
from models.models import Appointment, InventoryItem, User
from services.adventure_inventory import inventory_snapshot
from services.adventure_progress import after_quests, catch_up
from services.adventure_quests import (
    adventure_content_for_client,
    unlocked_worlds,
    completes_scene_quest,
    load_cutscene,
    reach_rule,
)


router = APIRouter()


def _flags(db: Session, user: User) -> dict:
    """Story facts the client needs for branching cutscenes."""
    statuses = {row.status for row in db.query(Appointment.status).filter(Appointment.user_id == user.id)}
    kept = "kept" in statuses
    return {"kept_meeting": kept, "missed_meeting": not kept and "missed" in statuses}


def _state(db: Session, user: User) -> dict:
    return {
        "stage": user.adventure_stage,
        "inventory": inventory_snapshot(db, user.id),
        "adventure": adventure_content_for_client(),
        "flags": _flags(db, user),
        "world": user.world or "town",
        "unlocked_worlds": unlocked_worlds(user.adventure_stage),
        "story_flags": user.story_flags or {},
    }


def _locked(db: Session, user: User) -> User:
    return db.query(User).filter(User.id == user.id).populate_existing().with_for_update().one()


@router.get("/state")
def get_adventure_state(
    db: Session = Depends(get_db),
    user: User = Depends(authenticated_user),
):
    player = _locked(db, user)
    # Saves stuck on a quest that was already done early (e.g. a rune gate opened before its turn).
    catch_up(db, player)
    db.commit()
    return _state(db, player)


@router.get("/cutscenes/{scene_id}")
def get_cutscene(scene_id: str, user: User = Depends(authenticated_user)):
    scene = load_cutscene(scene_id)
    if scene is None:
        raise HTTPException(status_code=404, detail="Unknown cutscene")
    return scene


@router.post("/scenes/{scene_id}/seen")
def scene_seen(scene_id: str, db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    """The player watched (or skipped) a cutscene; finishes a scene quest waiting for it."""
    player = _locked(db, user)
    completed = completes_scene_quest(player.adventure_stage, scene_id)
    if completed:
        before = player.adventure_stage
        player.adventure_stage += 1
        after_quests(db, player, before, player.adventure_stage)
    db.commit()
    return {"completed": completed, **_state(db, player)}


@router.post("/travel/{world}")
def travel(world: str, db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    """Board a boat to another world; the server remembers where the player is."""
    player = _locked(db, user)
    if world not in unlocked_worlds(player.adventure_stage):
        db.commit()
        raise HTTPException(status_code=409, detail="That place is still hidden in the mist.")
    player.world = world
    db.commit()
    return _state(db, player)


@router.post("/reach/{place_id}")
def reach_place(place_id: str, db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    """The player arrived at a place; finishes a reach_place quest if they carry its items."""
    player = _locked(db, user)
    rule = reach_rule(player.adventure_stage, place_id)
    missing: list[str] = []
    if rule is not None:
        owned = {
            row.item_id for row in db.query(InventoryItem)
            .filter(InventoryItem.user_id == player.id, InventoryItem.quantity > 0)
        }
        missing = [item for item in rule.items if item not in owned]
    completed = rule is not None and not missing
    if completed:
        before = player.adventure_stage
        player.adventure_stage += 1
        after_quests(db, player, before, player.adventure_stage)
    db.commit()
    return {
        "completed": completed,
        "scene_id": rule.scene_id if completed and rule else None,
        "missing": missing,
        **_state(db, player),
    }
