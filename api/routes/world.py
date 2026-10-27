from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from core.auth import authenticated_user
from core.database import get_db
from models.models import User
from services import plans, world_clock

router = APIRouter()


def _locked(db: Session, user: User) -> User:
    # Serialize clock updates for one player across tabs.
    return db.query(User).filter(User.id == user.id).populate_existing().with_for_update().one()


@router.post("/clock/tick", response_model=world_clock.ClockView)
def tick_clock(db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    player = _locked(db, user)
    clock = world_clock.advance(player)
    plans.process_clock(db, player, clock.game_seconds)  # reminders and missed meetings
    db.commit()
    return clock


@router.post("/sleep", response_model=world_clock.ClockView)
def sleep(db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    player = _locked(db, user)
    current = world_clock.advance(player)
    if not world_clock.can_sleep(current.game_seconds):
        db.commit()
        raise HTTPException(status_code=409, detail="You're not tired yet. You can sleep after 8 PM.")
    clock = world_clock.sleep(player)
    plans.process_clock(db, player, clock.game_seconds)  # sleeping through a plan misses it
    db.commit()
    return clock
