import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import difficulty_bands
import indexer
import knowledge
import scoring
from fastapi.testclient import TestClient


class _LexStub:
    exam_taggable = set()

    def rank_band(self, _lemma):
        return 25000, 7

    def lemma_of(self, word):
        return word

    def is_known(self, _word):
        return True


class PersonalizedScoringTests(unittest.TestCase):
    def test_repetition_weights_diminish(self):
        self.assertEqual(scoring.effective_occurrences(0), 0.0)
        self.assertEqual(scoring.effective_occurrences(1), 1.0)
        self.assertEqual(scoring.effective_occurrences(2), 1.7)
        self.assertEqual(scoring.effective_occurrences(3), 2.2)
        self.assertEqual(scoring.effective_occurrences(10), 4.3)

    def test_probability_threshold_and_clamping(self):
        self.assertEqual(
            scoring.personalized_unknown_per_min(
                {"zero": 1, "half": 1, "one": 1},
                known_map={"zero": 0, "half": 0.5, "one": 1},
                duration_sec=60,
            ),
            1.0,
        )
        self.assertEqual(
            scoring.personalized_unknown_per_min(
                {"word": 1}, known_map={"word": 99}, duration_sec=60
            ),
            0.0,
        )

    def test_self_known_adds_half_probability(self):
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
        prior = knowledge.prior_p_known(20000, 3500)
        result = knowledge.apply_evidence(db, "rare", 20000, "self_known")
        self.assertAlmostEqual(result, prior + 0.5, places=6)
        db.close()

    def test_empty_zero_duration_and_unrecorded_word(self):
        self.assertEqual(scoring.personalized_unknown_per_min({}, duration_sec=0), 0.0)
        one_minute = scoring.personalized_unknown_per_min(
            {"word": 1}, known_map={"word": 0}, duration_sec=60
        )
        zero_duration = scoring.personalized_unknown_per_min(
            {"word": 1}, known_map={"word": 0}, duration_sec=0
        )
        self.assertEqual(zero_duration, one_minute)
        self.assertGreater(
            scoring.personalized_unknown_per_min(
                {"word": 1}, lex=_LexStub(), known_map={}, vocab_size=3500, duration_sec=60
            ),
            0.0,
        )

    def test_more_known_words_reduce_density(self):
        counts = {"word": 4}
        unknown = scoring.personalized_unknown_per_min(
            counts, known_map={"word": 0.0}, duration_sec=60
        )
        unsure = scoring.personalized_unknown_per_min(
            counts, known_map={"word": 0.4}, duration_sec=60
        )
        known = scoring.personalized_unknown_per_min(
            counts, known_map={"word": 0.9}, duration_sec=60
        )
        self.assertGreater(unknown, unsure)
        self.assertGreater(unknown, known)

    def test_profile_keeps_lemma_counts_and_last_end_fallback(self):
        profile = indexer.profile_video([(5000, 5000, "word word")], _LexStub())
        self.assertIsNotNone(profile)
        self.assertEqual(profile["lemma_counts"], {"word": 2})
        self.assertEqual(profile["duration_sec"], 5)

    @staticmethod
    def _batch_db(known_probability):
        db = sqlite3.connect(":memory:", check_same_thread=False)
        db.executescript(
            """
            CREATE TABLE user_profile (id INTEGER PRIMARY KEY, vocab_size INTEGER);
            CREATE TABLE word_knowledge (
                lemma TEXT PRIMARY KEY, logit REAL, p_known REAL, updated_at INTEGER
            );
            CREATE TABLE video_profile (
                video_id TEXT PRIMARY KEY, title TEXT, duration_sec INTEGER,
                total_tokens INTEGER, band_dist TEXT, rare_words TEXT,
                speech_rate REAL, proper_ratio REAL, indexed_at INTEGER,
                source TEXT, channel_id TEXT, lemma_counts TEXT
            );
            CREATE TABLE channel_profile (
                channel_id TEXT PRIMARY KEY, n_videos INTEGER,
                band_dist TEXT, speech_rate REAL
            );
            INSERT INTO user_profile VALUES (1, 3500);
            """,
        )
        db.execute("INSERT INTO word_knowledge VALUES ('known', 0, ?, 0)",
                   (known_probability,))
        band_dist = [1.0] + [0.0] * (difficulty_bands.BAND_COUNT - 1)
        db.execute(
            """INSERT INTO video_profile
               (video_id, title, duration_sec, total_tokens, band_dist,
                rare_words, speech_rate, proper_ratio, indexed_at, source,
                channel_id, lemma_counts)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            ("personalized", "Personalized", 60, 2, json.dumps(band_dist),
             "{}", 60.0, 0.0, 0, "test", "", json.dumps({"known": 1, "new": 1})),
        )
        db.execute(
            """INSERT INTO video_profile
               (video_id, title, duration_sec, total_tokens, band_dist,
                rare_words, speech_rate, proper_ratio, indexed_at, source,
                channel_id, lemma_counts)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            ("legacy", "Legacy", 60, 2, json.dumps(band_dist), "{}", 60.0,
             0.0, 0, "test", "", None),
        )
        db.commit()
        return db

    def test_batch_api_uses_personalized_and_legacy_paths(self):
        body = app.DifficultyBatchRequest(items=[
            {"id": "personalized"}, {"id": "legacy"}, {"id": "missing"}
        ])
        db = self._batch_db(0.9)
        with patch.object(app.knowledge, "open_db", return_value=db), \
             patch.object(app, "_lex", return_value=_LexStub()):
            result = app.get_difficulty_batch(body)["result"]
        self.assertTrue(result["personalized"]["personalized"])
        self.assertEqual(result["personalized"]["known_words_used"], 1)
        self.assertFalse(result["legacy"]["personalized"])
        self.assertEqual(result["missing"]["status"], "unassessed")

    def test_batch_http_api_serializes_personalized_fields(self):
        db = self._batch_db(0.9)
        with patch.object(app.knowledge, "open_db", return_value=db), \
             patch.object(app, "_lex", return_value=_LexStub()):
            response = TestClient(app.app).post(
                "/api/difficulty/batch", json={"items": [{"id": "personalized"}]}
            )
        self.assertEqual(response.status_code, 200)
        payload = response.json()["result"]["personalized"]
        self.assertTrue(payload["personalized"])
        self.assertIn("density_per_min", payload)

    def test_single_http_api_supports_personalized_and_legacy_profiles(self):
        db = self._batch_db(0.9)
        with patch.object(app.knowledge, "open_db", return_value=db), \
             patch.object(app, "_lex", return_value=_LexStub()):
            personalized = TestClient(app.app).get("/api/difficulty/personalized")
        self.assertEqual(personalized.status_code, 200)
        self.assertTrue(personalized.json()["personalized"])

        db = self._batch_db(0.9)
        with patch.object(app.knowledge, "open_db", return_value=db), \
             patch.object(app, "_lex", return_value=_LexStub()):
            legacy = TestClient(app.app).get("/api/difficulty/legacy")
        self.assertEqual(legacy.status_code, 200)
        self.assertFalse(legacy.json()["personalized"])

    def test_batch_personalized_density_drops_when_word_is_known(self):
        body = app.DifficultyBatchRequest(items=[{"id": "personalized"}])
        unknown_db = self._batch_db(0.0)
        with patch.object(app.knowledge, "open_db", return_value=unknown_db), \
             patch.object(app, "_lex", return_value=_LexStub()):
            unknown = app.get_difficulty_batch(body)["result"]["personalized"]["density_per_min"]
        known_db = self._batch_db(0.9)
        with patch.object(app.knowledge, "open_db", return_value=known_db), \
             patch.object(app, "_lex", return_value=_LexStub()):
            known = app.get_difficulty_batch(body)["result"]["personalized"]["density_per_min"]
        self.assertLess(known, unknown)

    def test_old_video_profile_gets_lemma_counts_column(self):
        with tempfile.TemporaryDirectory() as directory:
            old_path = knowledge.DIFFICULTY_DB
            knowledge.DIFFICULTY_DB = Path(directory) / "difficulty.db"
            try:
                db = sqlite3.connect(knowledge.DIFFICULTY_DB)
                db.execute(
                    """CREATE TABLE video_profile (
                        video_id TEXT PRIMARY KEY, title TEXT, duration_sec INTEGER,
                        total_tokens INTEGER, band_dist TEXT, rare_words TEXT,
                        speech_rate REAL, proper_ratio REAL, indexed_at INTEGER,
                        source TEXT, channel_id TEXT
                    )"""
                )
                db.commit()
                db.close()
                db = knowledge.open_db()
                columns = {row[1] for row in db.execute("PRAGMA table_info(video_profile)")}
                self.assertIn("lemma_counts", columns)
                db.close()
            finally:
                knowledge.DIFFICULTY_DB = old_path

    def test_single_http_api_handles_old_profile_without_lemma_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            old_path = knowledge.DIFFICULTY_DB
            knowledge.DIFFICULTY_DB = Path(directory) / "difficulty.db"
            try:
                db = sqlite3.connect(knowledge.DIFFICULTY_DB)
                db.execute(
                    """CREATE TABLE video_profile (
                        video_id TEXT PRIMARY KEY, title TEXT, duration_sec INTEGER,
                        total_tokens INTEGER, band_dist TEXT, rare_words TEXT,
                        speech_rate REAL, proper_ratio REAL, indexed_at INTEGER,
                        source TEXT, channel_id TEXT
                    )"""
                )
                band_dist = [1.0] + [0.0] * (difficulty_bands.BAND_COUNT - 1)
                db.execute(
                    "INSERT INTO video_profile VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    ("legacy", "Legacy", 60, 2, json.dumps(band_dist), "{}",
                     60.0, 0.0, 0, "test", ""),
                )
                db.commit()
                db.close()
                with patch.object(app, "_lex", return_value=_LexStub()):
                    response = TestClient(app.app).get("/api/difficulty/legacy")
                self.assertEqual(response.status_code, 200)
                self.assertFalse(response.json()["personalized"])
            finally:
                knowledge.DIFFICULTY_DB = old_path


if __name__ == "__main__":
    unittest.main()
