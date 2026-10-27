from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from core.auth import authenticated_user
from core.database import get_db
from models.models import User
from services import npc_memory, phone

router = APIRouter()


def _contact(contact: str) -> npc_memory.NpcDef:
    npc = npc_memory.npc_by_id(contact)
    if npc is None or npc.location != "town":
        raise HTTPException(status_code=404, detail="Unknown contact")
    return npc


@router.get("/{contact}", response_model=phone.PhoneThread)
def get_thread(contact: str, db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    view = phone.thread_view(db, user, _contact(contact))
    db.commit()
    return view


class ReadRequest(BaseModel):
    last_id: int


@router.post("/{contact}/read")
def mark_read(contact: str, request: ReadRequest, db: Session = Depends(get_db),
              user: User = Depends(authenticated_user)):
    _contact(contact)
    phone.mark_seen(user, request.last_id)
    db.commit()
    return {"seen_id": user.phone_seen_dialogue_id}
