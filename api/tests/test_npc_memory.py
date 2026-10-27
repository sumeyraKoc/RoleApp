import json
import sys
import tempfile
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
from models.models import GameSession, NpcMemory, NpcRelationship, User
from services import npc_memory
from services.adventure_quests import SCENARIOS_DIR
from shared.schemas import EvaluateResponse, InventoryDecisionResponse, InventoryTransfer


def _memories(db, user_id, npc_id):
    return [(m.kind, m.text) for m in db.query(NpcMemory).filter_by(user_id=user_id, npc_id=npc_id).order_by(NpcMemory.id)]


def _rel(db, user_id, npc_id):
    row = db.query(NpcRelationship).filter_by(user_id=user_id, npc_id=npc_id).one()
    return row.sympathy, row.trust


class NpcContentTest(unittest.TestCase):
    def test_every_npc_matches_a_scenario(self):
        for npc in npc_memory.load_npcs().npcs:
            scenario = json.loads((Path(SCENARIOS_DIR) / f"{npc.location}.json").read_text(encoding="utf-8"))
            self.assertEqual(scenario["npc_role"], npc.npc_role, npc.id)

    def test_unknown_friend_is_rejected(self):
        content = json.loads(Path(npc_memory.NPCS_FILE).read_text(encoding="utf-8"))
        content["npcs"][0]["friends"] = ["nobody"]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as handle:
            json.dump(content, handle)
        with self.assertRaises(ValueError):
            npc_memory.load_npcs.__wrapped__(handle.name)
        Path(handle.name).unlink()

    def test_tiers(self):
        self.assertEqual([npc_memory.tier_for(v) for v in (-80, -20, 0, 40, 90)],
                         ["hostile", "cold", "neutral", "friendly", "close"])


class NpcMemoryServiceTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        user = User(username="traveler", password_hash="x", adventure_stage=0)
        self.db.add(user)
        self.db.flush()
        self.user_id = user.id
        self.maya = npc_memory.npc_by_id("maya")

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_gift_is_remembered_once_and_spreads_one_hop(self):
        text = npc_memory.record_inventory_event(self.db, self.user_id, self.maya, event_id=7, item_name="Map", delta=-1)
        self.assertIn("Maya will remember your gift", text)
        self.assertIn("Lina, Leo and Sam will hear about it", text)
        self.assertIsNone(npc_memory.record_inventory_event(self.db, self.user_id, self.maya, event_id=7, item_name="Map", delta=-1))

        self.assertEqual(_memories(self.db, self.user_id, "maya"), [("witnessed", "The player gave you 1 × Map.")])
        self.assertEqual(_memories(self.db, self.user_id, "lina"),
                         [("heard", "Maya mentioned that the player gave Maya 1 × Map.")])
        self.assertEqual(_rel(self.db, self.user_id, "maya"), (5, 42))
        self.assertEqual(_rel(self.db, self.user_id, "lina"), (2, 40))  # 30% of +5, rounded
        # Lina is only Maya's friend: news from Lina does not reach Leo.
        lina = npc_memory.npc_by_id("lina")
        npc_memory.record_quest_completed(self.db, self.user_id, lina, quest_id="q", quest_title="Q")
        self.assertEqual([k for k, _ in _memories(self.db, self.user_id, "leo")], ["heard"])

    def test_small_talk_is_capped_per_conversation(self):
        for _ in range(30):
            npc_memory.record_accepted_turn(self.db, self.user_id, 1, self.maya)
        self.assertEqual(_rel(self.db, self.user_id, "maya")[0], 10)
        npc_memory.record_accepted_turn(self.db, self.user_id, 2, self.maya)
        self.assertEqual(_rel(self.db, self.user_id, "maya")[0], 11)

    def test_prompt_memories_are_recent_and_labelled(self):
        npc_memory.record_inventory_event(self.db, self.user_id, self.maya, event_id=1, item_name="Bread", delta=2)
        self.assertEqual(npc_memory.memories_for_prompt(self.db, self.user_id, self.maya),
                         ["(witnessed) You gave the player 2 × Bread."])


class NpcMemoryTurnTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.session_factory = sessionmaker(bind=self.engine)
        with self.session_factory() as db:
            user = User(username="traveler", password_hash=hash_password("test-pass"), adventure_stage=0)
            db.add(user)
            db.flush()
            bakery = GameSession(user_id=user.id, location="bakery", npc_role="baker", mode="adventure")
            library = GameSession(user_id=user.id, location="library", npc_role="librarian", mode="adventure")
            db.add_all([bakery, library])
            db.commit()
            self.bakery_id, self.library_id = bakery.id, library.id

        def test_db():
            with self.session_factory() as db:
                yield db

        app.dependency_overrides[get_db] = test_db
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()
        self.engine.dispose()

    def _turn(self, session_id, text, reply, transfers=()):
        evaluation = EvaluateResponse(accepted=True, npc_response=reply, response_speaker="npc", updated_scenario_state={})
        decision = InventoryDecisionResponse(transfers=list(transfers))
        with patch("routes.turn.evaluate_and_respond", new_callable=AsyncMock, return_value=evaluation) as npc, patch(
            "routes.turn.decide_inventory_transfers", new_callable=AsyncMock, return_value=decision
        ), patch("routes.turn.extract_utterance", new_callable=AsyncMock, return_value=None):
            response = self.client.post(f"/api/session/{session_id}/turn", json={"user_text": text},
                                        auth=("traveler", "test-pass"))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json(), npc.call_args.args[0]

    def test_maya_remembers_and_lina_hears(self):
        body, _ = self._turn(self.bakery_id, "Two loaves, please.", "Here are two loaves of bread.",
                             [InventoryTransfer(item_id="bread", name="Bread", delta=2, category="food")])
        self.assertEqual(body["adventure_stage"], 1)
        self.assertTrue(any("Maya will remember giving you 2 × Bread" in m for m in body["new_memories"]))
        self.assertTrue(any("Supplies for the Road" in m for m in body["new_memories"]))
        self.assertEqual(body["relationship"]["npc_id"], "maya")
        self.assertEqual(body["relationship"]["sympathy"], 1 + 8 + 1)  # gift, quest, small talk

        _, request = self._turn(self.bakery_id, "Thanks!", "You're welcome.")
        self.assertIn("(witnessed) You gave the player 2 × Bread.", request.npc_memories)
        self.assertEqual(request.relationship_tier, "neutral")

        _, request = self._turn(self.library_id, "Hello Lina.", "Hello there!")
        self.assertIn("(heard) Maya mentioned giving the player 2 × Bread.", request.npc_memories)
        self.assertTrue(any("Supplies for the Road" in m and m.startswith("(heard)") for m in request.npc_memories))


class MigrationTest(unittest.TestCase):
    def test_migrations_match_models(self):
        from alembic import command
        from alembic.autogenerate import compare_metadata
        from alembic.config import Config
        from alembic.migration import MigrationContext
        import os

        with tempfile.TemporaryDirectory() as tmp:
            url = f"sqlite:///{Path(tmp) / 'm.db'}"
            config = Config(str(API_ROOT / "alembic.ini"))
            config.set_main_option("script_location", str(API_ROOT / "migrations"))
            with patch.dict(os.environ, {"DATABASE_URL": url}):
                command.upgrade(config, "head")
            engine = create_engine(url)
            with engine.connect() as connection:
                diff = compare_metadata(MigrationContext.configure(connection), Base.metadata)
            engine.dispose()
        new_tables = [d for d in diff if d[0] in ("add_table", "remove_table", "add_column", "remove_column")
                      and "npc_" in str(d)]
        self.assertEqual(new_tables, [])


if __name__ == "__main__":
    unittest.main()
