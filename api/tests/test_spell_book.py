import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from services.spell_book import (  # noqa: E402
    DailyExposure,
    WordEventData,
    build_spell_book,
    find_used_words,
    select_focus_words,
    status_for,
    struggle_score,
)

NOW = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)


def ev(lemma, event_type, days_ago=0.0, **kwargs):
    return WordEventData(lemma=lemma, event_type=event_type, created_at=NOW - timedelta(days=days_ago), **kwargs)


class StruggleScoreTests(unittest.TestCase):
    def test_spec_example_is_yellow_then_red(self):
        # roleApp 4.2: meaning_fail + pronunciation_fail today -> 45 (yellow)
        events = [ev("abundant", "meaning_fail"), ev("abundant", "pronunciation_fail")]
        self.assertEqual(struggle_score(events, NOW), 45.0)
        # one day later another meaning_fail -> ~68 (red)
        later = NOW + timedelta(days=1)
        events.append(WordEventData("abundant", "meaning_fail", later))
        score = struggle_score(events, later)
        self.assertAlmostEqual(score, 45 * 2 ** (-1 / 14) + 25, delta=0.1)
        self.assertEqual(status_for(score, 0), "red")

    def test_half_life_is_fourteen_days(self):
        self.assertEqual(struggle_score([ev("bread", "meaning_fail", days_ago=14)], NOW), 12.5)

    def test_score_is_clamped(self):
        self.assertEqual(struggle_score([ev("x", "meaning_fail")] * 10, NOW), 100.0)
        self.assertEqual(struggle_score([ev("x", "active_success")] * 3, NOW), 0.0)

    def test_unknown_event_types_are_ignored(self):
        self.assertEqual(struggle_score([ev("x", "something_else")], NOW), 0.0)


class StatusTests(unittest.TestCase):
    def test_thresholds(self):
        self.assertEqual(status_for(60, 0), "red")
        self.assertEqual(status_for(30, 5), "yellow")
        self.assertEqual(status_for(10, 2), "green")
        self.assertEqual(status_for(10, 1), "new")
        self.assertEqual(status_for(0, 0), "new")


class BuildSpellBookTests(unittest.TestCase):
    def test_groups_by_normalized_lemma_and_sorts_hardest_first(self):
        events = [
            ev("Croissant ", "meaning_fail", location="bakery"),
            ev("croissant", "meaning_fail", location="bakery"),
            ev("croissant", "usage_fail", location="cafe", example="I want croissant."),
            ev("plant", "active_success", location="bakery"),
            ev("plant", "active_success", location="bakery"),
            ev("shelf", "usage_fail", days_ago=1),
        ]
        book = build_spell_book(events, NOW)
        self.assertEqual([e["lemma"] for e in book], ["croissant", "shelf", "plant"])
        croissant = book[0]
        self.assertEqual(croissant["status"], "red")
        self.assertEqual(croissant["meaning_fails"], 2)
        self.assertEqual(croissant["usage_fails"], 1)
        self.assertEqual(croissant["sources"], ["bakery", "cafe"])
        self.assertEqual(croissant["example"], "I want croissant.")
        self.assertEqual(book[2]["status"], "green")

    def test_empty(self):
        self.assertEqual(build_spell_book([], NOW), [])


def entry(lemma, status, score, sources=()):
    return {"lemma": lemma, "status": status, "struggle_score": score, "sources": list(sources)}


class FocusWordTests(unittest.TestCase):
    def test_picks_red_before_yellow_and_at_most_two(self):
        book = [
            entry("bookshelf", "yellow", 50),
            entry("croissant", "red", 61),
            entry("receipt", "red", 90),
            entry("plant", "green", 0),
            entry("latte", "new", 0),
        ]
        self.assertEqual(select_focus_words(book, "bakery"), ["receipt", "croissant"])

    def test_prefers_words_met_at_the_same_place(self):
        book = [entry("receipt", "red", 70), entry("croissant", "red", 61, sources=["bakery"])]
        self.assertEqual(select_focus_words(book, "bakery", limit=1), ["croissant"])

    def test_daily_quota(self):
        book = [entry("croissant", "red", 80), entry("receipt", "red", 70)]
        exposure = {
            "croissant": DailyExposure(count=3, locations=frozenset({"bakery"})),
            "receipt": DailyExposure(count=2, locations=frozenset({"cafe", "library"})),
        }
        # croissant: 3 times already; receipt: already used by two other places
        self.assertEqual(select_focus_words(book, "bakery", exposure), [])
        # the same place may keep using receipt until the daily count is reached
        self.assertEqual(select_focus_words(book, "cafe", exposure), ["receipt"])

    def test_find_used_words(self):
        text = "Here are two fresh Croissants! Do you need a receipt?"
        self.assertEqual(find_used_words(text, ["croissant", "receipt", "bake"]), ["croissant", "receipt"])
        self.assertEqual(find_used_words("A bakery is open.", ["bake"]), [])


if __name__ == "__main__":
    unittest.main()
