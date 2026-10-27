"""The player's phone: one persistent text thread per contact (Kademe 2).

A thread is an ordinary GameSession with mode "phone", so the player's messages
go through the usual turn pipeline (language check, NPC reply, memory and
relationship). Messages the NPC sends on its own — a reminder, a hurt message
after a missed plan — are written here as NPC dialogue in the same thread, so
the NPC sees them as context in later replies.
"""

from typing import Optional

from pydantic import BaseModel
from sqlalchemy.orm import Session

from models.models import Dialogue, GameSession, User
from services.npc_memory import NpcDef

PHONE_STATE = {"channel": "phone"}


class PhoneMessage(BaseModel):
    id: int
    speaker: str
    text: str
    channel: str


class PhoneThread(BaseModel):
    session_id: int
    contact: str
    messages: list[PhoneMessage]
    unread: int
    seen_id: int


def thread_session(db: Session, user: User, npc: NpcDef) -> GameSession:
    session = (
        db.query(GameSession)
        .filter(
            GameSession.user_id == user.id, GameSession.mode == "phone",
            GameSession.location == npc.location, GameSession.npc_role == npc.npc_role,
        )
        .order_by(GameSession.id)
        .first()
    )
    if session is None:
        session = GameSession(
            user_id=user.id, location=npc.location, npc_role=npc.npc_role,
            mode="phone", scenario_state=dict(PHONE_STATE), is_active=True,
        )
        db.add(session)
        db.flush()
    elif not session.is_active:
        session.is_active = True
    return session


def send_from_npc(db: Session, user: User, npc: NpcDef, text: str) -> Dialogue:
    """An NPC texts the player first (scripted, never LLM-invented events)."""
    session = thread_session(db, user, npc)
    message = Dialogue(session_id=session.id, speaker="npc", text=text)
    db.add(message)
    db.flush()
    return message


def conversation_rows(db: Session, user_id: int, location: str, npc_role: str,
                      limit: int = 60) -> list[tuple[Dialogue, str]]:
    """Recent accepted dialogue with one NPC, across phone and face-to-face sessions."""
    rows = (
        db.query(Dialogue, GameSession.mode)
        .join(GameSession, Dialogue.session_id == GameSession.id)
        .filter(
            GameSession.user_id == user_id,
            GameSession.location == location,
            GameSession.npc_role == npc_role,
        )
        .order_by(Dialogue.id.desc())
        .limit(limit)
        .all()
    )
    rows.reverse()
    return rows


def thread_view(db: Session, user: User, npc: NpcDef, limit: int = 60) -> PhoneThread:
    session = thread_session(db, user, npc)
    rows = conversation_rows(db, user.id, npc.location, npc.npc_role, limit)
    seen = user.phone_seen_dialogue_id or 0
    unread = (
        db.query(Dialogue)
        .filter(Dialogue.session_id == session.id, Dialogue.speaker == "npc", Dialogue.id > seen)
        .count()
    )
    return PhoneThread(
        session_id=session.id, contact=npc.name, unread=unread, seen_id=seen,
        messages=[PhoneMessage(id=r.id, speaker=r.speaker, text=r.text,
                               channel="phone" if mode == "phone" else "in_person")
                  for r, mode in rows],
    )


def mark_seen(user: User, last_id: Optional[int]) -> None:
    if last_id is not None and last_id > (user.phone_seen_dialogue_id or 0):
        user.phone_seen_dialogue_id = last_id
