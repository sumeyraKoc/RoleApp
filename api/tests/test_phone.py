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
from models.models import Dialogue, GameSession, User
from services import npc_memory, phone
from shared.schemas import EvaluateResponse


class PhoneTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(bind=self.engine)
        with self.factory() as db:
            user = User(username="traveler", password_hash=hash_password("pw"))
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

    def test_scripted_message_is_unread_until_seen(self):
        with self.factory() as db:
            user = db.get(User, self.user_id)
            phone.send_from_npc(db, user, npc_memory.npc_by_id("sam"), "Hey, it's Sam! Did you sleep well?")
            db.commit()
        body = self.client.get("/api/phone/sam", auth=self.auth).json()
        self.assertEqual(body["contact"], "Sam")
        self.assertEqual(body["unread"], 1)
        self.assertEqual(body["messages"][-1]["text"], "Hey, it's Sam! Did you sleep well?")
        self.client.post("/api/phone/sam/read", json={"last_id": body["messages"][-1]["id"]}, auth=self.auth)
        self.assertEqual(self.client.get("/api/phone/sam", auth=self.auth).json()["unread"], 0)

    def test_reply_uses_the_turn_pipeline_and_the_phone_channel(self):
        thread = self.client.get("/api/phone/sam", auth=self.auth).json()
        reply = EvaluateResponse(accepted=True, npc_response="Cool! Café at six?", response_speaker="npc",
                                 updated_scenario_state={"channel": "phone"})
        with patch("routes.turn.evaluate_and_respond", new_callable=AsyncMock, return_value=reply) as npc, patch(
            "routes.turn.extract_utterance", new_callable=AsyncMock, return_value=None
        ):
            response = self.client.post(f"/api/session/{thread['session_id']}/turn",
                                        json={"user_text": "Yes, let's meet!"}, auth=self.auth)
        self.assertEqual(response.status_code, 200, response.text)
        request = npc.call_args.args[0]
        self.assertEqual((request.location, request.npc_role), ("town", "friend"))
        self.assertEqual(request.scenario_state, {"channel": "phone"})
        self.assertEqual(response.json()["relationship"]["npc_id"], "sam")
        texts = [m["text"] for m in self.client.get("/api/phone/sam", auth=self.auth).json()["messages"]]
        self.assertEqual(texts, ["Yes, let's meet!", "Cool! Café at six?"])

    def test_phone_and_face_to_face_share_history_and_ai_context(self):
        thread = self.client.get("/api/phone/sam", auth=self.auth).json()
        with self.factory() as db:
            face = GameSession(user_id=self.user_id, location="town", npc_role="friend",
                               mode="roleplay", scenario_state={})
            db.add(face)
            db.flush()
            face_id = face.id
            db.add_all([
                Dialogue(session_id=face_id, speaker="user", text="See you at the café", is_natural=True),
                Dialogue(session_id=face_id, speaker="npc", text="Sounds good!"),
            ])
            phone.send_from_npc(db, db.get(User, self.user_id), npc_memory.npc_by_id("sam"), "Text me later!")
            db.commit()

        body = self.client.get("/api/phone/sam", auth=self.auth).json()
        self.assertEqual([(m["text"], m["channel"]) for m in body["messages"]], [
            ("See you at the café", "in_person"),
            ("Sounds good!", "in_person"),
            ("Text me later!", "phone"),
        ])
        self.assertEqual(body["unread"], 1)  # spoken replies are not unread texts

        reply = EvaluateResponse(accepted=True, npc_response="I remember!", response_speaker="npc",
                                 updated_scenario_state={})
        with patch("routes.turn.evaluate_and_respond", new_callable=AsyncMock, return_value=reply) as npc, patch(
            "routes.turn.extract_utterance", new_callable=AsyncMock, return_value=None
        ), patch("routes.turn.decide_plan", new_callable=AsyncMock):
            response = self.client.post(f"/api/session/{thread['session_id']}/turn",
                                        json={"user_text": "Hi Sam"}, auth=self.auth)
            self.assertEqual(response.status_code, 200, response.text)
            history = [(m.speaker, m.text) for m in npc.call_args.args[0].dialogue_history]
            self.assertEqual(history, [
                ("user", "See you at the café"), ("npc", "Sounds good!"), ("npc", "Text me later!"),
            ])
            response = self.client.post(f"/api/session/{face_id}/turn",
                                        json={"user_text": "I got your text"}, auth=self.auth)
            self.assertEqual(response.status_code, 200, response.text)
            history = [(m.speaker, m.text) for m in npc.call_args.args[0].dialogue_history]
            self.assertIn(("user", "Hi Sam"), history)
            self.assertIn(("npc", "I remember!"), history)

        body = self.client.get("/api/phone/sam", auth=self.auth).json()
        self.assertEqual([m["channel"] for m in body["messages"][-4:]],
                         ["phone", "phone", "in_person", "in_person"])

    def test_busy_ai_gives_a_clear_503_not_a_500(self):
        import httpx
        thread = self.client.get("/api/phone/sam", auth=self.auth).json()
        failure = httpx.HTTPStatusError("500", request=httpx.Request("POST", "http://ai"), response=httpx.Response(500))
        with patch("routes.turn.evaluate_and_respond", new_callable=AsyncMock, side_effect=failure):
            response = self.client.post(f"/api/session/{thread['session_id']}/turn",
                                        json={"user_text": "Hi!"}, auth=self.auth)
        self.assertEqual(response.status_code, 503)
        self.assertIn("Sam couldn't answer right now", response.json()["detail"])

    def test_a_cutscene_moment_reaches_the_npc(self):
        thread = self.client.get("/api/phone/sam", auth=self.auth).json()
        reply = EvaluateResponse(accepted=True, npc_response="Enjoy it!", response_speaker="npc", updated_scenario_state={})
        with patch("routes.turn.evaluate_and_respond", new_callable=AsyncMock, return_value=reply) as npc, patch(
            "routes.turn.extract_utterance", new_callable=AsyncMock, return_value=None
        ):
            self.client.post(f"/api/session/{thread['session_id']}/turn", auth=self.auth, json={
                "user_text": "Thank you, Sam!",
                "scene_note": "You just gave the player a hot chocolate. The player's task right now: Thank Sam.",
            })
        self.assertEqual(npc.call_args.args[0].scene_note,
                         "You just gave the player a hot chocolate. The player's task right now: Thank Sam.")

    def test_shopkeepers_have_no_phone_thread(self):
        self.assertEqual(self.client.get("/api/phone/maya", auth=self.auth).status_code, 404)


if __name__ == "__main__":
    unittest.main()
