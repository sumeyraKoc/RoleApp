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


class Kademe4FlowTest(unittest.TestCase):
    """Tier 4 end to end: curse → alchemist → moonpetal → silver salt → brew → thorn gate → witch → curse broken."""

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

    def test_whole_tier(self):
        with self.factory() as db:
            lab = GameSession(user_id=self.user_id, location="lab", npc_role="alchemist", mode="adventure")
            tower = GameSession(user_id=self.user_id, location="tower", npc_role="witch", mode="adventure")
            db.add_all([lab, tower])
            db.commit()
            lab_id, tower_id = lab.id, tower.id

        self.set_stage("witch_curse")
        self.assertTrue(self.client.post("/api/adventure/scenes/witch_curse/seen", auth=self.auth).json()["completed"])
        request = self.talk(lab_id, "Hello Orrin! A witch cursed the isles. Can I be your lab assistant?")
        self.assertIn("lab assistant", request.scene_note)  # the quest tells Orrin what to do
        self.assertIn("Morwen", request.scene_note)  # and the chapter tells him the story so far
        self.assertEqual(self.stage(), STAGE["moonpetal"])

        request = self.talk(self.lighthouse_id, "Elowen, may I have a Moonpetal for the antidote, please?", [
            InventoryTransfer(item_id="moonpetal", name="Moonpetal", delta=1, category="other"),
        ])
        self.assertIn("Moonpetal", request.scene_note)
        self.assertEqual(self.stage(), STAGE["silver_salt"])

        # Without the Silver Salt the brew can't start yet.
        self.set_stage("brew_potion")
        body = self.client.post("/api/adventure/reach/lab", auth=self.auth).json()
        self.assertEqual((body["completed"], body["missing"]), (False, ["silver_salt"]))
        self.set_stage("silver_salt")
        self.talk(self.market_id, "I can help you sort your charms for a jar of Silver Salt.", [
            InventoryTransfer(item_id="silver_salt", name="Silver Salt", delta=1, category="other"),
        ])
        self.assertEqual(self.stage(), STAGE["brew_potion"])
        body = self.client.post("/api/adventure/reach/lab", auth=self.auth).json()
        self.assertEqual((body["completed"], body["scene_id"]), (True, "brew_potion"))
        self.assertEqual(self.stage(), STAGE["thorn_gate"])

        word = self.client.get("/api/spells/thorn_gate", auth=self.auth).json()["word"]
        with patch("routes.spells.check_sentence", new_callable=AsyncMock, return_value=SentenceCheckResponse(accepted=True)):
            body = self.client.post("/api/spells/thorn_gate/cast", auth=self.auth,
                                    json={"text": f"With a lot of {word} we will open this thorn gate"}).json()
        self.assertTrue(body["success"] and body["quest_completed"])
        self.assertEqual(self.stage(), STAGE["the_witch"])

        request = self.talk(tower_id, "Hello Morwen. Why did you curse the isles?")
        self.assertIn("nobody has visited you", request.scene_note)
        self.assertEqual(self.stage(), STAGE["break_curse"])
        body = self.client.post("/api/adventure/reach/tower", auth=self.auth).json()
        self.assertEqual((body["completed"], body["scene_id"]), (True, "break_curse"))
        self.assertEqual(self.stage(), len(QUESTS))

    def test_other_npcs_get_the_story_but_not_someone_elses_quest(self):
        self.set_stage("moonpetal")
        request = self.talk(self.market_id, "Hello Tobias!")
        self.assertIn("Morwen", request.scene_note)
        self.assertNotIn("Moonpetal from your garden", request.scene_note)


if __name__ == "__main__":
    unittest.main()
