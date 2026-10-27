import sys
import unittest
from pathlib import Path

AI_ROOT = Path(__file__).resolve().parents[1]
if str(AI_ROOT) not in sys.path:
    sys.path.insert(0, str(AI_ROOT))

from modules.npc import _npc_system_instruction
from shared.schemas import NPCIdentity


def identity(**extra):
    return NPCIdentity(id="bakery_baker", name="Maya", role="baker", user_role="player",
                       location="bakery", personality="Warm", **extra)


class NpcMemoryPromptTest(unittest.TestCase):
    def test_memories_and_tier_reach_the_prompt_once(self):
        prompt = _npc_system_instruction(identity(
            memories=["(witnessed) You gave the player 2 × Bread.", "(heard) Lina mentioned a quest."],
            relationship_tier="friendly",
        ))
        self.assertIn("Your relationship with the player: friendly.", prompt)
        self.assertIn("- (witnessed) You gave the player 2 × Bread.", prompt)
        self.assertIn("I heard...", prompt)
        self.assertEqual(prompt.count("You gave the player 2 × Bread."), 1)  # not repeated in the JSON block

    def test_no_memory_section_without_memories(self):
        prompt = _npc_system_instruction(identity())
        self.assertNotIn("What you remember", prompt)
        self.assertNotIn("Your relationship", prompt)


if __name__ == "__main__":
    unittest.main()
