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
from models.models import GameSession, InventoryItem, User
from services.adventure_quests import load_adventure
from shared.schemas import EvaluateResponse, InventoryDecisionResponse, InventoryTransfer, SentenceCheckResponse

QUESTS = [q.id for q in load_adventure().quests]
STAGE = {quest_id: index for index, quest_id in enumerate(QUESTS)}


class Kademe3FlowTest(unittest.TestCase):
    """Tier 3 end to end: sail → market → rune gate → Elowen → lantern → lighthouse."""

    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(bind=self.engine)
        with self.factory() as db:
            user = User(username="sailor", password_hash=hash_password("pw"), adventure_stage=STAGE["ready_to_sail"])
            db.add(user)
            db.flush()
            market = GameSession(user_id=user.id, location="market", npc_role="merchant", mode="adventure")
            lighthouse = GameSession(user_id=user.id, location="lighthouse", npc_role="keeper", mode="adventure")
            db.add_all([market, lighthouse])
            db.commit()
            self.user_id, self.market_id, self.lighthouse_id = user.id, market.id, lighthouse.id

        def test_db():
            with self.factory() as db:
                yield db

        app.dependency_overrides[get_db] = test_db
        self.client = TestClient(app)
        self.auth = ("sailor", "pw")

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()
        self.engine.dispose()

    def set_stage(self, quest_id):
        with self.factory() as db:
            db.get(User, self.user_id).adventure_stage = STAGE[quest_id]
            db.commit()

    def stage(self):
        with self.factory() as db:
            return db.get(User, self.user_id).adventure_stage

    def talk(self, session_id, text, transfers=()):
        reply = EvaluateResponse(accepted=True, npc_response="Ah, travellers!", response_speaker="npc", updated_scenario_state={})
        with patch("routes.turn.evaluate_and_respond", new_callable=AsyncMock, return_value=reply) as npc, patch(
            "routes.turn.decide_inventory_transfers", new_callable=AsyncMock,
            return_value=InventoryDecisionResponse(transfers=list(transfers)),
        ), patch("routes.turn.extract_utterance", new_callable=AsyncMock, return_value=None):
            response = self.client.post(f"/api/session/{session_id}/turn", json={"user_text": text}, auth=self.auth)
        self.assertEqual(response.status_code, 200, response.text)
        return npc.call_args.args[0]

    def test_the_isles_open_only_when_tier_three_starts(self):
        self.assertEqual(self.client.post("/api/adventure/travel/isles", auth=self.auth).status_code, 409)
        self.set_stage("land_ho")
        state = self.client.post("/api/adventure/travel/isles", auth=self.auth).json()
        self.assertEqual((state["world"], state["unlocked_worlds"]), ("isles", ["town", "isles"]))
        self.assertEqual(self.client.get("/api/adventure/state", auth=self.auth).json()["world"], "isles")
        self.assertEqual(self.client.post("/api/adventure/travel/moon", auth=self.auth).status_code, 409)

    def test_whole_tier(self):
        self.set_stage("land_ho")
        self.assertTrue(self.client.post("/api/adventure/scenes/arrive_isles/seen", auth=self.auth).json()["completed"])
        request = self.talk(self.market_id, "Hello! Why is the lighthouse dark?")
        self.assertEqual(request.cefr_level, "B1")
        self.assertEqual(self.stage(), STAGE["rune_gate"])

        self.client.get("/api/spells/mist_gate", auth=self.auth)
        word = self.client.get("/api/spells/mist_gate", auth=self.auth).json()["word"]
        with patch("routes.spells.check_sentence", new_callable=AsyncMock, return_value=SentenceCheckResponse(accepted=True)):
            body = self.client.post("/api/spells/mist_gate/cast", auth=self.auth,
                                    json={"text": f"I really want to {word} this old gate today"}).json()
        self.assertTrue(body["success"] and body["quest_completed"])
        self.assertEqual(self.stage(), STAGE["keeper_of_light"])

        self.talk(self.lighthouse_id, "Hello Elowen, how can we bring the light back?")
        self.assertEqual(self.stage(), STAGE["fair_trade"])
        self.talk(self.market_id, "Here is some bread. Can we trade it for the lantern?", [
            InventoryTransfer(item_id="mist_lantern", name="Mist Lantern", delta=1, category="other"),
        ])
        self.assertEqual(self.stage(), STAGE["light_lighthouse"])
        body = self.client.post("/api/adventure/reach/lighthouse", auth=self.auth).json()
        self.assertEqual((body["completed"], body["scene_id"]), (True, "light_lighthouse"))
        self.assertEqual(self.stage(), STAGE["witch_curse"])  # Chapter 4 starts


if __name__ == "__main__":
    unittest.main()
