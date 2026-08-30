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

# Two different reasons a word ends up here, same treatment either way:
# never worth flagging as "a word you don't know". The disfluencies (um/uh)
# carry real but misleadingly rare-looking word_rank entries -- ECDICT has
# them, but a transcribed "um" is nowhere near as common in written corpora
# as it is in actual speech, so a viewer got told they were words worth
# learning. The greetings/interjections have the same problem from the
# other direction: ECDICT's frequency data comes from written text, where
# "hello" and "wow" as bare interjections are genuinely less common than
# they are in speech, so their corpus rank alone doesn't reflect how
# universally known they are before any level this app targets -- "hello"/
# "wow" showed up as preview-card picks against actual cached videos,
# "huh" (27 hits on one real video) reported directly from the running
# panel. The rest of this list is filled in ahead of a report rather than
# waited for one, on the same reasoning. Excluded outright rather than
# scored either way: there's no meaning to look up for the first group,
# and no one left to teach it to for the second.
FILLER_WORDS = {
    "um", "umm", "uh", "uhh", "uhm", "erm", "hmm", "huh",
    "hello", "hi", "hey", "hiya", "wow", "whoa",
    "ok", "okay", "oh", "ah", "aha", "yeah", "yep", "yup", "nope", "bye", "goodbye",
    "eh", "ugh", "hah", "haha", "yay", "aw", "aww", "meh", "argh", "ouch", "oops",
    "duh", "gosh", "geez", "gee", "yo",
}

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


_REAL_SINGLE_LETTER_WORDS = {"i", "a"}


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
    difficulty score computed so far.

    Also drops any single-character token that isn't a real English word:
    WORD_RE matches letters only, so "3D"/"4K" lose their digit and leave a
    bare "d"/"k" behind that reads as a word to everything downstream. That
    fake token then gets a word_rank lookup like any other -- ECDICT has no
    entry for bare "d", so it fell into the rarest band by default (same
    failure mode NEGATIVE_CONTRACTIONS exists for), and separately reached
    an actual preview card with 8 real hits, all "3D" -> "d". English has
    exactly two genuine single-letter words -- kept by name rather than
    dropping every single-character token outright.
    """
    tokens = []
    for sentence in SENTENCE_SPLIT_RE.split(text):
        words = WORD_RE.findall(sentence)
        for i, w in enumerate(words):
            raw_lower = w.lower()
            lower = NEGATIVE_CONTRACTIONS.get(raw_lower) or dictionary.CLITIC_RE.sub("", raw_lower)
            if lower and (len(lower) > 1 or lower in _REAL_SINGLE_LETTER_WORDS):
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


def _spoken_seconds(cues: list[tuple[int, int, str]]) -> float:
    """Total time actually covered by a cue, merging overlaps so a doubled
    or multi-speaker cue isn't counted twice.

    Deliberately not "last cue's end minus first cue's start": that span
    includes every gap between cues too, so a long dialogue-free stretch (an
    action sequence, a scenic long take) in the middle of an otherwise
    fast-talking video drags the whole video's average speech rate down --
    diluted by minutes nobody was saying anything, even though the dialogue
    that *is* there is exactly as dense/fast as it sounds. Summing only the
    time cues actually span answers "how fast do people talk when they're
    talking", independent of how much of the runtime is silence.
    """
    intervals = sorted((c[0], c[1]) for c in cues if c[1] > c[0])
    if not intervals:
        return 0.0
    merged = [list(intervals[0])]
    for start, end in intervals[1:]:
        if start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return sum(end - start for start, end in merged) / 1000


def _always_capitalized_lemmas(tokens: list[tuple[str, bool, bool]], lex: LemmaRanks) -> set[str]:
    """Lemmas that are almost certainly proper nouns, judged across the
    whole transcript rather than one occurrence at a time.

    The per-occurrence rule below (is_cap and not is_initial) misses a
    proper noun that happens to open sentences often -- a news video
    repeating "Israel warned..." / "Israel's response..." leaves plenty of
    non-sentence-initial capitalized hits to catch it, but one where every
    single mention happens to open a sentence slips through every time
    (confirmed for real: "israel" reached a preview card with 39 hits this
    way). A real common word shows up lowercase somewhere in a transcript
    of any real length -- an article, a plural, mid-sentence use; a name
    doesn't. So: any lemma seen at least twice that was capitalized *every*
    time, sentence-initial or not, gets excluded outright rather than just
    its mid-sentence occurrences. Requires >=2 sightings precisely because
    one sentence-initial mention alone is no evidence at all -- every word
    that happens to start the one sentence it appears in would otherwise
    look "always capitalized".

    Checked against lex.exam_taggable, not lex.is_known: ECDICT defines
    "Israel"/"Korea"/"Kim" the same as any ordinary headword (real
    translations, no different from "orbit"), so is_known's "does ECDICT
    have an entry" is true for them and would have exempted every one of
    them right back out. exam_taggable is vocab_test.py's existing answer
    to this exact problem (see its own docstring: "guitar" vs "gustavsson")
    -- a country/person/brand name gets a corpus rank like any other word
    but essentially never lands on an actual exam syllabus, while "Monday"/
    "China"/"God" -- also always-capitalized by convention or usage, but
    genuinely words worth knowing -- do.
    """
    seen_lemmas = set()
    seen_lowercase = set()
    occurrence_count = Counter()
    for lower, is_cap, _is_initial in tokens:
        if lower in NOT_PROPER:
            continue
        lemma = lex.lemma_of(lower)
        if lemma in lex.exam_taggable:
            continue
        seen_lemmas.add(lemma)
        occurrence_count[lemma] += 1
        if not is_cap:
            seen_lowercase.add(lemma)
    return {lemma for lemma in seen_lemmas
            if lemma not in seen_lowercase and occurrence_count[lemma] >= 2}


def profile_video(cues: list[tuple[int, int, str]], lex: LemmaRanks) -> dict | None:
    text = " ".join(c[2] for c in cues)
    tokens = _tokenize(text)
    if not tokens:
        return None

    band_counts = [0] * difficulty_bands.BAND_COUNT
    rare = Counter()
    proper_count = 0
    counted = 0
    proper_lemmas = _always_capitalized_lemmas(tokens, lex)

    for lower, is_cap, is_initial in tokens:
        lemma = lex.lemma_of(lower)
        if lemma in proper_lemmas or (
                is_cap and not is_initial and lower not in NOT_PROPER and not lex.is_known(lower)):
            proper_count += 1
            continue
        if lower in FILLER_WORDS:
            continue
        _rank, band = lex.rank_band(lemma)
        band_counts[band] += 1
        counted += 1
        if band >= 6:
            rare[lemma] += 1

    if counted == 0:
        return None

    duration_sec = max(1.0, _spoken_seconds(cues))

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
