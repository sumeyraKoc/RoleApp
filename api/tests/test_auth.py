import unittest
import sys
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from core.database import Base, get_db
from main import app
from models.models import GameSession, User
from core.security import hash_password


class AuthorizationTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        Base.metadata.create_all(self.engine)
        self.session_factory = sessionmaker(bind=self.engine)
        with self.session_factory() as db:
            alice = User(username="alice", password_hash=hash_password("alice-pass"), coins=5, xp=7)
            bob = User(username="bob", password_hash=hash_password("bob-pass"), coins=9, xp=11)
            db.add_all([alice, bob])
            db.flush()
            self.alice_id = alice.id
            self.bob_id = bob.id
            game_session = GameSession(user_id=alice.id, location="bakery", npc_role="baker")
            db.add(game_session)
            db.commit()
            self.game_session_id = game_session.id

        def test_db():
            with self.session_factory() as db:
                yield db

        app.dependency_overrides[get_db] = test_db
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()
        self.engine.dispose()

    def test_profile_requires_correct_owner(self):
        url = f"/api/user/{self.alice_id}"
        self.assertEqual(self.client.get(url).status_code, 401)
        self.assertEqual(self.client.get(url, auth=("alice", "wrong")).status_code, 401)
        self.assertEqual(self.client.get(url, auth=("bob", "bob-pass")).status_code, 403)
        response = self.client.get(url, auth=("alice", "alice-pass"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["coins"], 5)

    def test_progress_and_rewards_reject_other_player(self):
        spell_url = f"/api/spellbook/{self.alice_id}"
        vocab_url = f"/api/vocabulary/progress/{self.alice_id}/bakery"
        for url in (spell_url, vocab_url):
            self.assertEqual(self.client.get(url).status_code, 401)
            self.assertEqual(self.client.get(url, auth=("bob", "bob-pass")).status_code, 403)
        response = self.client.post(
            "/api/vocabulary/submit",
            json={"user_id": self.alice_id, "location": "bakery", "concept": "cake", "word": "cake"},
            auth=("bob", "bob-pass"),
        )
        self.assertEqual(response.status_code, 403)
        with self.session_factory() as db:
            self.assertEqual(db.get(User, self.alice_id).coins, 5)

    def test_turn_rejects_unauthorized_request_before_ai_call(self):
        url = f"/api/session/{self.game_session_id}/turn"
        for auth, expected in ((None, 401), (("bob", "bob-pass"), 403)):
            response = self.client.post(url, json={"user_text": "Hello"}, auth=auth)
            self.assertEqual(response.status_code, expected)

    def test_speech_requires_login(self):
        self.assertEqual(self.client.post("/api/speech/stt").status_code, 401)
        self.assertEqual(self.client.post("/api/speech/tts").status_code, 401)


if __name__ == "__main__":
    unittest.main()
