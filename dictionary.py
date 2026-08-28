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

# Display order for a merged tag list (see define()) -- roughly ascending
# difficulty, matching the order ECDICT's own data tends to list them in
# and the panel's QUIZ_TAG_OPTIONS (static/tutor-panel.js).
TAG_ORDER = ["zk", "gk", "cet4", "cet6", "ky", "toefl", "ielts", "gre"]


def available() -> bool:
    return DB_PATH.exists()


def _row(db, word: str):
    return db.execute(
        "SELECT word, phonetic, translation, tags FROM entries WHERE word = ?", (word,)
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
        extra_tags = []
        if row and via is None:
            # A word can have its own dictionary entry (a genuinely distinct
            # sense/POS -- "engaging" the adjective isn't "engage" the verb)
            # while ALSO being listed in the forms table as an inflected
            # form of some other base word. ECDICT tags each spelling by
            # its own corpus frequency independently, so an inflected
            # form's tags routinely miss levels the base word already
            # clearly belongs to -- confirmed for real: "engage" is cet4,
            # "engaging" alone carries neither cet4 nor cet6. Only checked
            # for a direct hit (via is None): when _resolve already went
            # through the forms table itself (via is set), `row` is already
            # the lemma's own row, so this would just look itself up again.
            lemma = db.execute("SELECT lemma FROM forms WHERE form = ?", (row[0],)).fetchone()
            if lemma and lemma[0] != row[0]:
                lemma_row = _row(db, lemma[0])
                if lemma_row:
                    extra_tags = (lemma_row[3] or "").split()
    finally:
        db.close()

    if not row:
        return None
    # ECDICT's source CSV can't hold real newlines inside a field, so
    # multi-sense entries join them with a literal "\n" -- unescape it here
    # so the frontend's `white-space: pre-line` renders actual line breaks
    # instead of the two visible characters.
    translation = (row[2] or "").replace("\\n", "\n")
    # Union with the lemma's tags (if any were found above), not a
    # replacement -- this word's own tags, however sparse, still count.
    merged_tags = set((row[3] or "").split()) | set(extra_tags)
    return {
        "word": row[0],
        "phonetic": row[1] or "",
        "translation": translation,
        "queried": word,
        "inflected": bool(via),
        # Exam syllabi this word belongs to (cet4, cet6, ielts, ...), if
        # any -- see build_dict.py. Empty for the common case of a word
        # that just isn't on any of those lists.
        "tags": [t for t in TAG_ORDER if t in merged_tags],
    }
