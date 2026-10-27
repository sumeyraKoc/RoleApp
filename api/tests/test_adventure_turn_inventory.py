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
from models.models import GameSession, User
from services.adventure_inventory import inventory_snapshot
from shared.schemas import EvaluateResponse, InventoryDecisionResponse, InventoryTransfer


class AdventureTurnInventoryTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.session_factory = sessionmaker(bind=self.engine)
        with self.session_factory() as db:
            user = User(username="traveler", password_hash=hash_password("test-pass"), adventure_stage=0)
            db.add(user)
            db.flush()
            session = GameSession(user_id=user.id, location="bakery", npc_role="baker", mode="adventure")
            db.add(session)
            db.commit()
            self.user_id, self.session_id = user.id, session.id

        def test_db():
            with self.session_factory() as db:
                yield db

        app.dependency_overrides[get_db] = test_db
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()
        self.engine.dispose()

    def test_turn_returns_changes_and_advances_after_multi_item_handover(self):
        evaluation = EvaluateResponse(
            accepted=True, npc_response="Here are two buns and a bottle of water.",
            response_speaker="npc", updated_scenario_state={},
        )
        decision = InventoryDecisionResponse(transfers=[
            InventoryTransfer(item_id="bun", name="Bun", delta=2, category="food"),
            InventoryTransfer(item_id="water", name="Water", delta=1, category="drink"),
        ])
        with patch("routes.turn.evaluate_and_respond", new_callable=AsyncMock, return_value=evaluation), patch(
            "routes.turn.decide_inventory_transfers", new_callable=AsyncMock, return_value=decision
        ) as judge, patch("routes.turn.extract_utterance", new_callable=AsyncMock, return_value=None):
            response = self.client.post(
                f"/api/session/{self.session_id}/turn",
                json={"user_text": "Could I have travel supplies?"},
                auth=("traveler", "test-pass"),
            )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["adventure_stage"], 1)
        self.assertEqual({x["item_id"]: x["quantity"] for x in body["inventory_changes"]}, {"bun": 2, "water": 1})
        request = judge.call_args.args[0]
        self.assertEqual(request.player_text, "Could I have travel supplies?")
        self.assertEqual(request.inventory, [])
        with self.session_factory() as db:
            self.assertEqual({x["item_id"]: x["quantity"] for x in inventory_snapshot(db, self.user_id)}, {"bun": 2, "water": 1})

    def test_lina_talk_alone_does_not_advance_but_manual_delivery_does(self):
        with self.session_factory() as db:
            user = db.get(User, self.user_id)
            user.adventure_stage = 1
            session = db.get(GameSession, self.session_id)
            session.location = "library"
            session.npc_role = "librarian"
            db.commit()

        generic_reply = EvaluateResponse(
            accepted=True, npc_response="We have many books on crafts.",
            response_speaker="npc", updated_scenario_state={},
        )
        empty_decision = InventoryDecisionResponse()
        with patch("routes.turn.evaluate_and_respond", new_callable=AsyncMock, return_value=generic_reply) as npc, patch(
            "routes.turn.decide_inventory_transfers", new_callable=AsyncMock, return_value=empty_decision
        ), patch("routes.turn.extract_utterance", new_callable=AsyncMock, return_value=None):
            response = self.client.post(
                f"/api/session/{self.session_id}/turn", json={"user_text": "Do you have books?"},
                auth=("traveler", "test-pass"),
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["adventure_stage"], 1)
        self.assertFalse(hasattr(npc.call_args.args[0], "adventure_goal"))

        manual_reply = EvaluateResponse(
            accepted=True, npc_response="Here is a handbook on building a rowboat. Take it.",
            response_speaker="npc", updated_scenario_state={},
        )
        manual_decision = InventoryDecisionResponse(transfers=[
            InventoryTransfer(item_id="boat_building_manual", name="Boat-Building Handbook", delta=1, category="other"),
        ])
        with patch("routes.turn.evaluate_and_respond", new_callable=AsyncMock, return_value=manual_reply), patch(
            "routes.turn.decide_inventory_transfers", new_callable=AsyncMock, return_value=manual_decision
        ), patch("routes.turn.extract_utterance", new_callable=AsyncMock, return_value=None):
            response = self.client.post(
                f"/api/session/{self.session_id}/turn", json={"user_text": "May I take that manual?"},
                auth=("traveler", "test-pass"),
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["adventure_stage"], 2)
        self.assertEqual(response.json()["inventory_changes"][0]["item_id"], "boat_building_manual")


if __name__ == "__main__":
    unittest.main()
