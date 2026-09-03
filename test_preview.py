import sqlite3
import unittest

import preview


class _LexStub:
    exam_taggable = set()

    def lemma_of(self, word):
        return word

    def rank_band(self, _lemma):
        return 25000, 7

    def is_known(self, _word):
        return False


def _db(known_map):
    db = sqlite3.connect(":memory:")
    db.executescript(
        """
        CREATE TABLE user_profile (id INTEGER PRIMARY KEY, vocab_size INTEGER);
        CREATE TABLE word_knowledge (
            lemma TEXT PRIMARY KEY, logit REAL, p_known REAL, updated_at INTEGER
        );
        INSERT INTO user_profile VALUES (1, 3500);
        """
    )
    db.executemany(
        "INSERT INTO word_knowledge VALUES (?, 0, ?, 0)",
        [(lemma, probability) for lemma, probability in known_map.items()],
    )
    return db


class PreviewTests(unittest.TestCase):
    def test_adaptive_card_count_bounds(self):
        self.assertEqual(preview.adaptive_card_count(0), 0)
        self.assertEqual(preview.adaptive_card_count(1), 3)
        self.assertEqual(preview.adaptive_card_count(14), 6)
        self.assertEqual(preview.adaptive_card_count(143), 12)
        self.assertEqual(preview.adaptive_card_count(858), 12)
        self.assertEqual(preview.adaptive_card_count(10**12), 12)

    def test_score_floor_filters_low_quality_candidates(self):
        db = _db({"solid": 0.4, "junk": 0.0})
        try:
            cards, total = preview.preview_words(
                [(0, 1000, "solid"), (300000, 900000, "junk")],
                db,
                _LexStub(),
                set(),
                top_n=preview.adaptive_card_count,
            )
        finally:
            db.close()
        self.assertEqual(total, 1)
        self.assertEqual([card["lemma"] for card in cards], ["solid"])
        self.assertGreaterEqual(cards[0]["score"], preview.MIN_PREVIEW_SCORE)

    def test_occurrence_component_is_logarithmic_and_uncapped_at_five(self):
        cues = [(0, 1000, "five five five five five")]
        cues.append((1000, 2000, "twenty " * 20))
        db = _db({"five": 0.4, "twenty": 0.4})
        try:
            cards, _total = preview.preview_words(
                cues, db, _LexStub(), set(), top_n=10
            )
        finally:
            db.close()
        by_lemma = {card["lemma"]: card for card in cards}
        self.assertGreater(
            by_lemma["twenty"]["score_breakdown"]["occurrence"],
            by_lemma["five"]["score_breakdown"]["occurrence"],
        )
        self.assertAlmostEqual(
            by_lemma["twenty"]["score_breakdown"]["occurrence"], 3.0
        )

    def test_early_bonus_scales_with_video_length(self):
        lex = _LexStub()
        db = _db({"word": 0.4})
        try:
            short_cards, _ = preview.preview_words(
                [(60000, 60100, "word"), (599000, 600000, "tail")],
                db,
                lex,
                set(),
                top_n=10,
            )
            long_cards, _ = preview.preview_words(
                [(360000, 360100, "word"), (3599000, 3600000, "tail")],
                db,
                lex,
                set(),
                top_n=10,
            )
        finally:
            db.close()
        short_word = next(card for card in short_cards if card["lemma"] == "word")
        long_word = next(card for card in long_cards if card["lemma"] == "word")
        self.assertAlmostEqual(
            short_word["score_breakdown"]["early"],
            long_word["score_breakdown"]["early"],
            places=6,
        )


if __name__ == "__main__":
    unittest.main()
