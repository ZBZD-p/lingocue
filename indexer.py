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
import dictionary
import knowledge
import subs_now

DICT_DB = app_config.DICT_DB
DIFFICULTY_DB = app_config.DIFFICULTY_DB

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

# Verbal disfluency, not vocabulary -- confirmed for real these carry real
# but misleadingly rare-looking word_rank entries (ECDICT has them, but a
# transcribed "um" is nowhere near as common in written corpora as it is in
# actual speech), so a viewer got told "um"/"uh" were words worth learning.
# Excluded outright rather than scored: there's no meaning to look up, so
# "likely unknown" isn't a meaningful question to ask about them at all.
FILLER_WORDS = {"um", "umm", "uh", "uhh", "uhm", "erm", "hmm"}

# "n't" contractions absorb an extra "n" that dictionary.CLITIC_RE's plain
# suffix strip doesn't account for -- stripping just "'t" turns "don't" into
# "don" (not a word) rather than "do". Irregular enough (the "n" belongs to
# the stem in "can't" but not in "don't"; "won't" isn't even "will" plus
# any recognizable suffix) that a lookup table is more honest than a regex
# that would get some of these wrong anyway. Values are real words that
# LemmaRanks.lemma_of already knows how to resolve further (e.g. "isn't" ->
# "is" -> "be").
NEGATIVE_CONTRACTIONS = {
    "don't": "do", "doesn't": "does", "didn't": "did",
    "isn't": "is", "aren't": "are", "wasn't": "was", "weren't": "were",
    "can't": "can", "couldn't": "could", "won't": "will", "wouldn't": "would",
    "shouldn't": "should", "mustn't": "must", "mightn't": "might",
    "haven't": "have", "hasn't": "has", "hadn't": "had",
    "shan't": "shall", "needn't": "need", "ain't": "be",
}


def _tokenize(text: str):
    """(lower, is_capitalized, is_sentence_initial) for every word in text.

    The lower form has any trailing clitic ('s/'re/'ve/'ll/'d/'m/'t) stripped
    -- dictionary.CLITIC_RE, same rule the hover dictionary already applies
    -- with NEGATIVE_CONTRACTIONS checked first for the "n't" cases that
    rule alone gets wrong. Without either, "it's"/"don't"/"you're" never
    match anything in word_rank (which only has bare headwords) and
    silently fall into the rarest band as if they were obscure vocabulary --
    confirmed for real: they were the single largest contributor to "rare
    word" counts across every indexed video, badly inflating every
    difficulty score computed so far."""
    tokens = []
    for sentence in SENTENCE_SPLIT_RE.split(text):
        words = WORD_RE.findall(sentence)
        for i, w in enumerate(words):
            raw_lower = w.lower()
            lower = NEGATIVE_CONTRACTIONS.get(raw_lower) or dictionary.CLITIC_RE.sub("", raw_lower)
            if lower:
                tokens.append((lower, w[:1].isupper(), i == 0))
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
            self.rank = {lemma: (rank, band) for lemma, rank, band, _has_tag
                         in db.execute("SELECT lemma, rank, band, has_tag FROM word_rank")}
            # Words ECDICT put on some exam syllabus -- used by vocab_test.py
            # to filter out proper nouns (person/place/brand names), which
            # get a corpus rank like any other word but essentially never an
            # exam tag. Confirmed for real: without this filter, a vocab-size
            # test asked "do you know 'natwest'" (a UK bank) and "'mildred'"
            # (a first name) as if they were ordinary vocabulary.
            self.exam_taggable = {lemma for lemma, has_tag
                                   in db.execute("SELECT lemma, has_tag FROM word_rank") if has_tag}
        finally:
            db.close()

    # "be" is the one verb ECDICT's own exchange-field inflection data
    # doesn't fully cover -- forms.get("was"/"is"/"been"/"being") all
    # correctly point here, but "are" and "were" have no entry at all.
    # Patched by hand rather than left to fall through to word_rank's
    # rarest-band fallback: these are two of the most common words in
    # English and would otherwise dominate every video's "rare word" count.
    _LEMMA_OVERRIDES = {"are": "be", "were": "be"}

    def lemma_of(self, word_lower: str) -> str:
        override = self._LEMMA_OVERRIDES.get(word_lower)
        if override:
            return override
        # Prefer the forms-table lemma over treating word_lower as its own
        # word, even when word_lower already has its own rank/entry: ECDICT's
        # per-spelling corpus rank is unreliable for a handful of common
        # irregular inflections (confirmed for real: "is" and "was" carry
        # ranks in the tens of thousands on their own, as if rare, while
        # their shared lemma "be" correctly ranks at 2) -- the lemma's rank
        # is the more trustworthy signal for "does the user know this word",
        # which is all this is used for (unlike dictionary.py's hover
        # lookup, which deliberately prefers a direct hit first because an
        # inflected spelling can carry its own distinct meaning worth
        # defining on its own terms).
        mapped = self.forms.get(word_lower)
        if mapped:
            return mapped
        return word_lower

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
        if lower in FILLER_WORDS:
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
    """The schema lives in knowledge.open_db, which creates all four of this
    file's tables. This module used to declare its own two, which meant the
    database ended up with only whichever half had run first."""
    return knowledge.open_db()


def _video_id_from_marker(marker: Path) -> tuple[str, str, str] | None:
    try:
        meta = json.loads(marker.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    video_id = meta.get("id")
    if not video_id:
        return None
    return video_id, meta.get("title") or "", meta.get("channel_id") or ""


def backfill(cache_dir: Path, lex: LemmaRanks, db: sqlite3.Connection, verbose: bool = True) -> int:
    import time

    indexed = skipped = 0
    for marker in sorted(cache_dir.glob("*.tutor.json")):
        parsed = _video_id_from_marker(marker)
        if not parsed:
            continue
        video_id, title, channel_id = parsed

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
                rare_words, speech_rate, proper_ratio, indexed_at, source, channel_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (video_id, title, profile["duration_sec"], profile["total_tokens"],
             json.dumps(profile["band_dist"]), json.dumps(profile["rare_words"]),
             profile["speech_rate"], profile["proper_ratio"], int(time.time()), "cache", channel_id),
        )
        indexed += 1
        if verbose and indexed % 50 == 0:
            print(f"  已索引 {indexed} 个视频...")

    db.commit()
    channels = recompute_channel_profiles(db)
    if verbose:
        print(f"索引完成：{indexed} 个视频，跳过 {skipped} 个（没有英文字幕或字幕为空），"
              f"聚合出 {channels} 个频道画像")
    return indexed


def recompute_channel_profiles(db: sqlite3.Connection) -> int:
    """Token-count-weighted average band_dist/speech_rate per channel, from
    whatever's currently in video_profile. Weighting by raw token counts
    (not a plain per-video average) means one long, thoroughly-indexed video
    doesn't get diluted by three short ones the way an unweighted mean
    would."""
    import time

    rows = db.execute(
        "SELECT channel_id, total_tokens, band_dist, speech_rate FROM video_profile "
        "WHERE channel_id IS NOT NULL AND channel_id != ''"
    ).fetchall()
    by_channel: dict[str, list] = {}
    for channel_id, total_tokens, band_dist_json, speech_rate in rows:
        by_channel.setdefault(channel_id, []).append(
            (total_tokens, json.loads(band_dist_json), speech_rate))

    updated = 0
    for channel_id, videos in by_channel.items():
        total = sum(t for t, _, _ in videos)
        if total <= 0:
            continue
        band_counts = [0.0] * difficulty_bands.BAND_COUNT
        for t, band_dist, _sr in videos:
            for i, share in enumerate(band_dist):
                band_counts[i] += share * t
        band_dist = [c / total for c in band_counts]
        speech_rate = sum(t * sr for t, _, sr in videos) / total
        db.execute(
            """INSERT OR REPLACE INTO channel_profile
               (channel_id, n_videos, band_dist, speech_rate, updated_at)
               VALUES (?,?,?,?,?)""",
            (channel_id, len(videos), json.dumps(band_dist), speech_rate, int(time.time())),
        )
        updated += 1
    db.commit()
    return updated


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
