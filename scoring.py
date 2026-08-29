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


# (upper bound exclusive, label) -- first bucket the density falls under.
_LABELS = [(4.0, "轻松"), (10.0, "刚好"), (18.0, "有挑战"), (25.0, "偏难")]


def label_for(density_per_min: float) -> str:
    for cutoff, name in _LABELS:
        if density_per_min < cutoff:
            return name
    return "超难"
