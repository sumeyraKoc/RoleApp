from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from core.auth import authenticated_user, require_owner
from core.database import get_db
from models.models import User
from services.word_events import load_spell_book

router = APIRouter()


@router.get("/{user_id}")
def get_spell_book(user_id: int, db: Session = Depends(get_db), current_user: User = Depends(authenticated_user)):
    """The player's Spell Book: one entry per word, hardest (red) first."""
    require_owner(user_id, current_user)
    return load_spell_book(db, user_id)
