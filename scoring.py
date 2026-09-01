#!/usr/bin/env python3
"""
Turns a video's frequency-band fingerprint (indexer.py) plus the user's
vocabulary-size estimate (knowledge.py) into a single number worth showing:
new words per minute.

Coverage percentage isn't that number -- real videos cluster between 0.90
and 0.98 coverage, where "92%" and "96%" look interchangeable but mean 12
new words a minute versus 6. Density carries the four-way spread that
coverage hides, and it's a number a user can act on directly.
"""

import difficulty_bands
import knowledge


def _band_reps() -> list[float]:
    """Geometric midpoint of each band's rank range, standing in for "the
    rank of a typical word in this band" -- geometric because rank is
    Zipf-distributed (see knowledge.prior_p_known), so the arithmetic
    midpoint of e.g. [15000, 20000) would overweight the rare end."""
    edges = difficulty_bands.BAND_EDGES
    reps = []
    for lo, hi in zip(edges, edges[1:]):
        if hi == float("inf"):
            reps.append(lo * 2.0)  # arbitrary "deep in the tail" stand-in
        elif lo <= 0:
            reps.append(hi / 2.0)
        else:
            reps.append((lo * hi) ** 0.5)
    return reps


BAND_REPS = _band_reps()


def coverage(band_dist: list[float], vocab_size: int) -> float:
    cov = sum(share * knowledge.prior_p_known(rep, vocab_size)
              for share, rep in zip(band_dist, BAND_REPS))
    return max(0.0, min(1.0, cov))


def unknown_per_min(band_dist: list[float], speech_rate: float, vocab_size: int) -> float:
    return (1 - coverage(band_dist, vocab_size)) * speech_rate


_REPETITION_WEIGHTS = (1.0, 0.7, 0.5, 0.3)
PERSONALIZED_UNKNOWN_THRESHOLD = 0.5


def effective_occurrences(count: int) -> float:
    """Diminishing contribution of repeated occurrences of one lemma."""
    if count <= 0:
        return 0.0
    return sum(_REPETITION_WEIGHTS[min(i, len(_REPETITION_WEIGHTS) - 1)]
               for i in range(count))


def personalized_unknown_per_min(
    lemma_counts: dict[str, int] | None,
    db=None,
    lex=None,
    duration_sec: int | float = 0,
    *,
    known_map: dict[str, float] | None = None,
    vocab_size: int | None = None,
) -> float:
    """Estimate clearly-unknown lemma load per minute using user evidence.

    ``known_map`` and ``vocab_size`` may be supplied by batch callers to avoid
    repeatedly reading SQLite. Empty or legacy profiles naturally return 0;
    callers should use :func:`unknown_per_min` as their compatibility fallback.
    """
    if not lemma_counts:
        return 0.0
    if known_map is None:
        known_map = knowledge.known_map(db) if db is not None else {}
    if vocab_size is None:
        vocab_size = knowledge.vocab_size(db) if db is not None else knowledge.DEFAULT_VOCAB_SIZE
    try:
        vocab_size = max(1, int(vocab_size))
    except (TypeError, ValueError):
        vocab_size = knowledge.DEFAULT_VOCAB_SIZE

    unknown_load = 0.0
    for lemma, raw_count in lemma_counts.items():
        try:
            count = int(raw_count)
        except (TypeError, ValueError):
            continue
        if count <= 0:
            continue
        p = known_map.get(lemma)
        if p is None:
            rank = difficulty_bands.UNRANKED_RANK
            if lex is not None:
                try:
                    rank, _band = lex.rank_band(lemma)
                except (AttributeError, TypeError, ValueError):
                    pass
            p = knowledge.prior_p_known(rank, vocab_size)
        try:
            p = min(1.0, max(0.0, float(p)))
        except (TypeError, ValueError):
            p = 0.0
        # Keep the metric aligned with subtitle highlighting: words at or
        # above the known threshold are not counted as unknown at all. This
        # makes "words per minute" readable as actual likely-new words,
        # rather than a fractional uncertainty score over every word.
        if p < PERSONALIZED_UNKNOWN_THRESHOLD:
            unknown_load += effective_occurrences(count) * (1.0 - p)

    try:
        minutes = max(float(duration_sec) / 60.0, 1.0)
    except (TypeError, ValueError):
        minutes = 1.0
    return unknown_load / minutes


# (upper bound exclusive, label) -- first bucket the density falls under.
_LABELS = [(4.0, "轻松"), (10.0, "刚好"), (18.0, "有挑战"), (25.0, "偏难")]


def label_for(density_per_min: float) -> str:
    for cutoff, name in _LABELS:
        if density_per_min < cutoff:
            return name
    return "超难"
