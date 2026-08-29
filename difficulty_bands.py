#!/usr/bin/env python3
"""
Shared word-frequency-rank band scale for the difficulty engine.

build_dict.py assigns each ECDICT word a band when it builds word_rank;
indexer.py buckets subtitle tokens into the same bands when it profiles a
video. Both need the exact same edges -- if they drifted apart, a video's
stored band_dist would no longer line up with what a lookup at score time
expects it to mean.
"""

from bisect import bisect_left

# Log-spaced word-frequency-rank edges: bands are wide at the high end (rank
# 1 vs rank 100 barely matters) and narrow near everyday vocabulary, where a
# few thousand ranks separate "definitely known" from "definitely not".
BAND_EDGES = [0, 1000, 2000, 3000, 4000, 5000, 6000,
              8000, 10000, 12000, 15000, 20000, 30000, float("inf")]
BAND_COUNT = len(BAND_EDGES) - 1

# Stand-in rank for a word with no row in word_rank at all -- past the last
# real edge, so it always lands in the rarest band.
UNRANKED_RANK = 60_000


def band_of(rank: int) -> int:
    return bisect_left(BAND_EDGES, rank) - 1
