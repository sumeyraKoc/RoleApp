import json
import sys
import tempfile
import unittest
from pathlib import Path

from pydantic import ValidationError

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from services.adventure_quests import (
    SCENARIOS_DIR,
    load_cutscene,
    tier_for_stage,
    completes_inventory_quest,
    completes_talk_quest,
    load_adventure,
)
from services.npc_memory import npc_by_id
from services.plans import load_plans


class AdventureContentFileTest(unittest.TestCase):
    """api/game_data/adventure.json is the single quest source; keep it valid."""

    def test_content_loads_and_rules_point_at_real_content(self):
        content = load_adventure()
        self.assertGreater(len(content.quests), 0)
        places = {p.place_id for p in load_plans().places}
        for quest in content.quests:
            rule = quest.complete_when
            if hasattr(rule, "location"):
                scenario = Path(SCENARIOS_DIR) / f"{rule.location}.json"
                self.assertTrue(scenario.exists(), f"{quest.id}: no scenario for {rule.location}")
                self.assertEqual(json.loads(scenario.read_text(encoding="utf-8"))["npc_role"], rule.npc_role, quest.id)
            for scene_id in [getattr(rule, "scene_id", None)]:
                if scene_id:
                    self.assertIsNotNone(load_cutscene(scene_id), f"{quest.id}: no cutscene {scene_id}")
            if hasattr(rule, "place_id"):
                self.assertIn(rule.place_id, places, quest.id)
            if hasattr(rule, "npc_id"):
                self.assertIsNotNone(npc_by_id(rule.npc_id), quest.id)
            for text in quest.on_complete.phone:
                self.assertIsNotNone(npc_by_id(text.npc_id), quest.id)

    def test_tier_one_keeps_its_three_quests_first(self):
        # Existing players' adventure_stage values (0–3) must keep their meaning.
        self.assertEqual([q.id for q in load_adventure().quests[:3]],
                         ["maya_provisions", "lina_boat_manual", "leo_last_stop"])
        self.assertEqual(tier_for_stage(0).tier, 1)
        self.assertEqual(tier_for_stage(3).tier, 2)
        self.assertEqual(tier_for_stage(99).tier, len(load_adventure().tiers))

    def test_invalid_content_is_rejected(self):
        broken = {
            "items": [],
            "tiers": [{
                "tier": 1, "cefr": "A1",
                "chapter": {"id": "x", "label": "x", "title": "x", "intro": "x", "complete_title": "x", "complete_text": "x"},
                "quests": [{
                    "id": "q", "title": "q", "place": "q", "detail": "q",
                    "complete_when": {"type": "receive_item", "location": "bakery", "npc_role": "baker", "item_id": "missing_item"},
                }],
            }],
        }
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as handle:
            json.dump(broken, handle)
        with self.assertRaises(ValidationError):
            load_adventure.__wrapped__(handle.name)
        Path(handle.name).unlink()


class QuestRuleTest(unittest.TestCase):
    def test_rules_follow_the_content_order(self):
        self.assertTrue(completes_inventory_quest(0, "bakery", "baker", "apple", 1, "food"))
        self.assertFalse(completes_inventory_quest(0, "bakery", "baker", "map", 1, "other"))
        self.assertFalse(completes_inventory_quest(0, "bakery", "baker", "bread", -1, "food"))
        self.assertTrue(completes_inventory_quest(1, "library", "librarian", "boat_building_manual", 1, "other"))
        self.assertFalse(completes_inventory_quest(1, "bakery", "baker", "boat_building_manual", 1, "other"))
        self.assertFalse(completes_talk_quest(1, "cafe", "barista"))
        self.assertTrue(completes_talk_quest(2, "cafe", "barista"))
        self.assertFalse(completes_talk_quest(2, "library", "librarian"))

    def test_finished_chapter_completes_nothing(self):
        done = len(load_adventure().quests)
        self.assertFalse(completes_talk_quest(done, "cafe", "barista"))
        self.assertFalse(completes_inventory_quest(done, "bakery", "baker", "bread", 1, "food"))


if __name__ == "__main__":
    unittest.main()
