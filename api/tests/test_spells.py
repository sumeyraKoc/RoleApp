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
from models.models import User, WordEvent
from services import spells
from shared.schemas import SentenceCheckResponse


class SpellWordTest(unittest.TestCase):
    def test_inflections_count(self):
        self.assertTrue(spells.uses_word("Please open the gate", "open"))
        self.assertTrue(spells.uses_word("She opened it slowly", "open"))
        self.assertTrue(spells.uses_word("We are opening the door", "open"))
        self.assertTrue(spells.uses_word("I promised my friend", "promise"))
        self.assertTrue(spells.uses_word("I'm promising you", "promise"))
        self.assertFalse(spells.uses_word("Openly speaking", "pen"))
        self.assertFalse(spells.uses_word("The gate is shut", "open"))


class SpellRouteTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(bind=self.engine)
        with self.factory() as db:
            user = User(username="mage", password_hash=hash_password("pw"))
            db.add(user)
            db.flush()
            # A word the player keeps getting wrong becomes their spell.
            for _ in range(4):
                db.add(WordEvent(user_id=user.id, lemma="borrow", event_type="usage_fail"))
            db.commit()
            self.user_id = user.id

        def test_db():
            with self.factory() as db:
                yield db

        app.dependency_overrides[get_db] = test_db
        self.client = TestClient(app)
        self.auth = ("mage", "pw")

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()
        self.engine.dispose()

    def cast(self, text, accepted=True, practice=False):
        with patch("routes.spells.check_sentence", new_callable=AsyncMock,
                   return_value=SentenceCheckResponse(accepted=accepted, correction="Can I borrow your map, please?")) as check:
            response = self.client.post("/api/spells/mist_gate/cast", json={"text": text, "practice": practice}, auth=self.auth)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json(), check

    def test_the_spell_is_a_hard_word_from_the_spell_book_and_stays_the_same(self):
        first = self.client.get("/api/spells/mist_gate", auth=self.auth).json()
        self.assertEqual((first["word"], first["source"], first["opened"]), ("borrow", "spellbook", False))
        self.assertEqual(self.client.get("/api/spells/mist_gate", auth=self.auth).json()["word"], "borrow")

    def test_casting(self):
        self.client.get("/api/spells/mist_gate", auth=self.auth)
        body, check = self.cast("Open the gate now")
        self.assertFalse(body["success"])
        self.assertIn('"borrow"', body["hint"])
        check.assert_not_called()  # cheap checks first, no AI call
        self.assertFalse(self.cast("Borrow please")[0]["success"])  # too short

        body, check = self.cast("May I borrow you map please", accepted=False)
        self.assertFalse(body["success"])
        self.assertEqual(body["correction"], "Can I borrow your map, please?")
        self.assertEqual(check.call_args.args[0].target_word, "borrow")

        body, _ = self.cast("Can I borrow your map, please?")
        self.assertTrue(body["success"])
        state = self.client.get("/api/adventure/state", auth=self.auth).json()
        self.assertEqual(state["story_flags"]["opened_gates"], ["mist_gate"])
        with self.factory() as db:
            successes = db.query(WordEvent).filter_by(user_id=self.user_id, lemma="borrow", event_type="active_success").count()
        self.assertEqual(successes, 1)
        self.assertTrue(self.cast("anything at all")[0]["already_open"])

    def test_free_play_practice_counts_the_word_but_leaves_the_story_alone(self):
        self.client.get("/api/spells/mist_gate", auth=self.auth)
        body, _ = self.cast("Can I borrow your map, please?", practice=True)
        self.assertTrue(body["success"])
        self.assertTrue(body["practice"])
        state = self.client.get("/api/adventure/state", auth=self.auth).json()
        self.assertNotIn("mist_gate", (state.get("story_flags") or {}).get("opened_gates", []))
        with self.factory() as db:
            successes = db.query(WordEvent).filter_by(user_id=self.user_id, lemma="borrow", event_type="active_success").count()
        self.assertEqual(successes, 1)
        # The story can still open the gate (and finish its quest) later.
        body, _ = self.cast("Can I borrow your map, please?")
        self.assertTrue(body["success"])
        self.assertNotIn("already_open", body)

    def test_a_gate_opened_before_its_quest_counts_when_the_quest_comes_up(self):
        from services.adventure_quests import load_adventure
        quests = load_adventure().quests
        gate_stage = next(i for i, q in enumerate(quests) if getattr(q.complete_when, "gate_id", None) == "mist_gate")
        with self.factory() as db:
            db.get(User, self.user_id).adventure_stage = gate_stage - 1  # the quest before the gate
            db.commit()
        self.client.get("/api/spells/mist_gate", auth=self.auth)
        body, _ = self.cast("Can I borrow your map, please?")
        self.assertTrue(body["success"])
        self.assertFalse(body["quest_completed"])  # too early: the gate just opens
        state = self.client.get("/api/adventure/state", auth=self.auth).json()
        self.assertEqual(state["stage"], gate_stage - 1)
        # Now the earlier quest finishes: the gate quest is skipped because it is already done.
        with self.factory() as db:
            db.get(User, self.user_id).adventure_stage = gate_stage  # e.g. a save stuck on the gate quest
            db.commit()
        state = self.client.get("/api/adventure/state", auth=self.auth).json()
        self.assertEqual(state["stage"], gate_stage + 1)

    def test_unknown_gate(self):
        self.assertEqual(self.client.get("/api/spells/nope", auth=self.auth).status_code, 404)


if __name__ == "__main__":
    unittest.main()
