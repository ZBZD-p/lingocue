#!/usr/bin/env python3
"""
Scoring for the preview-cards prompt: which words from a video's subtitles
are worth showing the user before they start watching.

Ranking prioritizes occurrence count over raw difficulty -- a word that
shows up once gets forgotten as soon as it's previewed; a word that shows
up four times gets four chances at reinforcement, so previewing it once
pays off four times over. This shares its vocabulary model (knowledge.py)
with scoring.py's difficulty engine, but answers a different question:
scoring.py asks "how hard is this whole video", this asks "which few words
are worth 30 seconds of this user's attention right now".
"""

import math
import re
from collections import Counter
from collections.abc import Callable

import dictionary
import indexer
import knowledge

# Loose enough to catch a real single-word vocab-book entry; a multi-word
# phrase (someone typed a whole sentence into the lookup box) carries no
# clean lemma and is skipped -- same rule knowledge.py's backfill uses.
_WORD_RE = re.compile(r"[A-Za-z']+")


def vocab_book_lemmas(vocab_entries: list[dict], lex: indexer.LemmaRanks) -> set[str]:
    """Lemmas already sitting in the vocab book -- previewing one of these
    is a free extra review, not new exposure (see the score's "已收藏" term
    in preview_words)."""
    lemmas = set()
    for entry in vocab_entries:
        word = (entry.get("question") or "").strip()
        if not _WORD_RE.fullmatch(word):
            continue
        lemmas.add(lex.lemma_of(word.lower()))
    return lemmas


# Keep this aligned with app.py's subtitle unknown threshold. An explicit
# "I know this" click raises p_known by 0.5; using a higher preview threshold
# would make the same confirmed word reappear in the next preview round.
KNOWN_THRESHOLD = 0.5

# Center and width of the "difficulty sweet spot" bonus -- a word right at
# the edge of what the user's vocab-size estimate says they know is where a
# preview slot helps most. Well below that edge, they likely know it
# already; well past it (rank 40000 jargon), one preview won't make it
# stick regardless of how it's presented.
SWEET_SPOT_CENTER = 0.4
SWEET_SPOT_WIDTH = 0.08

# "Appears early" bonus -- a word whose only appearances are twenty minutes
# into an hour-long video is a much worse preview pick than one in the
# first couple of minutes: a viewer who drops off early (which is when
# drop-off is most likely, for any length of video) never reaches it, so
# previewing it was wasted attention. Exponential decay rather than a hard
# "before minute N" cutoff, so there's no arbitrary cliff -- the bonus just
# fades smoothly the later a word's first occurrence is.
EARLY_BONUS_WEIGHT = 2.0

# A score below this is generally a one-off, late, or far-out-of-range word.
# Useful candidates in normal videos score around 5-6, while filler
# candidates in sparse videos cluster around 1.
MIN_PREVIEW_SCORE = 3.0


def adaptive_card_count(total_candidates: int) -> int:
    """Scale a preview round to its candidate pool, with practical bounds."""
    if total_candidates <= 0:
        return 0
    return max(3, min(12, round(1.6 * math.sqrt(total_candidates))))


def _first_occurrences(cues: list[tuple[int, int, str]], lex: indexer.LemmaRanks,
                        wanted_lemmas) -> dict[str, tuple[int, str]]:
    """First (start_ms, sentence) each lemma in `wanted_lemmas` actually
    appears at, resolved the same way scoring does (clitic-stripped,
    lemma_of) so "engage" matches a cue containing "engaging".

    Cues are already in chronological order, so the first hit per lemma is
    the real first occurrence; `remaining` shrinks as lemmas are found and
    the scan stops the moment it's empty; hunting through the rest of a
    multi-hour transcript for lemmas already resolved would be pure waste.
    """
    found = {}
    remaining = set(wanted_lemmas)
    for start_ms, _end_ms, text in cues:
        if not remaining:
            break
        for word in _WORD_RE.findall(text):
            raw_lower = word.lower()
            lower = indexer.NEGATIVE_CONTRACTIONS.get(raw_lower) or dictionary.CLITIC_RE.sub("", raw_lower)
            if not lower:
                continue
            lemma = lex.lemma_of(lower)
            if lemma in remaining:
                found[lemma] = (start_ms, text.strip())
                remaining.discard(lemma)
    return found


def preview_words(cues: list[tuple[int, int, str]], db, lex: indexer.LemmaRanks,
                   vocab_lemmas: set[str],
                   top_n: int | Callable[[int], int] | None = adaptive_card_count,
                   exclude: frozenset = frozenset()):
    """Score and rank candidate words from a video's cues.

    Returns (cards, total_candidates): cards are dicts sorted by score.
    Each dict includes total `score` and a `score_breakdown`, along with
    the lemma, hit count, rank, forms, and sentence. The `forms` value is
    the set of surface spellings this
    lemma actually appeared as (for matching real subtitle-card words back
    to the card later -- see app.py's /api/preview response and
    appendWordSpans' caller in tutor-panel.js) and `sentence` is a real
    cue containing it; total_candidates is how many passed the filters
    before truncation (for the "还有 N 个词没过" prompt).

    `exclude` -- lemmas already shown in an earlier round of the same
    session (the "再来 N 张" button) -- are dropped before scoring, so a
    second round pulls genuinely new words instead of repeating the first
    round's top pick forever.

    Tokenizes with indexer._tokenize -- the same per-occurrence
    (lower, is_cap, is_initial) pass profile_video uses for difficulty
    scoring -- rather than re-splitting the raw text from scratch, so a
    word this treats as a proper noun or filler matches what the difficulty
    badge already decided about it. Re-deriving that filter from plain word
    counts would lose the per-occurrence capitalization/position context
    the real heuristic needs, and could disagree with it word for word.
    Also runs indexer._always_capitalized_lemmas over the same tokens, to
    catch a proper noun that happens to open sentences often enough that
    the per-occurrence rule never sees it anywhere but sentence-initial.
    """
    text = " ".join(c[2] for c in cues)
    tokens = indexer._tokenize(text)
    known = knowledge.known_map(db)
    v = knowledge.vocab_size(db)
    proper_lemmas = indexer._always_capitalized_lemmas(tokens, lex)

    counts = Counter()
    forms = {}
    for lower, is_cap, is_initial in tokens:
        lemma = lex.lemma_of(lower)
        if lemma in proper_lemmas or (
                is_cap and not is_initial and lower not in indexer.NOT_PROPER and not lex.is_known(lower)):
            continue
        if lower in indexer.FILLER_WORDS:
            continue
        counts[lemma] += 1
        forms.setdefault(lemma, set()).add(lower)

    first = _first_occurrences(cues, lex, counts.keys())
    video_end_ms = max((c[1] for c in cues), default=1)
    early_decay_ms = max(60_000, video_end_ms * 0.15)

    scored = []
    for lemma, n in counts.items():
        if lemma in exclude:
            continue
        rank, _band = lex.rank_band(lemma)
        p = known.get(lemma)
        if p is None:
            p = knowledge.prior_p_known(rank, v)
        if p >= KNOWN_THRESHOLD:
            continue
        # A lemma _tokenize counted but _first_occurrences somehow missed
        # (shouldn't happen -- same normalization -- but not worth a crash
        # over) falls back to "as if it only appeared at the very end".
        first_ms, sentence = first.get(lemma, (video_end_ms, ""))
        # Clamp at 3: dozens of repetitions still matter without swamping
        # the vocab-book, difficulty, and reachability signals.
        occurrence_score = min(
            3.0, 3.0 * math.log1p(n) / math.log1p(20)
        )
        vocab_score = 2.0 * (lemma in vocab_lemmas)
        sweet_spot_score = 1.5 * math.exp(
            -((p - SWEET_SPOT_CENTER) ** 2) / SWEET_SPOT_WIDTH
        )
        early_score = EARLY_BONUS_WEIGHT * math.exp(-first_ms / early_decay_ms)
        score_breakdown = {
            "occurrence": occurrence_score,
            "vocab_book": vocab_score,
            "sweet_spot": sweet_spot_score,
            "early": early_score,
        }
        score = sum(score_breakdown.values())
        if score < MIN_PREVIEW_SCORE:
            continue
        scored.append({
            "score": score,
            "lemma": lemma,
            "hits": n,
            "rank": rank,
            "forms": forms[lemma],
            "sentence": sentence,
            "score_breakdown": score_breakdown,
        })
    scored.sort(key=lambda card: card["score"], reverse=True)
    total_candidates = len(scored)
    if top_n is None:
        limit = adaptive_card_count(total_candidates)
    else:
        limit = top_n(total_candidates) if callable(top_n) else top_n
    limit = max(0, int(limit))
    return scored[:limit], total_candidates
