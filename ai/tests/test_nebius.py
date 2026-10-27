import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

AI_ROOT = Path(__file__).resolve().parents[1]
if str(AI_ROOT) not in sys.path:
    sys.path.insert(0, str(AI_ROOT))

from modules.nebius_client import NebiusTextGenerator, clean_reply, pick_nemotron
from shared.schemas import DialogueTurn, NPCIdentity


class NemotronTest(unittest.TestCase):
    def test_picks_a_nemotron_chat_model_from_the_catalog(self):
        catalog = ["meta-llama/Llama-3.3-70B-Instruct", "nvidia/Nemotron-Embed-1B",
                   "nvidia/Nemotron-3-Nano", "nvidia/Nemotron-3-Super"]
        self.assertEqual(pick_nemotron(catalog), "nvidia/Nemotron-3-Super")
        self.assertEqual(pick_nemotron(["x/other", "nvidia/nemotron-3-nano-omni"]), "nvidia/nemotron-3-nano-omni")
        with self.assertRaises(RuntimeError):
            pick_nemotron(["meta-llama/Llama-3.3-70B-Instruct"])

    def test_thinking_is_hidden_from_players(self):
        self.assertEqual(clean_reply("<think>The player is happy.</think>\nNo way! Hi!"), "No way! Hi!")

    def test_generator_sends_an_openai_style_chat_request(self):
        generator = NebiusTextGenerator(api_key="test", model="nvidia/Nemotron-3-Super")
        response = MagicMock()
        response.json.return_value = {"choices": [{"message": {"content": "Hey! Café at six?"}}]}
        with patch.object(generator._client, "post", return_value=response) as post:
            identity = NPCIdentity(id="town_friend", name="Sam", role="friend", user_role="player",
                                   location="town", personality="Energetic")
            reply = generator.generate(identity, [DialogueTurn(speaker="user", text="Hi Sam!")])
        self.assertEqual(reply, "Hey! Café at six?")
        body = post.call_args.kwargs["json"]
        self.assertEqual(body["model"], "nvidia/Nemotron-3-Super")
        self.assertEqual(body["messages"][-1], {"role": "user", "content": "Hi Sam!"})


if __name__ == "__main__":
    unittest.main()
