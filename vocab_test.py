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

import dictionary
import knowledge

# Rank anchors for stage 1 -- deliberately spans from "almost certainly
# known" to "almost certainly not", since nothing about the user is known
# yet.
COARSE_RANKS = [700, 2000, 5000, 11000, 25000]
QUESTIONS_PER_RANK = 4

MEANING_QUESTION_COUNT = 8
_GLOSS_CACHE: dict[str, str | None] = {}

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
    # A narrow frequency neighborhood can be sparse after stage one has
    # consumed some words. Fill the shortfall from the nearest remaining
    # exam-tagged words so the test length does not silently change between
    # users or runs.
    target_total = len(ranks) * QUESTIONS_PER_RANK
    if len(items) < target_total:
        remaining = [w for w in lex.exam_taggable if w not in used and w in lex.rank
                     and _WORD_RE.match(w)]
        random.shuffle(remaining)
        remaining.sort(key=lambda w: min(abs(lex.rank[w][0] - r) for r in ranks))
        for word in remaining[:target_total - len(items)]:
            used.add(word)
            items.append({"lemma": word, "rank": lex.rank[word][0]})
    items.sort(key=lambda it: it["rank"])
    return items


def _short_gloss(word: str) -> str | None:
    """Compact first dictionary sense suitable for a multiple-choice row."""
    if word in _GLOSS_CACHE:
        return _GLOSS_CACHE[word]
    entry = dictionary.define(word)
    if not entry:
        _GLOSS_CACHE[word] = None
        return None
    lines = [line.strip() for line in entry["translation"].splitlines() if line.strip()]
    if not lines:
        _GLOSS_CACHE[word] = None
        return None
    gloss = lines[0]
    result = gloss[:72] + ("..." if len(gloss) > 72 else "")
    _GLOSS_CACHE[word] = result
    return result


def add_meaning_questions(items: list[dict], lex, count: int | None = None,
                          option_count: int = 6) -> None:
    """Turn real words into six-choice meaning checks.

    Distractors come from roughly the same frequency neighborhood as the
    target so the correct option is not exposed merely by being simpler.
    Mutates items in place; items without four usable unique glosses remain
    ordinary familiarity questions.
    """
    real_indices = [i for i, item in enumerate(items) if not item.get("is_fake")]
    if not real_indices:
        return
    count = len(real_indices) if count is None else min(count, len(real_indices))
    # Spread checks across the whole difficulty ladder rather than taking a
    # random clump that might all land at one end of the estimate.
    chosen = sorted({real_indices[round(j * (len(real_indices) - 1) / max(1, count - 1))]
                     for j in range(min(count, len(real_indices)))})
    all_words = list(lex.rank)
    for idx in chosen:
        item = items[idx]
        correct = _short_gloss(item["lemma"])
        if not correct:
            continue
        nearby = [word for word in all_words
                  if word != item["lemma"] and word in lex.exam_taggable
                  and abs(lex.rank[word][0] - item["rank"]) <= 1500]
        if len(nearby) < option_count * 4:
            nearby = [word for word in all_words
                      if word != item["lemma"] and word in lex.exam_taggable]
        random.shuffle(nearby)
        distractors = []
        for word in nearby:
            gloss = _short_gloss(word)
            if gloss and gloss != correct and gloss not in distractors:
                distractors.append(gloss)
            if len(distractors) == option_count - 1:
                break
        if len(distractors) != option_count - 1:
            continue
        options = distractors + [correct]
        random.shuffle(options)
        item["meaning_options"] = options
        item["correct_option"] = options.index(correct)


def fit_vocab_size(answers: list[tuple[int, float]], lo: int = 500, hi: int = 40000, step: int = 250) -> int:
    """answers: [(rank, familiarity), ...], fake-word answers excluded.

    Familiarity is 0 for unknown, 0.5 for unsure and 1 for known. The
    fractional observation contributes the expected Bernoulli log
    likelihood, so an honest "模糊" answer carries less directional weight
    than either confident endpoint.

    Grid search for the V that makes the observed known/unknown pattern
    most likely under knowledge.prior_p_known."""
    best_v, best_ll = lo, float("-inf")
    for v in range(lo, hi + 1, step):
        ll = 0.0
        for rank, familiarity in answers:
            p = min(max(knowledge.prior_p_known(rank, v), 1e-6), 1 - 1e-6)
            ll += familiarity * math.log(p) + (1 - familiarity) * math.log(1 - p)
        if ll > best_ll:
            best_ll, best_v = ll, v
    return best_v


def fit_vocab_range(answers: list[tuple[int, float]], lo: int = 500,
                    hi: int = 40000, step: int = 250) -> tuple[int, int, int]:
    """Return (best, lower, upper) on a likelihood-based uncertainty band.

    The interval contains grid candidates within two log-likelihood points
    of the best fit, which is intentionally presented as an estimate rather
    than false precision from a short self-report test.
    """
    scores = []
    for v in range(lo, hi + 1, step):
        ll = 0.0
        for rank, familiarity in answers:
            p = min(max(knowledge.prior_p_known(rank, v), 1e-6), 1 - 1e-6)
            ll += familiarity * math.log(p) + (1 - familiarity) * math.log(1 - p)
        scores.append((ll, v))
    if not scores:
        return lo, lo, hi
    best_ll, best_v = max(scores)
    accepted = [v for ll, v in scores if ll >= best_ll - 2.0]
    return best_v, min(accepted), max(accepted)


# (upper bound exclusive, label) -- first bucket the fitted V falls under.
_LEVELS = [(3250, "高考水平"), (5250, "四级水平"), (7250, "六级水平"), (10750, "雅思/托福水平")]


def level_label(v: int) -> str:
    for cutoff, label in _LEVELS:
        if v < cutoff:
            return label
    return "GRE 水平"
