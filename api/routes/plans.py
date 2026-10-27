from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from core.auth import authenticated_user
from core.database import get_db
from models.models import User
from services import plans, world_clock

router = APIRouter()


@router.get("")
def list_plans(db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    return {"plans": [plans.view(a).model_dump() for a in plans.planned(db, user.id)]}


@router.post("/{appointment_id}/arrive")
def arrive(appointment_id: int, db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    player = db.query(User).filter(User.id == user.id).populate_existing().with_for_update().one()
    now = world_clock.advance(player).game_seconds
    try:
        appointment, memory = plans.arrive(db, player, appointment_id, now)
    except plans.ArrivalError as error:
        db.commit()
        raise HTTPException(status_code=409, detail=str(error)) from error
    db.commit()
    return {"appointment": appointment.model_dump(), "memory": memory}
