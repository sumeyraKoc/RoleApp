"""Meetings with NPCs who can make plans (Kademe 2: Sam).

A plan is created only when the plan judge (ai/modules/plan_decision.py) reads a
clear agreement in the latest exchange AND the rules in game_data/plans.json
allow it. The in-game clock then drives the rest: a reminder text before the
meeting, and a missed meeting once the wait is over. The client reports the
player's arrival; the server checks it against its own clock. Kept and missed
meetings become NPC memories, relationship changes and gossip.
"""

import json
import os
from functools import lru_cache
from typing import Optional

from pydantic import BaseModel, Field, model_validator
from sqlalchemy.orm import Session

from models.models import Appointment, User
from services import npc_memory, phone
from services.adventure_progress import after_quests
from services.adventure_quests import completes_plan_quest
from services.world_clock import DAY, view as clock_view
from shared.schemas import KnownPlace, PlanDecisionResponse

PLANS_FILE = os.path.join(os.path.dirname(__file__), "..", "game_data", "plans.json")
ARRIVAL_SLACK_SECONDS = 10 * 60  # client and server clocks may drift by a few game minutes


def hm_to_minutes(value: str) -> int:
    hours, minutes = value.split(":")
    total = int(hours) * 60 + int(minutes)
    if not (0 <= int(minutes) < 60 and 0 <= total <= 24 * 60):
        raise ValueError(f"bad time {value}")
    return total


def hhmm(game_seconds: int) -> str:
    rest = game_seconds % DAY
    return f"{rest // 3600:02d}:{(rest % 3600) // 60:02d}"


class Rules(BaseModel):
    min_lead_minutes: int = Field(ge=0)
    earliest: str
    latest: str
    late_minutes: int = Field(ge=0)
    wait_minutes: int = Field(ge=1)
    hurt_after_minutes: int = Field(ge=0)
    reminder_before_minutes: int = Field(ge=0)
    # After a kept meeting the NPC knows it is with the player for this long.
    hangout_minutes: int = Field(default=120, ge=0)


class Messages(BaseModel):
    reminder: str
    missed: list[str] = Field(min_length=1)
    kept: str


class PlansContent(BaseModel):
    places: list[KnownPlace] = Field(min_length=1)
    rules: Rules
    messages: Messages
    # Cutscene per place for a kept meeting ("default" for the rest).
    meeting_scenes: dict[str, str] = Field(default_factory=dict)

    def scene_for(self, place_id: str) -> Optional[str]:
        return self.meeting_scenes.get(place_id) or self.meeting_scenes.get("default")

    @model_validator(mode="after")
    def _consistent(self):
        ids = [place.place_id for place in self.places]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate place_id")
        if hm_to_minutes(self.rules.earliest) >= hm_to_minutes(self.rules.latest):
            raise ValueError("earliest must be before latest")
        return self


class AppointmentView(BaseModel):
    id: int
    npc_id: str
    npc_name: str
    place_id: str
    place_name: str
    game_seconds: int
    label: str
    status: str
    late_minutes: int
    wait_minutes: int
    scene_id: Optional[str] = None


class PlanUpdate(BaseModel):
    status: str  # planned, cancelled, rejected
    message: str
    appointment: Optional[AppointmentView] = None


@lru_cache(maxsize=1)
def load_plans(path: str = PLANS_FILE) -> PlansContent:
    with open(path, encoding="utf-8") as handle:
        return PlansContent.model_validate(json.load(handle))


def place_name(place_id: str) -> str:
    return next((p.name for p in load_plans().places if p.place_id == place_id), place_id)


def view(appointment: Appointment) -> AppointmentView:
    npc = npc_memory.npc_by_id(appointment.npc_id)
    rules = load_plans().rules
    return AppointmentView(
        id=appointment.id, npc_id=appointment.npc_id, npc_name=npc.name if npc else appointment.npc_id,
        place_id=appointment.place_id, place_name=place_name(appointment.place_id),
        game_seconds=appointment.game_seconds, label=clock_view(appointment.game_seconds).label,
        status=appointment.status, late_minutes=rules.late_minutes, wait_minutes=rules.wait_minutes,
        scene_id=load_plans().scene_for(appointment.place_id),
    )


def planned(db: Session, user_id: int, npc_id: Optional[str] = None) -> list[Appointment]:
    query = db.query(Appointment).filter(Appointment.user_id == user_id, Appointment.status == "planned")
    if npc_id:
        query = query.filter(Appointment.npc_id == npc_id)
    return query.order_by(Appointment.game_seconds).all()


def _unforgiven_miss(db: Session, user_id: int, npc_id: str) -> Optional[Appointment]:
    return (
        db.query(Appointment)
        .filter(Appointment.user_id == user_id, Appointment.npc_id == npc_id,
                Appointment.status == "missed", Appointment.apologized.is_(False))
        .order_by(Appointment.game_seconds.desc())
        .first()
    )


def place_label_time(game_seconds: int) -> str:
    return f"{hhmm(game_seconds)} on Day {game_seconds // DAY + 1}"


def plan_notes(db: Session, user: User, npc: npc_memory.NpcDef) -> list[str]:
    """Rules and facts the NPC's prompt must respect when talking about plans."""
    content = load_plans()
    rules = content.rules
    names = ", ".join(p.name for p in content.places)
    notes = [
        f"Places you can meet: {names}.",
        f"Only agree to a time at least {rules.min_lead_minutes} minutes from now and between "
        f"{rules.earliest} and {rules.latest}. If it is too soon, say you need more time; if it is "
        "too late, say it is too late for you, and suggest another time.",
    ]
    hangout = _hangout(db, user, npc)
    if hangout is not None:
        notes.append(
            f"Right now you are together with the player at {place_name(hangout.place_id)}: you met at "
            f"{hhmm(hangout.game_seconds)} as you planned, and you are hanging out. Enjoy it: chat, joke and "
            "suggest something to do here. Do not talk about meeting up as if you were apart."
        )
        summary = _scene_summary(load_plans().scene_for(hangout.place_id))
        if summary:
            notes.append(f"What just happened when you met: {summary}")
    current = planned(db, user.id, npc.id)
    if current:
        a = current[0]
        notes.append(f"Your plan with the player: {place_name(a.place_id)} at {place_label_time(a.game_seconds)}. "
                     "Keep it unless the player changes or cancels it.")
    else:
        notes.append("You have no plan with the player right now.")
    miss = _unforgiven_miss(db, user.id, npc.id)
    if miss:
        notes.append(f"The player did not come to {place_name(miss.place_id)} at {place_label_time(miss.game_seconds)}. "
                     "You are a little hurt; you forgive them if they say sorry.")
    return notes


def _hangout(db: Session, user: User, npc: npc_memory.NpcDef) -> Optional[Appointment]:
    """A meeting that was kept and is still going on (the NPC and the player are together)."""
    now = user.game_seconds or 0
    window = load_plans().rules.hangout_minutes * 60
    return (
        db.query(Appointment)
        .filter(Appointment.user_id == user.id, Appointment.npc_id == npc.id, Appointment.status == "kept",
                Appointment.game_seconds <= now, Appointment.game_seconds + window >= now)
        .order_by(Appointment.game_seconds.desc())
        .first()
    )


def _scene_summary(scene_id: Optional[str]) -> Optional[str]:
    from services.adventure_quests import load_cutscene

    scene = load_cutscene(scene_id) if scene_id else None
    return scene.get("summary") if scene else None


def decision_context(db: Session, user: User, npc: npc_memory.NpcDef) -> dict:
    current = planned(db, user.id, npc.id)
    miss = _unforgiven_miss(db, user.id, npc.id)
    return {
        "places": load_plans().places,
        "current_plan": f"{place_name(current[0].place_id)} at {place_label_time(current[0].game_seconds)}" if current else None,
        "missed_plan": f"{place_name(miss.place_id)} at {place_label_time(miss.game_seconds)}" if miss else None,
    }


def _reaffirms_existing_plan(text: str) -> bool:
    text = text.casefold()
    confirmations = ("keep our plan", "keep the plan", "stick to our plan",
                     "confirm our plan", "our plan is still on", "our meeting is still on",
                     "as planned")
    changes = ("change", "move", "reschedule", "switch", "instead", "rather")
    return any(phrase in text for phrase in confirmations) and not any(word in text for word in changes)


def apply_decision(db: Session, user: User, npc: npc_memory.NpcDef, decision: PlanDecisionResponse,
                   now: int, dialogue_id: Optional[int], *, player_text: str = "") -> tuple[Optional[PlanUpdate], list[str]]:
    """Validate the judge's reading against the rules and the clock, then save it."""
    memories: list[str] = []
    if decision.apologized:
        miss = _unforgiven_miss(db, user.id, npc.id)
        if miss:
            miss.apologized = True
            text = npc_memory.record_plan_event(
                db, user.id, npc, appointment_id=miss.id, event="apology",
                witnessed_text=f"The player said sorry for missing {place_name(miss.place_id)} at {hhmm(miss.game_seconds)}.",
                heard_text=f"{npc.name} mentioned the player said sorry for missing a plan.",
                player_text=f"{npc.name} accepted your apology.",
            )
            if text:
                memories.append(text)

    if decision.action == "cancel":
        current = planned(db, user.id, npc.id)
        for appointment in current:
            appointment.status = "cancelled"
        if current:
            return PlanUpdate(status="cancelled", message=f"Plan with {npc.name} cancelled.",
                              appointment=view(current[0])), memories
        return None, memories

    if decision.action != "create":
        return None, memories

    current = planned(db, user.id, npc.id)
    # A confirmation should never replace an existing booking, even when the
    # AI omits its place/time or reinterprets "tomorrow" after midnight.
    if current and _reaffirms_existing_plan(player_text):
        return None, memories

    rules = load_plans().rules
    known = {p.place_id for p in load_plans().places}
    if decision.place_id not in known or not decision.time:
        return PlanUpdate(status="rejected", message="That plan needs a place in town and a time."), memories
    try:
        minutes = hm_to_minutes(decision.time)
    except ValueError:
        return PlanUpdate(status="rejected", message="That plan needs a clear time."), memories
    target = (now // DAY) * DAY + (DAY if decision.day == "tomorrow" else 0) + minutes * 60
    if any(a.place_id == decision.place_id and a.game_seconds == target for a in current):
        return None, memories
    if not hm_to_minutes(rules.earliest) <= minutes <= hm_to_minutes(rules.latest):
        return PlanUpdate(status="rejected", message=f"Plans must be between {rules.earliest} and {rules.latest}."), memories
    if target - now < rules.min_lead_minutes * 60:
        return PlanUpdate(status="rejected",
                          message=f"Plans need at least {rules.min_lead_minutes} game minutes' notice."), memories
    for appointment in current:
        appointment.status = "cancelled"  # one plan per NPC; a new time replaces the old one
    appointment = Appointment(user_id=user.id, npc_id=npc.id, place_id=decision.place_id, game_seconds=target,
                              status="planned", reminded=False, apologized=False, source_dialogue_id=dialogue_id)
    db.add(appointment)
    db.flush()
    saved = view(appointment)
    return PlanUpdate(status="planned", message=f"Plan saved · {saved.place_name} · {saved.label}",
                      appointment=saved), memories


def process_clock(db: Session, user: User, now: int) -> int:
    """Send due reminders and resolve missed meetings. Returns how many texts were sent."""
    content = load_plans()
    rules = content.rules
    sent = 0
    for appointment in planned(db, user.id):
        npc = npc_memory.npc_by_id(appointment.npc_id)
        if npc is None:
            continue
        place = place_name(appointment.place_id)
        start = appointment.game_seconds
        if not appointment.reminded and start - rules.reminder_before_minutes * 60 <= now < start:
            appointment.reminded = True
            phone.send_from_npc(db, user, npc, content.messages.reminder.format(place=place, time=hhmm(start)))
            sent += 1
        if now >= start + (rules.wait_minutes + rules.hurt_after_minutes) * 60:
            appointment.status = "missed"
            for line in content.messages.missed:
                phone.send_from_npc(db, user, npc, line.format(place=place, time=hhmm(start)))
                sent += 1
            npc_memory.record_plan_event(
                db, user.id, npc, appointment_id=appointment.id, event="plan_missed",
                witnessed_text=f"The player didn't come to {place} at {hhmm(start)} as we planned.",
                heard_text=f"{npc.name} mentioned the player didn't come to {place} at {hhmm(start)}.",
                player_text=f"{npc.name} waited for you at {place}.",
            )
            _resolve_quest(db, user, npc.id)
    return sent


def _resolve_quest(db: Session, user: User, npc_id: str) -> None:
    """A kept or missed meeting finishes a plan_resolved quest for that NPC."""
    if completes_plan_quest(user.adventure_stage, npc_id):
        before = user.adventure_stage
        user.adventure_stage += 1
        after_quests(db, user, before, user.adventure_stage)


class ArrivalError(Exception):
    pass


def arrive(db: Session, user: User, appointment_id: int, now: int) -> tuple[AppointmentView, Optional[str]]:
    appointment = db.get(Appointment, appointment_id)
    if appointment is None or appointment.user_id != user.id:
        raise ArrivalError("No such plan")
    if appointment.status != "planned":
        raise ArrivalError(f"This plan is already {appointment.status}")
    rules = load_plans().rules
    start = appointment.game_seconds
    if not start - ARRIVAL_SLACK_SECONDS <= now <= start + rules.wait_minutes * 60 + ARRIVAL_SLACK_SECONDS:
        raise ArrivalError("It is not time for this plan")
    npc = npc_memory.npc_by_id(appointment.npc_id)
    appointment.status = "kept"
    text = None
    if npc is not None:
        place = place_name(appointment.place_id)
        text = npc_memory.record_plan_event(
            db, user.id, npc, appointment_id=appointment.id, event="plan_kept",
            witnessed_text=f"The player came to {place} at {hhmm(start)}, as we planned.",
            heard_text=f"{npc.name} mentioned meeting the player at {place}.",
            player_text=f"{npc.name} will remember that you kept your promise.",
        )
    _resolve_quest(db, user, appointment.npc_id)
    return view(appointment), text
