import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from core.database import Base, get_db
from core.security import hash_password
from main import app
from models.models import Appointment, InventoryItem, NpcMemory, User
from shared.schemas import EvaluateResponse, PlanDecisionResponse

HOUR = 3600


class Kademe2FlowTest(unittest.TestCase):
    """Tier 2 end to end: reunion scene → text Sam → meet Sam → pier."""

    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(bind=self.engine)
        with self.factory() as db:
            user = User(username="traveler", password_hash=hash_password("pw"), adventure_stage=3, game_seconds=9 * HOUR)
            db.add(user)
            db.commit()
            self.user_id = user.id

        def test_db():
            with self.factory() as db:
                yield db

        app.dependency_overrides[get_db] = test_db
        self.client = TestClient(app)
        self.auth = ("traveler", "pw")

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()
        self.engine.dispose()

    def stage(self):
        with self.factory() as db:
            return db.get(User, self.user_id).adventure_stage

    def text_sam(self, text, decision=None):
        thread = self.client.get("/api/phone/sam", auth=self.auth).json()
        reply = EvaluateResponse(accepted=True, npc_response="Hey!", response_speaker="npc",
                                 updated_scenario_state={"channel": "phone"})
        with patch("routes.turn.evaluate_and_respond", new_callable=AsyncMock, return_value=reply) as npc, patch(
            "routes.turn.decide_plan", new_callable=AsyncMock, return_value=decision or PlanDecisionResponse()
        ), patch("routes.turn.extract_utterance", new_callable=AsyncMock, return_value=None):
            response = self.client.post(f"/api/session/{thread['session_id']}/turn", json={"user_text": text},
                                        auth=self.auth)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json(), npc.call_args.args[0]

    def test_whole_tier(self):
        state = self.client.get("/api/adventure/state", auth=self.auth).json()
        self.assertEqual([t["tier"] for t in state["adventure"]["tiers"]][:2], [1, 2])
        self.assertEqual(self.client.get("/api/adventure/cutscenes/meet_sam", auth=self.auth).json()["id"], "meet_sam")
        self.assertEqual(self.client.get("/api/adventure/cutscenes/..%2Fplans", auth=self.auth).status_code, 404)

        # A scene that is not the current quest does nothing.
        self.assertFalse(self.client.post("/api/adventure/scenes/pier_departure/seen", auth=self.auth).json()["completed"])
        body = self.client.post("/api/adventure/scenes/meet_sam/seen", auth=self.auth).json()
        self.assertTrue(body["completed"])
        self.assertEqual(body["stage"], 4)
        thread = self.client.get("/api/phone/sam", auth=self.auth).json()
        self.assertEqual(thread["unread"], 1)

        # Text Sam back: any accepted phone message, at the tier's language level.
        _, request = self.text_sam("Hi Sam! It's me!")
        self.assertEqual(request.cefr_level, "A2")
        self.assertEqual(self.stage(), 5)
        texts = [m["text"] for m in self.client.get("/api/phone/sam", auth=self.auth).json()["messages"]]
        self.assertEqual(texts[-1], "I got my camera bag! Do you want to meet today? Where and when?")

        # Meet Sam: plan, then arrive.
        self.text_sam("Café at six?", PlanDecisionResponse(action="create", place_id="cafe", time="18:00"))
        plan_id = self.client.get("/api/plans", auth=self.auth).json()["plans"][0]["id"]
        with self.factory() as db:
            user = db.get(User, self.user_id)
            user.game_seconds, user.clock_synced_at = 18 * HOUR + 10 * 60, None
            db.commit()
        self.assertEqual(self.client.post(f"/api/plans/{plan_id}/arrive", auth=self.auth).status_code, 200)
        self.assertEqual(self.stage(), 6)
        state = self.client.get("/api/adventure/state", auth=self.auth).json()
        self.assertEqual(state["flags"], {"kept_meeting": True, "missed_meeting": False})

        # Ready to sail: needs the handbook.
        body = self.client.post("/api/adventure/reach/pier", auth=self.auth).json()
        self.assertEqual((body["completed"], body["missing"]), (False, ["boat_building_manual"]))
        with self.factory() as db:
            db.add(InventoryItem(user_id=self.user_id, item_id="boat_building_manual", name="Handbook", quantity=1))
            db.commit()
        self.assertFalse(self.client.post("/api/adventure/reach/cafe", auth=self.auth).json()["completed"])
        body = self.client.post("/api/adventure/reach/pier", auth=self.auth).json()
        self.assertEqual((body["completed"], body["scene_id"], body["stage"]), (True, "pier_departure", 7))
        with self.factory() as db:
            sam = {m.text for m in db.query(NpcMemory).filter_by(user_id=self.user_id, npc_id="sam")}
        self.assertIn('You helped the player finish the quest "Meet Sam".', sam)

    def test_reaffirming_plan_does_not_move_it_to_another_day(self):
        with self.factory() as db:
            user = db.get(User, self.user_id)
            user.adventure_stage = 5
            user.game_seconds = 24 * HOUR + 9 * HOUR  # Day 2, 09:00
            db.commit()
        first, _ = self.text_sam(
            "Let's meet tomorrow at ten at Leo's café.",
            PlanDecisionResponse(action="create", place_id="cafe", time="10:00", day="tomorrow"),
        )
        original_id = first["plan_update"]["appointment"]["id"]
        with self.factory() as db:
            user = db.get(User, self.user_id)
            user.game_seconds = 2 * 24 * HOUR + 7 * HOUR  # Day 3, 07:00
            user.clock_synced_at = None
            db.commit()
        repeated, _ = self.text_sam(
            "Yes, let's keep our plan for ten tomorrow at Leo's café.",
            PlanDecisionResponse(action="create", place_id="cafe", time="10:00", day="tomorrow"),
        )
        self.assertIsNone(repeated["plan_update"])
        with self.factory() as db:
            appointments = db.query(Appointment).filter_by(user_id=self.user_id, npc_id="sam").all()
            self.assertEqual(len(appointments), 1)
            self.assertEqual((appointments[0].id, appointments[0].status, appointments[0].game_seconds),
                             (original_id, "planned", 2 * 24 * HOUR + 10 * HOUR))
        changed, _ = self.text_sam(
            "Let's change our meeting to tomorrow at eleven at Leo's café.",
            PlanDecisionResponse(action="create", place_id="cafe", time="11:00", day="tomorrow"),
        )
        self.assertEqual(changed["plan_update"]["status"], "planned")
        with self.factory() as db:
            appointments = db.query(Appointment).filter_by(user_id=self.user_id, npc_id="sam").order_by(Appointment.id).all()
            self.assertEqual([a.status for a in appointments], ["cancelled", "planned"])
            self.assertEqual(appointments[-1].game_seconds, 3 * 24 * HOUR + 11 * HOUR)

    def test_missing_the_meeting_still_moves_the_story_on(self):
        with self.factory() as db:
            db.get(User, self.user_id).adventure_stage = 5
            db.commit()
        self.text_sam("Pier at noon?", PlanDecisionResponse(action="create", place_id="pier", time="12:00"))
        with self.factory() as db:
            user = db.get(User, self.user_id)
            user.game_seconds, user.clock_synced_at = 13 * HOUR + 15 * 60, None
            db.commit()
        self.client.post("/api/world/clock/tick", auth=self.auth)
        self.assertEqual(self.stage(), 6)
        flags = self.client.get("/api/adventure/state", auth=self.auth).json()["flags"]
        self.assertEqual(flags, {"kept_meeting": False, "missed_meeting": True})

    def test_roleplay_conversations_never_advance_quests(self):
        with self.factory() as db:
            db.get(User, self.user_id).adventure_stage = 4
            db.commit()
        response = self.client.post("/api/session/start", json={
            "username": "traveler", "password": "pw", "location": "town", "npc_role": "friend", "mode": "roleplay"})
        session_id = response.json()["session_id"]
        reply = EvaluateResponse(accepted=True, npc_response="Hey!", response_speaker="npc", updated_scenario_state={})
        with patch("routes.turn.evaluate_and_respond", new_callable=AsyncMock, return_value=reply), patch(
            "routes.turn.decide_plan", new_callable=AsyncMock, return_value=PlanDecisionResponse()
        ), patch("routes.turn.extract_utterance", new_callable=AsyncMock, return_value=None):
            self.client.post(f"/api/session/{session_id}/turn", json={"user_text": "Hi!"}, auth=self.auth)
        self.assertEqual(self.stage(), 4)


if __name__ == "__main__":
    unittest.main()
