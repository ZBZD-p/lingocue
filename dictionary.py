#!/usr/bin/env python3
"""
Offline word lookup behind the subtitle hover tooltip.

Reads the SQLite file produced by build_dict.py. Kept deliberately dumb and
synchronous: a hover has to feel instant, and an indexed SQLite hit on a
6 MB file is microseconds -- far cheaper than any caching layer that could
sit in front of it.

Each request opens its own connection because FastAPI serves handlers from a
threadpool and SQLite connections aren't shareable across threads by default.
Opening is essentially free for a local file, and it avoids having to reason
about thread affinity.
"""

import re
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "dictionary.db"

# Trailing 's / n't etc. are split off rather than looked up: "don't" is
# stored as "do not" territory, and subtitle text is full of contractions.
CLITIC_RE = re.compile(r"['’](s|re|ve|ll|d|m|t)$", re.IGNORECASE)


def available() -> bool:
    return DB_PATH.exists()


def _row(db, word: str):
    return db.execute(
        "SELECT word, phonetic, translation FROM entries WHERE word = ?", (word,)
    ).fetchone()


def _resolve(db, word: str):
    """Direct hit, else via the inflection map, else a few cheap suffix
    guesses for regular forms ECDICT didn't spell out."""
    row = _row(db, word)
    if row:
        return row, None

    lemma = db.execute("SELECT lemma FROM forms WHERE form = ?", (word,)).fetchone()
    if lemma:
        row = _row(db, lemma[0])
        if row:
            return row, word

    # ECDICT's exchange field covers irregulars well but skips plenty of
    # regular formations; these rules pick up the common leftovers without
    # pulling in a stemming library.
    for suffix, replacements in (
        ("ies", ["y"]),
        ("es", ["", "e"]),
        ("s", [""]),
        ("ing", ["", "e"]),
        ("ed", ["", "e"]),
        ("er", ["", "e"]),
        ("est", ["", "e"]),
        ("ly", [""]),
    ):
        if not word.endswith(suffix) or len(word) - len(suffix) < 3:
            continue
        stem = word[: -len(suffix)]
        for repl in replacements:
            row = _row(db, stem + repl)
            if row:
                return row, word
        # Undo a doubled consonant: running -> run, bigger -> big
        if len(stem) >= 3 and stem[-1] == stem[-2]:
            row = _row(db, stem[:-1])
            if row:
                return row, word
    return None, None


def define(word: str) -> dict | None:
    """Phonetic + Chinese gloss for a word, or None if it isn't in the
    dictionary. `matched` names the form actually found, when the lookup
    had to go through an inflection."""
    if not available():
        return None
    cleaned = CLITIC_RE.sub("", (word or "").strip()).lower()
    if not cleaned:
        return None

    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        row, via = _resolve(db, cleaned)
    finally:
        db.close()

    if not row:
        return None
    return {
        "word": row[0],
        "phonetic": row[1] or "",
        "translation": row[2] or "",
        "queried": word,
        "inflected": bool(via),
    }
