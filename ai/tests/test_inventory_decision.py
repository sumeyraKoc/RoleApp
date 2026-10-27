import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

AI_ROOT = Path(__file__).resolve().parents[1]
if str(AI_ROOT) not in sys.path:
    sys.path.insert(0, str(AI_ROOT))

from modules.inventory_decision import decide_inventory_transfers
from shared.schemas import InventoryDecisionRequest, InventoryEntry


class InventoryDecisionTest(unittest.TestCase):
    def test_groq_receives_full_inventory_and_parses_multiple_signed_quantities(self):
        payload = InventoryDecisionRequest(
            location="bakery", npc_role="baker", player_text="Two loaves and three apples, please.",
            npc_reply="Here are two loaves and three apples; I took your map.",
            inventory=[InventoryEntry(item_id="map", name="Map", quantity=1)],
        )
        captured = {}

        class Client:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

        def fake_call(client, **kwargs):
            captured.update(kwargs)
            return json.dumps({"transfers": [
                {"item_id": "bread", "name": "Bread", "delta": 2, "category": "food"},
                {"item_id": "apple", "name": "Apple", "delta": 3, "category": "food"},
                {"item_id": "map", "name": "Map", "delta": -1, "category": "other"},
            ]})

        with patch("modules.inventory_decision.build_groq_client", return_value=Client()), patch(
            "modules.inventory_decision.groq_chat_json", side_effect=fake_call
        ), patch.dict("os.environ", {"GROQ_API_KEY": "test"}):
            result = decide_inventory_transfers(payload)
        self.assertEqual([item.delta for item in result.transfers], [2, 3, -1])
        self.assertEqual(json.loads(captured["user_content"])["inventory"][0]["quantity"], 1)

    def test_bad_model_response_is_rejected(self):
        payload = InventoryDecisionRequest(location="bakery", npc_role="baker", player_text="Hi", npc_reply="Hi")

        class Client:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

        with patch("modules.inventory_decision.build_groq_client", return_value=Client()), patch(
            "modules.inventory_decision.groq_chat_json", return_value='{"transfers":[{"item_id":"bread","name":"Bread","delta":500,"category":"food"}]}'
        ), patch.dict("os.environ", {"GROQ_API_KEY": "test"}):
            with self.assertRaises(ValueError):
                decide_inventory_transfers(payload)


if __name__ == "__main__":
    unittest.main()
