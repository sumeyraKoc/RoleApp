import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path

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
from models.models import User
from services import world_clock

T0 = datetime(2026, 10, 24, 12, 0, 0)


class ClockRulesTest(unittest.TestCase):
    def user(self, seconds=world_clock.START_SECONDS):
        return User(username="u", password_hash="x", game_seconds=seconds)

    def test_two_real_minutes_make_one_game_hour(self):
        u = self.user()
        self.assertEqual(world_clock.advance(u, T0).label, "Day 1 · 08:00")
        for i in range(1, 9):  # eight ticks, 15 s apart = 2 real minutes
            clock = world_clock.advance(u, T0 + timedelta(seconds=15 * i))
        self.assertEqual(clock.label, "Day 1 · 09:00")

    def test_closed_game_pauses_the_clock(self):
        u = self.user()
        world_clock.advance(u, T0)
        clock = world_clock.advance(u, T0 + timedelta(hours=3))
        self.assertEqual(clock.game_seconds, world_clock.START_SECONDS + world_clock.MAX_GAP_SECONDS * 30)

    def test_backwards_time_never_rewinds(self):
        u = self.user()
        world_clock.advance(u, T0)
        self.assertEqual(world_clock.advance(u, T0 - timedelta(seconds=40)).game_seconds, world_clock.START_SECONDS)

    def test_sleep_wakes_at_seven(self):
        evening = self.user(world_clock.DAY + 21 * 3600)  # Day 2, 21:00
        self.assertTrue(world_clock.can_sleep(evening.game_seconds))
        self.assertEqual(world_clock.sleep(evening, T0).label, "Day 3 · 07:00")
        night = self.user(2 * world_clock.DAY + 2 * 3600)  # Day 3, 02:00
        self.assertEqual(world_clock.sleep(night, T0).label, "Day 3 · 07:00")
        self.assertFalse(world_clock.can_sleep(world_clock.START_SECONDS))


class ClockRouteTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(bind=self.engine)
        with self.factory() as db:
            db.add(User(username="traveler", password_hash=hash_password("pw")))
            db.commit()

        def test_db():
            with self.factory() as db:
                yield db

        app.dependency_overrides[get_db] = test_db
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()
        self.engine.dispose()

    def test_tick_and_early_sleep(self):
        response = self.client.post("/api/world/clock/tick", auth=("traveler", "pw"))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["label"], "Day 1 · 08:00")
        response = self.client.post("/api/world/sleep", auth=("traveler", "pw"))
        self.assertEqual(response.status_code, 409)


if __name__ == "__main__":
    unittest.main()
