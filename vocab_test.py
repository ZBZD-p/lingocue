#!/usr/bin/env python3
"""
Two-stage adaptive vocabulary-size test.

Stage 1 samples words at 5 fixed, widely-spaced frequency ranks (covers the
full plausible range with no prior knowledge of the user). Stage 2 samples
5 new ranks clustered around stage 1's rough estimate, spending its
questions where they actually discriminate instead of re-covering ranks
already answered predictably. A monte-carlo comparison against a flat
40-question fixed ladder (same total question count) showed this halves the
median error at the high-vocabulary end, where a fixed ladder runs out of
resolution.

fit_vocab_size does a plain grid-search MLE against knowledge.prior_p_known
-- 160-ish candidate V values x 40-ish answers is a few thousand log() calls,
nowhere near needing anything smarter.
"""

import math
import random
import re

import knowledge

# Rank anchors for stage 1 -- deliberately spans from "almost certainly
# known" to "almost certainly not", since nothing about the user is known
# yet.
COARSE_RANKS = [700, 2000, 5000, 11000, 25000]
QUESTIONS_PER_RANK = 4

# Words that look like plausible English morphology but don't exist --
# mixed in to catch someone clicking "known" on everything without reading.
# Not fed into fit_vocab_size; only used for the attention check.
FAKE_WORDS = [
    "flimbate", "morgated", "clenthy", "brastule", "vindorly",
    "quintiform", "drathenous", "plindsome",
]
FAKE_WORD_COUNT = 5
MAX_FAKE_KNOWN_BEFORE_RETAKE = 2

_WORD_RE = re.compile(r"^[a-z]+$")


def stage_two_ranks(v1: int) -> list[int]:
    return [max(300, int(v1 * f)) for f in (0.35, 0.6, 0.9, 1.4, 2.2)]


def _candidate_words(lex, target_rank: int, window: int = 400) -> list[str]:
    """Real, plain-alphabetic, exam-taggable words with a rank within
    `window` of the target, widening the window if the neighborhood is too
    sparse (rare out past ~30000 where word_rank thins out). Restricted to
    lex.exam_taggable -- see its docstring -- since a bare corpus rank alone
    doesn't distinguish "guitar" from "gustavsson"."""
    candidates = [
        lemma for lemma, (rank, _band) in lex.rank.items()
        if abs(rank - target_rank) <= window and _WORD_RE.match(lemma)
        and lemma in lex.exam_taggable
    ]
    if len(candidates) < 8 and window < 8000:
        return _candidate_words(lex, target_rank, window * 3)
    return candidates


def _pick_words(lex, target_rank: int, n: int, used: set[str]) -> list[dict]:
    pool = [w for w in _candidate_words(lex, target_rank) if w not in used]
    random.shuffle(pool)
    picked = pool[:n]
    used.update(picked)
    return [{"lemma": w, "rank": lex.rank[w][0]} for w in picked]


def generate_stage(lex, ranks: list[int], used: set[str], with_fakes: bool = False) -> list[dict]:
    """Real words come back sorted easiest-first, not shuffled -- confirmed
    for real that a fully random order routinely put a rank-25000 word
    third or fourth, right after two easy ones. fit_vocab_size doesn't care
    about order (it just needs the (rank, known) pairs), but a user does:
    a wall of "don't know" in the first few questions reads as "this test
    is broken" even when the underlying sampling is fine. Fake words (see
    FAKE_WORDS) are scattered in at random positions afterward -- they have
    no meaningful rank to sort by, and unpredictable placement is the point
    of the attention check."""
    items = []
    for r in ranks:
        items.extend(_pick_words(lex, r, QUESTIONS_PER_RANK, used))
    items.sort(key=lambda it: it["rank"])
    if with_fakes:
        fakes = random.sample(FAKE_WORDS, min(FAKE_WORD_COUNT, len(FAKE_WORDS)))
        for w in fakes:
            items.insert(random.randint(0, len(items)), {"lemma": w, "rank": 0, "is_fake": True})
    return items


def fit_vocab_size(answers: list[tuple[int, bool]], lo: int = 500, hi: int = 40000, step: int = 250) -> int:
    """answers: [(rank, known), ...], fake-word answers already excluded.
    Grid search for the V that makes the observed known/unknown pattern
    most likely under knowledge.prior_p_known."""
    best_v, best_ll = lo, float("-inf")
    for v in range(lo, hi + 1, step):
        ll = 0.0
        for rank, known in answers:
            p = min(max(knowledge.prior_p_known(rank, v), 1e-6), 1 - 1e-6)
            ll += math.log(p) if known else math.log(1 - p)
        if ll > best_ll:
            best_ll, best_v = ll, v
    return best_v


# (upper bound exclusive, label) -- first bucket the fitted V falls under.
_LEVELS = [(3250, "高考水平"), (5250, "四级水平"), (7250, "六级水平"), (10750, "雅思/托福水平")]


def level_label(v: int) -> str:
    for cutoff, label in _LEVELS:
        if v < cutoff:
            return label
    return "GRE 水平"
