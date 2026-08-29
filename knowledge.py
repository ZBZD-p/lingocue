#!/usr/bin/env python3
"""
Known-word model for the difficulty engine.

Estimates, per lemma, how likely the user is to know that word (p_known).
With no behavioral evidence at all -- a brand-new install -- the estimate
comes entirely from word frequency and an assumed vocabulary size V (see
prior_p_known). vocab_size starts at a bootstrap default and gets replaced
by a real fitted value once the vocabulary-size test exists; nothing here
depends on that test having run.

Values are stored in log-odds (logit) space rather than probability space,
because evidence needs to *add*: "graduated from review, then looked up
again later" is naturally additive in logit space, but the same addition in
probability space would push a value past 1.0 or below 0.0 for small,
everyday inputs.

Run standalone to backfill word_knowledge from the existing vocab book:
    python knowledge.py
"""

import json
import math
import re
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIFFICULTY_DB = ROOT / "difficulty.db"
VOCAB_FILE = ROOT / "vocab.json"

# Mirrors app.py's MASTERED_STREAK. Duplicated rather than imported: app.py
# has FastAPI route registration and startup side effects (write_mcp_config)
# that make it the wrong thing to import from a standalone script, and this
# constant essentially never changes.
MASTERED_STREAK = 6

DEFAULT_VOCAB_SIZE = 6000  # roughly CET-6, a reasonable bootstrap guess

DELTA = {
    "srs_graduated": 2.5,   # a word's review streak hit MASTERED_STREAK
    "srs_pass": 0.6,        # one successful review, not yet mastered
    "collected": -2.0,      # saved into the vocab book -- explicit "don't know"
}
LOGIT_CLAMP = 4.0

# The vocab book's "question" field is a single hover-saved word; anything
# that isn't exactly one word (a stray phrase someone typed in) carries no
# clean lemma and is skipped rather than guessed at.
_WORD_RE = re.compile(r"[A-Za-z']+")


def prior_p_known(rank: int, vocab_size: int, spread: float = 0.35) -> float:
    """vocab_size = estimated vocabulary size. Sigmoid in log-space: word
    frequency is Zipf-distributed, so rank 100 vs 200 matters far more than
    rank 5000 vs 5100 -- a linear difference in rank carries no consistent
    meaning."""
    if rank <= 0:
        return 0.15
    return 1.0 / (1.0 + math.exp((math.log(rank) - math.log(vocab_size)) / spread))


def _logit(p: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def open_db() -> sqlite3.Connection:
    db = sqlite3.connect(DIFFICULTY_DB)
    db.executescript("""
        CREATE TABLE IF NOT EXISTS word_knowledge (
            lemma      TEXT PRIMARY KEY,
            logit      REAL NOT NULL,
            p_known    REAL NOT NULL,
            updated_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS user_profile (
            id         INTEGER PRIMARY KEY CHECK (id = 1),
            vocab_size INTEGER NOT NULL
        );
    """)
    db.execute("INSERT OR IGNORE INTO user_profile (id, vocab_size) VALUES (1, ?)",
               (DEFAULT_VOCAB_SIZE,))
    db.commit()
    return db


def vocab_size(db: sqlite3.Connection) -> int:
    row = db.execute("SELECT vocab_size FROM user_profile WHERE id = 1").fetchone()
    return row[0] if row else DEFAULT_VOCAB_SIZE


def set_vocab_size(db: sqlite3.Connection, v: int) -> None:
    db.execute("UPDATE user_profile SET vocab_size = ? WHERE id = 1", (v,))
    db.commit()


def apply_evidence(db: sqlite3.Connection, lemma: str, rank: int, kind: str) -> float:
    """Nudge a word's estimate by one event, starting from its prior if this
    is the first evidence ever seen for it. Returns the resulting p_known."""
    row = db.execute("SELECT logit FROM word_knowledge WHERE lemma = ?", (lemma,)).fetchone()
    lo = row[0] if row else _logit(prior_p_known(rank, vocab_size(db)))
    lo = max(-LOGIT_CLAMP, min(LOGIT_CLAMP, lo + DELTA[kind]))
    p = _sigmoid(lo)
    db.execute(
        """INSERT INTO word_knowledge (lemma, logit, p_known, updated_at) VALUES (?,?,?,?)
           ON CONFLICT(lemma) DO UPDATE SET
               logit = excluded.logit, p_known = excluded.p_known, updated_at = excluded.updated_at""",
        (lemma, lo, p, int(time.time())),
    )
    return p


def known_map(db: sqlite3.Connection) -> dict[str, float]:
    return dict(db.execute("SELECT lemma, p_known FROM word_knowledge"))


def backfill_from_vocab(db: sqlite3.Connection, lex) -> int:
    """One-shot import from the existing vocab book: a word's *current*
    streak, not its review history (which isn't recorded per-event), decides
    how much evidence to apply -- mastered words graduate outright, others
    get the "collected" penalty plus one "srs_pass" bump per successful
    review already banked in their streak."""
    if not VOCAB_FILE.exists():
        return 0
    entries = json.loads(VOCAB_FILE.read_text(encoding="utf-8"))
    updated = 0
    for e in entries:
        toks = _WORD_RE.findall((e.get("question") or ""))
        if len(toks) != 1:
            continue
        word = toks[0].lower()
        lemma = lex.lemma_of(word)
        rank, _band = lex.rank_band(lemma)
        streak = e.get("streak", 0)
        if streak >= MASTERED_STREAK:
            apply_evidence(db, lemma, rank, "srs_graduated")
        else:
            apply_evidence(db, lemma, rank, "collected")
            for _ in range(streak):
                apply_evidence(db, lemma, rank, "srs_pass")
        updated += 1
    db.commit()
    return updated


def main():
    import indexer

    if not indexer.DICT_DB.exists():
        print("dictionary.db 不存在，先运行 python build_dict.py")
        return
    lex = indexer.LemmaRanks(indexer.DICT_DB)
    db = open_db()
    try:
        n = backfill_from_vocab(db, lex)
        print(f"从生词本回填 {n} 个词的已知度证据")
    finally:
        db.close()


if __name__ == "__main__":
    main()
