import sys
import unittest
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from core.database import Base
from models.models import Dialogue, InventoryEvent, InventoryItem, User
from services.adventure_inventory import apply_inventory_transfers, inventory_snapshot
from shared.schemas import InventoryTransfer


def transfer(item_id: str, name: str, delta: int, category: str = "other") -> InventoryTransfer:
    return InventoryTransfer(item_id=item_id, name=name, delta=delta, category=category)


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        Base.metadata.create_all(self.engine)
        self.session_factory = sessionmaker(bind=self.engine)

    def tearDown(self):
        self.engine.dispose()

    def test_multiple_quantities_dynamic_items_and_removal(self):
        with self.session_factory() as db:
            user = User(username="traveler", password_hash="test", adventure_stage=0)
            first = Dialogue(session_id=None, speaker="npc", text="Two loaves and three apples for you")
            db.add_all([user, first])
            db.flush()
            grants = [transfer("bread", "Bread", 2, "food"), transfer("apple", "Apple", 3, "food")]
            changes = apply_inventory_transfers(db, user, first, grants, location="bakery", npc_role="baker")
            self.assertEqual({change["item_id"]: change["quantity"] for change in changes}, {"bread": 2, "apple": 3})
            self.assertEqual(user.adventure_stage, 1)
            self.assertEqual(apply_inventory_transfers(db, user, first, grants, location="bakery", npc_role="baker"), [])
            second = Dialogue(session_id=None, speaker="npc", text="I took one loaf and two apples")
            db.add(second)
            db.flush()
            removed = apply_inventory_transfers(db, user, second, [
                transfer("bread", "Bread", -1, "food"), transfer("apple", "Apple", -2, "food")
            ], location="library", npc_role="librarian")
            self.assertEqual([change["quantity"] for change in removed], [-1, -2])
            self.assertEqual({x["item_id"]: x["quantity"] for x in inventory_snapshot(db, user.id)}, {"bread": 1, "apple": 1})
            db.commit()
            user_id = user.id
        with self.session_factory() as db:
            self.assertEqual(db.get(User, user_id).adventure_stage, 1)
            self.assertEqual(len(db.query(InventoryEvent).all()), 4)
            self.assertEqual({x["item_id"]: x["quantity"] for x in inventory_snapshot(db, user_id)}, {"bread": 1, "apple": 1})

    def test_no_overdraw_and_nonfood_does_not_complete_maya_quest(self):
        with self.session_factory() as db:
            user = User(username="traveler", password_hash="test", adventure_stage=0)
            dialogue = Dialogue(session_id=None, speaker="npc", text="Here is a map")
            db.add_all([user, dialogue])
            db.flush()
            result = apply_inventory_transfers(db, user, dialogue, [
                transfer("map", "Map", 1), transfer("bread", "Bread", -2, "food")
            ], location="bakery", npc_role="baker")
            self.assertEqual(result, [{"item_id": "map", "name": "Map", "quantity": 1}])
            self.assertEqual(user.adventure_stage, 0)
            self.assertEqual(db.query(InventoryItem).count(), 1)

    def test_lina_requires_actual_manual_in_inventory(self):
        with self.session_factory() as db:
            user = User(username="reader", password_hash="test", adventure_stage=1)
            dialogue = Dialogue(session_id=None, speaker="npc", text="Here is a map")
            db.add_all([user, dialogue])
            db.flush()
            apply_inventory_transfers(db, user, dialogue, [
                transfer("map", "Map", 1),
            ], location="library", npc_role="librarian")
            self.assertEqual(user.adventure_stage, 1)
            manual_dialogue = Dialogue(session_id=None, speaker="npc", text="Here is your boat-building manual")
            db.add(manual_dialogue)
            db.flush()
            changes = apply_inventory_transfers(db, user, manual_dialogue, [
                transfer("boat_building_manual", "Boat guide", 1),
            ], location="library", npc_role="librarian")
            self.assertEqual(changes[0]["item_id"], "boat_building_manual")
            self.assertEqual(changes[0]["name"], "Boat-Building Handbook")
            self.assertEqual(user.adventure_stage, 2)

    def test_manual_from_other_npc_does_not_complete_lina_quest(self):
        with self.session_factory() as db:
            user = User(username="reader", password_hash="test", adventure_stage=1)
            dialogue = Dialogue(session_id=None, speaker="npc", text="Here is a manual")
            db.add_all([user, dialogue])
            db.flush()
            apply_inventory_transfers(db, user, dialogue, [
                transfer("boat_building_manual", "Boat-Building Handbook", 1),
            ], location="bakery", npc_role="baker")
            self.assertEqual(user.adventure_stage, 1)

    def test_saved_legacy_name_is_displayed_in_english(self):
        with self.session_factory() as db:
            user = User(username="reader", password_hash="test", adventure_stage=0)
            db.add(user)
            db.flush()
            db.add(InventoryItem(user_id=user.id, item_id="water_bottle", name="Su şişesi", quantity=2))
            db.flush()
            self.assertEqual(inventory_snapshot(db, user.id), [
                {"item_id": "water_bottle", "name": "Water Bottle", "quantity": 2},
            ])


if __name__ == "__main__":
    unittest.main()
