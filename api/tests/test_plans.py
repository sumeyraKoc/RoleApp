import sys
import unittest
from datetime import datetime, timedelta
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
from models.models import Appointment, Dialogue, NpcMemory, NpcRelationship, User
from services import npc_memory, plans
from shared.schemas import EvaluateResponse, PlanDecisionResponse

HOUR = 3600


class PlansTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(bind=self.engine)
        with self.factory() as db:
            user = User(username="traveler", password_hash=hash_password("pw"), game_seconds=8 * HOUR)
            db.add(user)
            db.commit()
            self.user_id = user.id

        def test_db():
            with self.factory() as db:
                yield db

        app.dependency_overrides[get_db] = test_db
        self.client = TestClient(app)
        self.auth = ("traveler", "pw")
        self.sam = npc_memory.npc_by_id("sam")

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()
        self.engine.dispose()

    def text_sam(self, text, reply, decision):
        thread = self.client.get("/api/phone/sam", auth=self.auth).json()
        evaluation = EvaluateResponse(accepted=True, npc_response=reply, response_speaker="npc",
                                      updated_scenario_state={"channel": "phone"})
        with patch("routes.turn.evaluate_and_respond", new_callable=AsyncMock, return_value=evaluation) as npc, patch(
            "routes.turn.decide_plan", new_callable=AsyncMock, return_value=decision
        ) as judge, patch("routes.turn.extract_utterance", new_callable=AsyncMock, return_value=None):
            response = self.client.post(f"/api/session/{thread['session_id']}/turn", json={"user_text": text},
                                        auth=self.auth)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json(), npc.call_args.args[0], judge.call_args.args[0]

    def set_clock(self, seconds):
        with self.factory() as db:
            user = db.get(User, self.user_id)
            user.game_seconds = seconds
            user.clock_synced_at = None
            db.commit()

    def tick(self):
        return self.client.post("/api/world/clock/tick", auth=self.auth).json()

    def relationship(self, npc_id):
        with self.factory() as db:
            row = db.query(NpcRelationship).filter_by(user_id=self.user_id, npc_id=npc_id).one()
            return row.sympathy, row.trust

    def test_sam_knows_the_time_and_rules_and_a_plan_is_saved(self):
        body, npc_request, judge_request = self.text_sam(
            "Let's meet at the café at six!", "Six at Leo's café. Deal!",
            PlanDecisionResponse(action="create", place_id="cafe", time="18:00"))
        self.assertEqual(npc_request.world_time, "Day 1 · 08:00")
        self.assertTrue(any("at least 15 minutes" in note for note in npc_request.plan_notes))
        self.assertEqual(judge_request.current_plan, None)
        self.assertEqual(body["plan_update"]["status"], "planned")
        self.assertEqual(body["plan_update"]["appointment"]["label"], "Day 1 · 18:00")
        listed = self.client.get("/api/plans", auth=self.auth).json()["plans"]
        self.assertEqual([(p["place_id"], p["label"]) for p in listed], [("cafe", "Day 1 · 18:00")])

        # Sam's next prompt carries the plan.
        _, npc_request, judge_request = self.text_sam("Cool!", "See you there!", PlanDecisionResponse())
        self.assertTrue(any("Leo's café at 18:00 on Day 1" in note for note in npc_request.plan_notes))
        self.assertEqual(judge_request.current_plan, "Leo's café at 18:00 on Day 1")

    def test_short_notice_is_allowed_and_invalid_agreement_is_corrected(self):
        body, _, _ = self.text_sam(
            "Can we meet at the café at 08:05?", "Deal!",
            PlanDecisionResponse(action="create", place_id="cafe", time="08:05"),
        )
        self.assertEqual(body["plan_update"]["status"], "rejected")
        self.assertIn("15 game minutes", body["plan_update"]["message"])
        self.assertNotIn("Deal", body["npc_response"])
        with self.factory() as db:
            latest = db.query(Dialogue).filter_by(speaker="npc").order_by(Dialogue.id.desc()).first()
            self.assertEqual(latest.text, body["npc_response"])
        body, _, _ = self.text_sam(
            "Can we meet at the café at 08:15?", "Deal!",
            PlanDecisionResponse(action="create", place_id="cafe", time="08:15"),
        )
        self.assertEqual(body["plan_update"]["status"], "planned")
        self.assertEqual(body["npc_response"], "Deal!")

    def test_too_late_and_unknown_places_are_rejected(self):
        body, _, _ = self.text_sam("At 11 pm?", "Ok!", PlanDecisionResponse(action="create", place_id="pier", time="23:00"))
        self.assertEqual(body["plan_update"]["status"], "rejected")
        self.assertNotEqual(body["npc_response"], "Ok!")
        body, _, _ = self.text_sam("The moon?", "Ok!", PlanDecisionResponse(action="create", place_id="moon", time="18:00"))
        self.assertEqual(body["plan_update"]["status"], "rejected")
        self.assertEqual(self.client.get("/api/plans", auth=self.auth).json()["plans"], [])

    def test_reminder_then_missed_meeting_hurts_and_spreads(self):
        self.text_sam("Café at six?", "Deal!", PlanDecisionResponse(action="create", place_id="cafe", time="18:00"))
        self.set_clock(17 * HOUR + 5 * 60)
        self.tick()
        thread = self.client.get("/api/phone/sam", auth=self.auth).json()
        self.assertEqual(thread["messages"][-1]["text"], "See you at Leo's café at 18:00! 📷")
        before = self.relationship("sam")

        self.set_clock(19 * HOUR + 10 * 60)
        self.tick()
        thread = self.client.get("/api/phone/sam", auth=self.auth).json()
        self.assertEqual([m["text"] for m in thread["messages"][-2:]],
                         ["I waited at Leo's café for an hour.", "It's okay. I'm just a little sad."])
        self.assertEqual(self.relationship("sam"), (before[0] - 5, before[1] - 25))
        with self.factory() as db:
            heard = [m.text for m in db.query(NpcMemory).filter_by(user_id=self.user_id, npc_id="leo")]
            self.assertIn("Sam mentioned the player didn't come to Leo's café at 18:00.", heard)
            self.assertEqual(db.query(Appointment).one().status, "missed")
        self.tick()  # resolving twice must not double the penalty or the texts
        self.assertEqual(self.relationship("sam"), (before[0] - 5, before[1] - 25))

        _, npc_request, judge_request = self.text_sam("I'm so sorry, I forgot!", "Thanks for saying sorry.",
                                                      PlanDecisionResponse(apologized=True))
        self.assertEqual(judge_request.missed_plan, "Leo's café at 18:00 on Day 1")
        self.assertTrue(any("did not come" in note for note in npc_request.plan_notes))
        self.assertEqual(self.relationship("sam")[1], before[1] - 25 + 10)

    def test_arriving_in_the_window_keeps_the_promise(self):
        self.text_sam("Pier at four?", "Deal!", PlanDecisionResponse(action="create", place_id="pier", time="16:00"))
        appointment_id = self.client.get("/api/plans", auth=self.auth).json()["plans"][0]["id"]
        self.set_clock(12 * HOUR)
        self.assertEqual(self.client.post(f"/api/plans/{appointment_id}/arrive", auth=self.auth).status_code, 409)
        before = self.relationship("sam")
        self.set_clock(16 * HOUR + 20 * 60)
        response = self.client.post(f"/api/plans/{appointment_id}/arrive", auth=self.auth)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["appointment"]["status"], "kept")
        self.assertEqual(self.relationship("sam"), (before[0] + 5, before[1] + 12))
        self.assertEqual(self.client.post(f"/api/plans/{appointment_id}/arrive", auth=self.auth).status_code, 409)

    def test_after_a_kept_meeting_sam_knows_you_are_together(self):
        self.text_sam("Café at six?", "Deal!", PlanDecisionResponse(action="create", place_id="cafe", time="18:00"))
        appointment_id = self.client.get("/api/plans", auth=self.auth).json()["plans"][0]["id"]
        self.set_clock(18 * HOUR + 5 * 60)
        arrived = self.client.post(f"/api/plans/{appointment_id}/arrive", auth=self.auth).json()
        self.assertEqual(arrived["appointment"]["scene_id"], "cafe_meeting")

        _, npc_request, _ = self.text_sam("This is fun!", "It is!", PlanDecisionResponse())
        notes = " ".join(npc_request.plan_notes)
        self.assertIn("Right now you are together with the player at Leo's café", notes)
        self.assertIn("hot chocolate", notes)  # the cutscene's summary
        self.assertIn("no plan with the player right now", notes)

        self.set_clock(21 * HOUR)  # two game hours later the hangout is over
        _, npc_request, _ = self.text_sam("Hi again", "Hey!", PlanDecisionResponse())
        self.assertNotIn("Right now you are together", " ".join(npc_request.plan_notes))

    def test_a_new_time_replaces_the_old_plan_and_cancel_clears_it(self):
        self.text_sam("Café at six?", "Deal!", PlanDecisionResponse(action="create", place_id="cafe", time="18:00"))
        self.text_sam("Seven instead?", "Sure, seven!", PlanDecisionResponse(action="create", place_id="cafe", time="19:00"))
        listed = self.client.get("/api/plans", auth=self.auth).json()["plans"]
        self.assertEqual([p["label"] for p in listed], ["Day 1 · 19:00"])
        body, _, _ = self.text_sam("Sorry, can we skip today?", "No problem!", PlanDecisionResponse(action="cancel"))
        self.assertEqual(body["plan_update"]["status"], "cancelled")
        self.assertEqual(self.client.get("/api/plans", auth=self.auth).json()["plans"], [])


if __name__ == "__main__":
    unittest.main()
