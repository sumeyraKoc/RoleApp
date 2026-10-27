import sys
import unittest
from pathlib import Path

AI_ROOT = Path(__file__).resolve().parents[1]
if str(AI_ROOT) not in sys.path:
    sys.path.insert(0, str(AI_ROOT))

from main import _Fallback


class Busy:
    def generate(self, *args):
        raise RuntimeError("503 UNAVAILABLE: high demand")


class Works:
    model = "groq"

    def generate(self, *args):
        return "Hey! Groq here."


class ProviderFallbackTest(unittest.TestCase):
    def test_a_failed_call_is_retried_on_the_secondary(self):
        generator = _Fallback(Busy(), Works(), "NPC reply")
        self.assertEqual(generator.generate("identity", []), "Hey! Groq here.")

    def test_a_working_primary_is_used_as_is(self):
        generator = _Fallback(Works(), Busy(), "NPC reply")
        self.assertEqual(generator.generate(), "Hey! Groq here.")
        self.assertEqual(generator.model, "groq")

    def test_both_failing_raises(self):
        with self.assertRaises(RuntimeError):
            _Fallback(Busy(), Busy(), "NPC reply").generate()


if __name__ == "__main__":
    unittest.main()
