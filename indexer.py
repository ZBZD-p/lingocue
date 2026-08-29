#!/usr/bin/env python3
"""
Profiles cached YouTube subtitles into a per-video difficulty fingerprint.

Reads word_rank/forms/entries from dictionary.db (built by build_dict.py) and
whatever .en.srt files already sit in the YouTube subtitle cache -- no
network requests, no yt-dlp, nothing that could touch the rate-limit cooldown
youtube.py already guards. Writes one row per video into difficulty.db's
video_profile table.

Run once to backfill, then again any time new videos have been cached:
    python indexer.py
"""

import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

import app_config
import difficulty_bands
import subs_now

ROOT = Path(__file__).resolve().parent
DICT_DB = ROOT / "dictionary.db"
DIFFICULTY_DB = ROOT / "difficulty.db"

# A sentence is whatever sits between one of these and the next -- cues are
# usually already one sentence each (youtube.py resegments auto captions),
# but concatenating full video text and re-splitting here means a sentence
# that got cut across two cues still gets exactly one "sentence-initial"
# token instead of two.
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
WORD_RE = re.compile(r"[A-Za-z']+")

# Capitalized but not a proper noun regardless of position -- the one
# extremely common word that's always a single capital letter.
NOT_PROPER = {"i"}


def _tokenize(text: str):
    """(lower, is_capitalized, is_sentence_initial) for every word in text."""
    tokens = []
    for sentence in SENTENCE_SPLIT_RE.split(text):
        words = WORD_RE.findall(sentence)
        for i, w in enumerate(words):
            tokens.append((w.lower(), w[:1].isupper(), i == 0))
    return tokens


class LemmaRanks:
    """In-memory view of dictionary.db's forms/word_rank tables -- profiling
    hundreds of videos means resolving hundreds of thousands of tokens, and a
    SQLite round trip per token would dominate runtime for no reason: both
    tables together are a few MB, small enough to just hold in RAM."""

    def __init__(self, db_path: Path):
        db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            self.known_words = {row[0] for row in db.execute("SELECT word FROM entries")}
            self.forms = dict(db.execute("SELECT form, lemma FROM forms"))
            self.rank = {lemma: (rank, band) for lemma, rank, band
                         in db.execute("SELECT lemma, rank, band FROM word_rank")}
        finally:
            db.close()

    def lemma_of(self, word_lower: str) -> str:
        if word_lower in self.rank or word_lower in self.known_words:
            return word_lower
        return self.forms.get(word_lower, word_lower)

    def rank_band(self, lemma: str) -> tuple[int, int]:
        hit = self.rank.get(lemma)
        if hit:
            return hit
        return difficulty_bands.UNRANKED_RANK, difficulty_bands.band_of(difficulty_bands.UNRANKED_RANK)

    def is_known(self, word_lower: str) -> bool:
        return word_lower in self.known_words or word_lower in self.forms


def profile_video(cues: list[tuple[int, int, str]], lex: LemmaRanks) -> dict | None:
    text = " ".join(c[2] for c in cues)
    tokens = _tokenize(text)
    if not tokens:
        return None

    band_counts = [0] * difficulty_bands.BAND_COUNT
    rare = Counter()
    proper_count = 0
    counted = 0

    for lower, is_cap, is_initial in tokens:
        if is_cap and not is_initial and lower not in NOT_PROPER and not lex.is_known(lower):
            proper_count += 1
            continue
        lemma = lex.lemma_of(lower)
        _rank, band = lex.rank_band(lemma)
        band_counts[band] += 1
        counted += 1
        if band >= 6:
            rare[lemma] += 1

    if counted == 0:
        return None

    start_ms = min(c[0] for c in cues)
    end_ms = max(c[1] for c in cues)
    duration_sec = max(1.0, (end_ms - start_ms) / 1000)

    return {
        "total_tokens": counted,
        "band_dist": [n / counted for n in band_counts],
        "rare_words": dict(rare.most_common(200)),
        "speech_rate": counted / (duration_sec / 60),
        "proper_ratio": proper_count / len(tokens),
        "duration_sec": int(duration_sec),
    }


def _open_difficulty_db() -> sqlite3.Connection:
    db = sqlite3.connect(DIFFICULTY_DB)
    db.executescript("""
        CREATE TABLE IF NOT EXISTS video_profile (
            video_id      TEXT PRIMARY KEY,
            title         TEXT,
            duration_sec  INTEGER,
            total_tokens  INTEGER,
            band_dist     TEXT,
            rare_words    TEXT,
            speech_rate   REAL,
            proper_ratio  REAL,
            indexed_at    INTEGER,
            source        TEXT
        );
    """)
    return db


def _video_id_from_marker(marker: Path) -> tuple[str, str] | None:
    try:
        meta = json.loads(marker.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    video_id = meta.get("id")
    if not video_id:
        return None
    return video_id, meta.get("title") or ""


def backfill(cache_dir: Path, lex: LemmaRanks, db: sqlite3.Connection, verbose: bool = True) -> int:
    import time

    indexed = skipped = 0
    for marker in sorted(cache_dir.glob("*.tutor.json")):
        parsed = _video_id_from_marker(marker)
        if not parsed:
            continue
        video_id, title = parsed

        base_name = marker.name[: -len(".tutor.json")]
        srt = marker.with_name(f"{base_name}.en.srt")
        if not srt.exists():
            skipped += 1
            continue

        cues = subs_now.parse_srt_cues(srt)
        if not cues:
            skipped += 1
            continue

        profile = profile_video(cues, lex)
        if profile is None:
            skipped += 1
            continue

        db.execute(
            """INSERT OR REPLACE INTO video_profile
               (video_id, title, duration_sec, total_tokens, band_dist,
                rare_words, speech_rate, proper_ratio, indexed_at, source)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (video_id, title, profile["duration_sec"], profile["total_tokens"],
             json.dumps(profile["band_dist"]), json.dumps(profile["rare_words"]),
             profile["speech_rate"], profile["proper_ratio"], int(time.time()), "cache"),
        )
        indexed += 1
        if verbose and indexed % 50 == 0:
            print(f"  已索引 {indexed} 个视频...")

    db.commit()
    if verbose:
        print(f"索引完成：{indexed} 个视频，跳过 {skipped} 个（没有英文字幕或字幕为空）")
    return indexed


def main():
    if not DICT_DB.exists():
        print("dictionary.db 不存在，先运行 python build_dict.py")
        sys.exit(1)

    lex = LemmaRanks(DICT_DB)
    db = _open_difficulty_db()
    try:
        backfill(app_config.youtube_cache_dir(), lex, db)
    finally:
        db.close()


if __name__ == "__main__":
    main()
