#!/usr/bin/env python3
"""
YouTube support, without ever storing the video.

The trick this whole feature rests on: everything downstream -- the subtitle
pipeline, the MCP tools, the bilingual merge, the loop -- reaches the current
video through `playback.current_video() -> Path` and looks for subtitles
*next to that path*. So a YouTube video only has to look like a file on disk
with a sidecar .srt beside it, and none of that code needs to know the
difference. Playback itself happens in YouTube's own embedded player.

What actually lands on disk per video is a few tens of KB:

    Some Title [dQw4w9WgXcQ].strm            <- a few dozen bytes, holds the URL
    Some Title [dQw4w9WgXcQ].en.srt          <- the real payload
    Some Title [dQw4w9WgXcQ].en.words.json   <- per-word timings, auto captions only
    Some Title [dQw4w9WgXcQ].tutor.json      <- id / title / which kind of subtitles

Human-written subtitles are preferred, but they turned out to be rare enough
to be limiting -- measured hit rate across a search sample: TED 6/6, English
lessons 2/6, podcasts 1/6, gaming 0/6. So auto-generated captions are
accepted as a fallback, with the caveat that their *word accuracy* is lower;
they are flagged as such so a wrong-looking word can be treated with
suspicion rather than looked up as gospel.

What auto captions need first is repair, not judgement. YouTube serves them
as rolling captions -- each cue repeats the tail of the one before it plus a
few new words -- which converts to SRT as the same sentence two or three
times over, padded with 10ms spacer cues. Measured on a real file: 1519 raw
blocks collapsing to 689 real lines. `clean_auto_captions` below undoes that.
"""

import html
import json
import os
import re
import threading
import time
import urllib.parse
from pathlib import Path

import requests

import app_config
import subs_now

# Defaults to <project>/youtube; set youtube_cache_dir in config.json to put
# it next to a media library instead. Resolved once at import, so a change to
# config.json takes effect on the next app.py start.
CACHE_DIR = app_config.youtube_cache_dir()

# Language codes the 副字幕 setting can use, when a video happens to carry one
# (most don't). Matched as prefixes, so this covers zh-Hans / zh-Hant / zh-CN
# and any other regional variant YouTube reports.
SECONDARY_PREFIXES = ("zh",)

# Windows forbids these outright, and trailing dots/spaces get silently
# stripped by the filesystem -- which would leave the .srt and the placeholder
# with names that no longer match, breaking the sidecar lookup.
ILLEGAL_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


VTT_TIME_RE = re.compile(r"(\d{2}):(\d{2}):(\d{2})\.(\d{3})")
VTT_TAG_RE = re.compile(r"<[^>]*>")
# Same timestamp shape as VTT_TIME_RE, but wrapped in its literal <...> tag
# and captured whole -- used to split a block's raw payload into alternating
# (text, timestamp) pieces rather than just find matches within it.
VTT_TIME_TAG_RE = re.compile(r"<(\d{2}:\d{2}:\d{2}\.\d{3})>")

# Rolling captions advance by emitting a ~10ms cue between real ones. They
# carry no new text, only the transition.
SPACER_MAX_MS = 30


def _vtt_ms(groups) -> int:
    h, m, sec, milli = groups
    return ((int(h) * 60 + int(m)) * 60 + int(sec)) * 1000 + int(milli)


_C_TAG_RE = re.compile(r"</?c>")


def _word_stamps(payload: list[str]) -> list[tuple[str, int | None]]:
    """Per-word (word, real_start_ms) for one cue block, tokenized the same
    way `text` below is (whitespace-split after stripping all tags) -- so
    the two line up word-for-word by position and a caller can zip them.

    A word with no inline timestamp immediately before it in *this*
    particular block comes back with `None` -- per the module docstring
    above, a word's real stamp often only shows up once it scrolls into a
    *later* block, not the one where it first appears. clean_auto_captions
    backfills those from that later block when it can; whatever's still
    `None` after that falls to _fill_word_gaps' interpolation.
    """
    raw = html.unescape(_C_TAG_RE.sub("", " ".join(payload)))
    parts = VTT_TIME_TAG_RE.split(raw)
    pairs: list[tuple[str, int | None]] = [(w, None) for w in parts[0].split()]
    for i in range(1, len(parts), 2):
        ms = _vtt_ms(VTT_TIME_RE.match(parts[i]).groups())
        text_after = parts[i + 1] if i + 1 < len(parts) else ""
        pairs.extend((w, ms) for w in text_after.split())
    return pairs


def _fill_word_gaps(stream: list[list], doc_end_ms: int) -> list[tuple[int, int, str]]:
    """Turns the [word, start_ms|None, fallback_ms|None] entries collected
    while walking the vtt into finished (start_ms, end_ms, word) triples.

    Three sources of truth, in descending order of trust:

    1. The word's own inline `<00:00:02.520>` stamp, or one backfilled from
       a later block that carried it.
    2. `fallback_ms` -- the start of the block the word first appeared in.
       Only the first new word of each block lacks an inline stamp (the tag
       sits *between* words, so the first one has nothing before it), and
       for exactly that word the block's own start is when it appeared on
       screen. This matters far more than its one-in-seven frequency
       suggests: those words are the ones that follow a pause, so
       interpolating them instead lands them in the middle of the silence.
       Measured on a real transcript before this used the block start: every
       such word was early, by 307ms on average and up to 8.6 seconds.
    3. Even spacing between whichever real stamps bracket the gap -- the
       last resort, for sources irregular enough that neither of the above
       turned anything up.
    """
    n = len(stream)
    for entry in stream:
        if entry[1] is None and entry[2] is not None:
            entry[1] = entry[2]

    i = 0
    prev_ms = 0
    while i < n:
        if stream[i][1] is not None:
            prev_ms = stream[i][1]
            i += 1
            continue
        j = i
        while j < n and stream[j][1] is None:
            j += 1
        next_ms = stream[j][1] if j < n else doc_end_ms
        span = max(1, next_ms - prev_ms)
        count = j - i
        # count+1 slots, not count: dividing by count alone puts the first
        # gap word's start at exactly prev_ms -- indistinguishable from the
        # anchor word right before it, which collapses that anchor's own
        # end (the next word's start, set below once this word has one) to
        # zero-length. Starting from slot 1 instead leaves every gap word a
        # real step past prev_ms.
        for k in range(count):
            stream[i + k][1] = prev_ms + span * (k + 1) // (count + 1)
        prev_ms = next_ms
        i = j

    # Sources disagreeing (a block start later than a stamp inside it, say)
    # would otherwise put a word before the one it follows, and the
    # highlight walks this list assuming it only ever moves forward.
    for idx in range(1, n):
        if stream[idx][1] < stream[idx - 1][1]:
            stream[idx][1] = stream[idx - 1][1]

    out: list[tuple[int, int, str]] = []
    for idx, entry in enumerate(stream):
        end_ms = stream[idx + 1][1] if idx + 1 < n else doc_end_ms
        out.append((entry[1], end_ms, entry[0]))
    return out


def clean_auto_captions(
    vtt_path: Path,
) -> tuple[list[tuple[int, int, str]], list[tuple[int, int, str]]]:
    """Rebuild YouTube's rolling auto-captions into ordinary cues.

    The raw form shows two lines at a time and re-emits the whole visible
    window on every update, so the same words arrive several times. What
    makes the repair reliable is that every repeat is a whole-word prefix of
    what was just emitted, so it can be stripped by comparing word lists --
    comparing characters would happily cut a word in half.

    Every line of a block is kept, deliberately. An earlier version took only
    the lines carrying per-word timestamps, on the theory that those are the
    newly-spoken words. They are not: a line's first appearance often has no
    stamps at all and only picks them up on the *next* block, so that version
    silently dropped whole phrases -- "The graphics are going to be
    absolutely" vanished, leaving a card reading just "stunning." Overlap
    stripping already removes the repeats, which is the only job that filter
    was doing correctly.

    Returns (cues, word_stream): word_stream is real, not estimated,
    per-word timing for the whole transcript (see _word_stamps /
    _fill_word_gaps), in the same word order `cues` flattens to.
    resegment_sentences below is handed it directly, so cue-cutting doesn't
    have to guess where a resegmented sentence's words actually fall; the
    caller also gets it back to persist alongside the .srt (see
    _fetch_auto_captions) so a later pass -- punctuation restoration, or a
    future word-level highlight -- can reuse it without re-parsing the vtt.
    """
    # Split on genuinely empty lines only, not on any whitespace-only line.
    # A one-line rolling caption arrives as an *empty top line* holding a
    # single space, directly under the timing header -- treating that as a
    # separator cut those headers away from their own text, and the words
    # underneath lost every inline timestamp they had. Measured on a real
    # transcript: 15 of 557 blocks orphaned that way, including the very
    # first one.
    blocks = re.split(r"\n\n+", vtt_path.read_text(encoding="utf-8", errors="ignore").strip())
    # (first word's index into word_stream, block end, text) -- turned into
    # real cues once _fill_word_gaps below has resolved the word timings.
    cue_spans: list[tuple[int, int, str]] = []
    # [word, start_ms|None, fallback_ms|None] lists rather than tuples:
    # backfill (below) patches an already-appended entry's timestamp in
    # place once a later block reveals it. See _fill_word_gaps for how the
    # two timestamp slots rank against each other.
    word_stream: list[list] = []
    previous_words: list[str] = []
    doc_end_ms = 0

    for block in blocks:
        lines = block.splitlines()
        time_idx = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if time_idx is None:
            continue
        stamps = VTT_TIME_RE.findall(lines[time_idx])
        if len(stamps) < 2:
            continue
        start, end = _vtt_ms(stamps[0]), _vtt_ms(stamps[1])
        if end - start <= SPACER_MAX_MS:
            continue
        doc_end_ms = max(doc_end_ms, end)

        payload = lines[time_idx + 1:]
        text = html.unescape(VTT_TAG_RE.sub("", " ".join(payload)))
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            continue

        words = text.split()
        pairs = _word_stamps(payload)
        if [w for w, _ in pairs] != words:
            # This block's markup didn't tokenize the same way the plain
            # text did (a stray entity, an unusual line -- rare, but seen in
            # the wild). Rather than risk pairing a timestamp with the wrong
            # word, treat the whole block as carrying none at all; the gap
            # fill at the end covers it the same as any other unstamped run.
            pairs = [(w, None) for w in words]

        overlap = min(len(previous_words), len(words))
        while overlap > 0 and previous_words[-overlap:] != words[:overlap]:
            overlap -= 1

        # Backfill: the repeated prefix here is the exact same words already
        # appended to word_stream when an earlier block introduced them as
        # fresh. If THIS block's own markup happens to carry a real stamp
        # for one of them -- the "picks it up on the next block" case from
        # the docstring above -- patch it into that earlier, still-empty
        # slot instead of leaving it for interpolation to guess.
        base_idx = len(word_stream) - overlap
        for k in range(overlap):
            ms = pairs[k][1]
            if ms is not None and word_stream[base_idx + k][1] is None:
                word_stream[base_idx + k][1] = ms

        previous_words = words
        fresh = words[overlap:]
        if not fresh:
            continue
        # Only the first new word gets the block start as a fallback -- it's
        # the one the block start actually describes. Handing it to the rest
        # would claim they were all spoken at that same instant.
        first_index = len(word_stream)
        word_stream.extend(
            [word, ms, start if k == 0 else None]
            for k, (word, ms) in enumerate(pairs[overlap:])
        )
        # Start is filled in below, once the word timings are resolved, so a
        # cue always begins exactly when its own first word does. Reading a
        # timestamp straight out of the block here can't do that: in a
        # rolling block the earliest inline stamp belongs to the *second*
        # new word, the first having only the block start to go on.
        cue_spans.append((first_index, end, " ".join(fresh)))

    filled = _fill_word_gaps(word_stream, doc_end_ms)
    cues = [(filled[i][0], end, text) for i, end, text in cue_spans]
    return resegment_sentences(cues, word_stream=filled), filled



# A card should hold a sentence. YouTube's cues hold a *display line* -- two
# lines' worth of whatever fit on screen -- so a thought routinely arrives
# split four ways ("A towering windowless monolith, pitch" / "black at night,
# a 20th century fortress" / ...). That is bad for reading and worse for the
# A-B loop, which can then only repeat a fragment.
SENTENCE_END_RE = re.compile(r'''[.!?]["')\]]?$''')
CLAUSE_END_RE = re.compile(r'[,;:]$')

# Past this a card stops being readable at a glance, so an over-long sentence
# is broken at the next opportunity rather than running on forever.
MAX_CARD_CHARS = 120

# Not every auto-caption track is punctuated. Plenty arrive as an unbroken
# stream of lowercase words, and against those a splitter that only cuts at
# "." produces one card holding the entire video -- measured on a 21-minute
# documentary: two cards, 697 and 2599 words. So an oversized card also
# accepts two weaker signals.
#
# A silence between words is where a speaker actually breaks a phrase, which
# makes it the best boundary available when punctuation is absent. Word times
# inside a cue are interpolated and therefore contiguous, so a gap here only
# ever reflects a real gap between the source cues.
PAUSE_BREAK_MS = 450

# And when neither punctuation nor a pause turns up, the card is cut anyway.
# Mid-phrase is a poor place to break; unbounded is worse.
HARD_CAP_CHARS = 180

# Below this share of cues carrying sentence-ending punctuation, the track is
# treated as unpunctuated and left alone entirely -- see resegment_sentences.
PUNCTUATED_SHARE = 0.25


def resegment_sentences(
    cues: list[tuple[int, int, str]],
    word_stream: list[tuple[int, int, str]] | None = None,
) -> list[tuple[int, int, str]]:
    """Recut cues so each one is a sentence.

    Works on a word stream rather than by merging whole cues: a cue boundary
    frequently falls mid-sentence *and* a sentence frequently ends mid-cue, so
    merging alone can never produce clean sentences. Word positions come from
    `word_stream` when the caller has real ones (see clean_auto_captions);
    otherwise words_from_cues below estimates them by evenly spacing across
    each cue's span, off by a fraction of a second at worst -- well inside
    the loop's own lead-in padding, but enough to be felt by plain
    current-line highlighting, which has no such padding to hide behind.

    An unpunctuated track is returned untouched. There are no sentences to cut
    to, and the fallbacks that keep such a track from becoming one giant card
    still leave it far worse than where it started: measured on a documentary
    with no punctuation at all, recutting gave 170-character cards averaging
    10.7 seconds, against 4-6 seconds for punctuated tracks. The source's own
    line breaks sit at roughly phrase length, which is the best structure on
    offer once punctuation is gone.
    """
    if is_unpunctuated(cues):
        return cues
    return cut_words_into_cues(words_from_cues(cues, word_stream=word_stream))


def cut_words_into_cues(words: list[tuple[int, int, str]]) -> list[tuple[int, int, str]]:
    """The cutting half of resegment_sentences, on an already-word-level
    stream that's already known to be punctuated.

    Split out because is_unpunctuated's density check is meaningless applied
    here: it counts what share of *cues* end in punctuation, which assumes
    line-level cues where most lines are a clause or more. Fed a word-level
    stream instead -- as the AI punctuation pass produces -- only the one
    word ending each sentence carries punctuation, so the same check reads a
    perfectly punctuated stream as unpunctuated and hands every single word
    back as its own one-word cue. Skipping straight to the cutting logic
    avoids re-running a check that doesn't apply to this shape of input.
    """
    out: list[tuple[int, int, str]] = []
    current: list[tuple[int, int, str]] = []

    def flush():
        if current:
            out.append((current[0][0], current[-1][1],
                        " ".join(w for _, _, w in current)))
            current.clear()

    for i, word in enumerate(words):
        current.append(word)
        if SENTENCE_END_RE.search(word[2]):
            flush()
            continue

        size = sum(len(w) + 1 for _, _, w in current)
        if size < MAX_CARD_CHARS:
            continue

        # Comfortable length is already exceeded, so take the first tolerable
        # excuse to cut: a clause boundary, a pause in the speech, or failing
        # both, the hard ceiling.
        gap = words[i + 1][0] - word[1] if i + 1 < len(words) else 0
        if (CLAUSE_END_RE.search(word[2])
                or gap >= PAUSE_BREAK_MS
                or size >= HARD_CAP_CHARS):
            flush()
    flush()
    return out


def is_unpunctuated(cues: list[tuple[int, int, str]]) -> bool:
    """Whether a track carries essentially no sentence-ending punctuation.

    Checked anywhere in the line, not just at the end: the question is
    whether the track is punctuated at all, and a punctuated track's periods
    land mid-line as often as at the end of one.
    """
    if not cues:
        return False
    punctuated = sum(1 for _, _, t in cues if re.search(r"[.!?]", t))
    return punctuated / len(cues) < PUNCTUATED_SHARE


def words_from_cues(
    cues: list[tuple[int, int, str]],
    word_stream: list[tuple[int, int, str]] | None = None,
) -> list[tuple[int, int, str]]:
    """Flatten cues into a word stream, one (start_ms, end_ms, word) per word.

    `word_stream` -- real per-word timing already known for this exact text
    (see clean_auto_captions) -- is used as-is when its words line up
    one-for-one with what `cues` actually flattens to. Otherwise (no
    word_stream, or its word sequence doesn't match -- a mismatch never
    happens by construction at either of today's call sites, but nothing
    here should trust that blindly) times are interpolated across each
    cue's span instead, off by a fraction of a second at worst, well inside
    the loop's own lead-in padding. Shared by resegment_sentences and the AI
    punctuation pass below, which both need the same word-level view for
    different reasons (cutting on punctuation vs. sending chunks to the
    model).
    """
    flat_words = [token for _, _, text in cues for token in text.split()]
    if word_stream is not None and [w for _, _, w in word_stream] == flat_words:
        return word_stream

    words: list[tuple[int, int, str]] = []
    for start, end, text in cues:
        tokens = text.split()
        if not tokens:
            continue
        span = max(1, end - start)
        for i, token in enumerate(tokens):
            words.append((start + span * i // len(tokens),
                          start + span * (i + 1) // len(tokens),
                          token))
    return words


def _srt_clock(ms: int) -> str:
    h, rem = divmod(max(0, ms), 3_600_000)
    m, rem = divmod(rem, 60_000)
    return f"{h:02d}:{m:02d}:{rem // 1000:02d},{rem % 1000:03d}"


def write_srt(cues: list[tuple[int, int, str]], path: Path) -> None:
    path.write_text(
        "".join(
            f"{i}\n{_srt_clock(s)} --> {_srt_clock(e)}\n{t}\n\n"
            for i, (s, e, t) in enumerate(cues, 1)
        ),
        encoding="utf-8",
    )


def _word_stream_path(srt: Path) -> Path:
    # srt.stem strips only the .srt suffix, leaving the language tag on --
    # "Some Title [id].en.srt" -> "Some Title [id].en.words.json" -- so this
    # sits next to whichever exact sidecar _english_subtitle actually found.
    return srt.with_name(srt.stem + ".words.json")


def load_word_stream(srt: Path) -> list[tuple[int, int, str]] | None:
    """Real per-word timing saved alongside an auto-caption .srt, if any --
    see clean_auto_captions. `None` for anything else (human subtitles, MKV
    extractions, or an auto-caption fetched before this existed), which
    callers treat as "fall back to interpolating"."""
    try:
        data = json.loads(_word_stream_path(srt).read_text(encoding="utf-8"))
        return [(s, e, w) for s, e, w in data]
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def save_word_stream(srt: Path, word_stream: list[tuple[int, int, str]]) -> None:
    _word_stream_path(srt).write_text(
        json.dumps([[s, e, w] for s, e, w in word_stream], ensure_ascii=False),
        encoding="utf-8",
    )


# ---- punctuation restoration for unpunctuated auto-captions ---------------
#
# is_unpunctuated tracks are left as raw per-line cues by resegment_sentences
# because there is no punctuation to cut on -- see that function's docstring.
# Those raw cues are already reasonable (source line breaks sit near phrase
# length), but a real sentence is better. Restoring punctuation is done here
# by a small local classification model (FunASR's ct-punc) rather than a
# generative one: it predicts one punctuation mark per input word rather than
# rewriting the text, so it can't drop, add, or reword anything -- the
# word-preservation check below is a safety net, not the primary defense.
# This runs as a *second*, optional background pass after the video is
# already marked ready with its raw cues, and quietly upgrades the cached
# .srt in place if it succeeds; the existing no-cache polling picks up the
# new content the same way it already does for progressive MKV extraction.

_ct_punc_model_cache = "not_loaded"  # sentinel distinct from "tried, got None"
_ct_punc_lock = threading.Lock()


def _ct_punc_model():
    """Resolved lazily and cached: most videos already have punctuated
    subtitles and never need this, so most sessions should never pay for the
    load (and possible first-run model download).

    Double-checked locking: two videos hitting unpunctuated auto-captions
    close together shouldn't each trigger their own concurrent load of the
    model into separate memory.
    """
    global _ct_punc_model_cache
    if _ct_punc_model_cache != "not_loaded":
        return _ct_punc_model_cache
    with _ct_punc_lock:
        if _ct_punc_model_cache == "not_loaded":
            try:
                from funasr import AutoModel
                _ct_punc_model_cache = AutoModel(model="ct-punc")
            except Exception:
                _ct_punc_model_cache = None
    return _ct_punc_model_cache


# Built from an explicit character list via re.escape rather than a literal
# character-class string: that string has to hold ', ", and ] all at once,
# and hand-escaping all three inside a regex character class is exactly the
# kind of thing that's easy to get subtly wrong (an earlier version did).
_PUNCTUATE_TRAILING_CHARS = list('.!?,;:"\')]')
_PUNCTUATE_STRIP_RE = re.compile(
    "[" + "".join(re.escape(c) for c in _PUNCTUATE_TRAILING_CHARS) + "]+$")

# Cuts always fall on a whole-cue boundary (see _chunk_cues), so this isn't
# defending against a model token limit -- ct-punc processes internally in
# its own ~20-word windows with cross-window context, there's no external
# ceiling to guess at. It only bounds how much of the track one failed
# chunk's validation can affect, and how fine-grained progress reporting is.
PUNCTUATE_CHUNK_WORDS = 260


def _chunk_cues(cues, target_words):
    """Group whole source cues into chunks of about `target_words` words
    each. Cuts always fall on a cue boundary, never mid-cue -- a YouTube
    caption line is only 7-10 words, so this is barely coarser than cutting
    by word count, and what it buys back matters: when a chunk fails
    validation (see punctuate_with_funasr), the fallback is that chunk's own
    original cues, completely unmodified.
    """
    chunks: list[list[tuple[int, int, str]]] = []
    current: list[tuple[int, int, str]] = []
    current_words = 0
    for cue in cues:
        n = len(cue[2].split())
        if current and current_words + n > target_words:
            chunks.append(current)
            current, current_words = [], 0
        current.append(cue)
        current_words += n
    if current:
        chunks.append(current)
    return chunks


# ct-punc's own tokenizer mangles all sorts of real-transcript tokens in
# ways that break the strict 1:1 word correspondence this validation needs --
# found by running this against real, messy auto-caption transcripts, where
# it silently failed validation on whole chunks over and over, each time for
# a different kind of token: plain numbers split into digit groups ("2020"
# -> "202" "0"), hyphenated compounds split on every hyphen ("off-the-shelf"
# -> "off-" "the-" "shelf"), YouTube's own non-speech markers shredded into
# single-letter fragments ("[Music]" -> "M" "usi" "c"), a domain name split
# on its dot ("brilliant.org" -> "brilliant" "." "org"), and a bare currency
# symbol fused onto a neighboring word with no space at all ("missing €800"
# -> "missing€800", silently swallowing a word boundary). Rather than
# keep discovering and special-casing one more punctuation-adjacent
# character at a time, anything other than a plain letter or apostrophe
# counts as risky and gets swapped for an inert placeholder before the model
# ever sees it; the model still gets to decide what punctuation belongs
# around that position (from the surrounding real words), it just never has
# to tokenize the risky word itself, so the count-preserving guarantee from
# ct-punc's own per-word design (see the module docstring above) actually
# holds.
_RISKY_TOKEN_RE = re.compile(r"[^A-Za-z']")
_PLACEHOLDER = "placeholder"


def _punctuate_chunk(words):
    """One chunk through the model. Returns None on any failure -- the model
    being unavailable, a crash, or (this is the important one) the response
    not being a word-for-word match for the input -- so the caller can fall
    back to leaving that stretch unpunctuated instead of trusting a response
    that may have silently dropped, added, or reworded something."""
    model = _ct_punc_model()
    if not model:
        return None

    # Stripped of any pre-existing punctuation before sending: a track flagged
    # "unpunctuated" overall (by cue-level density, see is_unpunctuated) can
    # still have a handful of cues with stray leftover punctuation, and
    # feeding the model text that's already partly punctuated makes it stack
    # its own prediction on top instead of cleanly replacing it.
    originals = [_PUNCTUATE_STRIP_RE.sub("", w[2]) for w in words]
    risky = [bool(_RISKY_TOKEN_RE.search(t)) for t in originals]
    tokens = [_PLACEHOLDER if r else t for t, r in zip(originals, risky)]

    try:
        with _ct_punc_lock:
            result = model.generate(input=" ".join(tokens))
        out_text = result[0]["text"]
    except Exception:
        return None

    out_tokens = out_text.split()
    if len(out_tokens) != len(tokens):
        return None

    produced = []
    for original, is_risky, sent in zip(originals, risky, out_tokens):
        if is_risky:
            # Keep the real word untouched, just carry over whatever
            # trailing punctuation the model attached after the placeholder
            # standing in for it.
            if not sent.lower().startswith(_PLACEHOLDER):
                return None
            suffix = sent[len(_PLACEHOLDER):]
            if not re.fullmatch(r'''[.!?,;:"')\]]*''', suffix):
                return None  # something unexpected happened to the placeholder itself
            produced.append(original + suffix)
        else:
            # Case-insensitive, and only the punctuation this pass is allowed
            # to add is stripped before comparing -- so a response that
            # changed a word, merged two words together, or reordered
            # anything fails validation rather than being silently trusted.
            if original.lower() != _PUNCTUATE_STRIP_RE.sub("", sent).lower():
                return None
            produced.append(sent)

    return [(s, e, p) for (s, e, _), p in zip(words, produced)]


def punctuate_with_funasr(cues, on_chunk=None, word_stream=None):
    """Restore punctuation to an unpunctuated track via the local ct-punc
    model, one chunk of whole cues at a time. Returns a list of
    (start_ms, end_ms, text) cues ready to write out directly, or None if the
    model is unavailable or every chunk failed -- in which case the caller
    keeps what it already has rather than replacing a working file with an
    empty one.

    `word_stream` -- the real per-word timing saved alongside the .srt when
    it came from clean_auto_captions -- is sliced per chunk and handed to
    words_from_cues, so the cues this produces land on real speech timing
    instead of words_from_cues' own interpolation fallback. Slicing by
    running word count works because _chunk_cues only ever cuts on whole-cue
    boundaries, so a chunk's words are always a contiguous run of the same
    stream this was built from.

    A chunk that fails validation contributes its own original cues,
    untouched, rather than aborting the whole video or recutting its
    fallback words with the same weak pause/length heuristic that produces
    long, awkward cards when there's no real punctuation to cut on -- a
    failed chunk can only ever leave that stretch exactly as good as it
    already was, never worse.

    Sequential, not concurrent: this is local CPU/GPU inference, not a
    network round trip, so there's no latency to hide behind a thread pool --
    and it avoids hammering one loaded model instance from multiple threads
    at once (see _ct_punc_lock).
    """
    if not _ct_punc_model() or not cues:
        return None

    chunks = _chunk_cues(cues, PUNCTUATE_CHUNK_WORDS)
    out: list[tuple[int, int, str]] = []
    any_succeeded = False
    offset = 0
    for i, chunk in enumerate(chunks, 1):
        chunk_word_count = sum(len(c[2].split()) for c in chunk)
        chunk_stream = (word_stream[offset:offset + chunk_word_count]
                        if word_stream is not None else None)
        offset += chunk_word_count

        punctuated_words = _punctuate_chunk(words_from_cues(chunk, word_stream=chunk_stream))
        if punctuated_words is not None:
            out.extend(cut_words_into_cues(punctuated_words))
            any_succeeded = True
        else:
            out.extend(chunk)
        if on_chunk:
            on_chunk(i, len(chunks))
    return out if any_succeeded else None


# A thread per auto-caption video (the original design) turns into an
# ever-growing pile-up under completely normal use: browsing YouTube's
# recommendations hits a new auto-caption video every couple of minutes,
# each polish pass takes 40-60s+, and every one of them serializes on the
# same loaded model -- so after a session of hopping through a dozen
# videos, whichever one is open *right now* can be sitting behind several
# minutes of queued work for videos nobody's watching anymore. A single
# persistent worker with a one-slot mailbox fixes this: only the most
# recently requested video is ever waiting, so a request superseded before
# the worker even got to it is dropped instead of wastefully processed.
_polish_pending: Path | None = None
_polish_active: Path | None = None
_polish_lock = threading.Lock()
_polish_wakeup = threading.Event()
_polish_worker_started = False


def is_polishing(path: Path) -> bool:
    """Whether `path` (the placeholder, any sibling, or the base itself) has
    an outstanding punctuation-restoration job -- queued or actively
    running. Purely informational (for a "still improving this" hint in the
    UI); nothing depends on it for correctness."""
    base = path.with_suffix("") if path.suffix == ".strm" else path
    with _polish_lock:
        return base == _polish_pending or base == _polish_active


def _polish_worker() -> None:
    global _polish_pending, _polish_active
    while True:
        _polish_wakeup.wait()
        with _polish_lock:
            base = _polish_pending
            _polish_pending = None
            _polish_active = base
            _polish_wakeup.clear()
        if base is not None:
            polish_auto_captions_in_background(base)
        with _polish_lock:
            _polish_active = None


def request_polish(base: Path) -> None:
    """Queue `base` for punctuation restoration, replacing whatever was
    queued before -- see the module comment above for why this isn't just
    a thread per call."""
    global _polish_pending, _polish_worker_started
    with _polish_lock:
        _polish_pending = base
        _polish_wakeup.set()
        if not _polish_worker_started:
            _polish_worker_started = True
            threading.Thread(target=_polish_worker, daemon=True).start()


def polish_auto_captions_in_background(base: Path) -> None:
    """Best-effort second pass: if the .srt this video ended up with has no
    real punctuation, try to restore it and recut into sentences, then swap
    it in. Never raises -- this runs fire-and-forget after the video is
    already marked ready, and a failure here should leave the already-working
    subtitle file exactly as it was, not break it.
    """
    try:
        srt = _english_subtitle(base)
        if not srt:
            return
        cues = subs_now.parse_cues(srt)
        if not is_unpunctuated(cues):
            return

        _set_stage(base, "!正在加载标点模型…")

        def report(done, total):
            _set_stage(base, "!正在优化字幕断句 (%d/%d)" % (done, total))
            # The leading "!" above is subtitle_status's error marker, reused
            # here as a lightweight "still working" note rather than adding a
            # third state -- see subtitle_status. It is overwritten as soon
            # as this finishes, one way or the other.

        # Real per-word timing from the original vtt, if the auto-caption
        # fetch that produced this .srt saved one (see clean_auto_captions /
        # _fetch_auto_captions) -- lets the recut below land cues on actual
        # speech timing instead of words_from_cues' interpolation fallback.
        word_stream = load_word_stream(srt)
        cues = punctuate_with_funasr(cues, on_chunk=report, word_stream=word_stream)
        if cues is None:
            _set_stage(base, None)
            return

        # punctuate_with_funasr already returns finished (start, end, text)
        # cues -- successful chunks cut into sentences, failed ones passed
        # through as their own original cues -- so there's nothing left to
        # recut here.
        tmp = srt.with_suffix(".polish.tmp")
        write_srt(cues, tmp)
        os.replace(tmp, srt)  # atomic: a concurrent reader sees old or new, never partial
    except Exception:
        pass
    finally:
        _set_stage(base, None)


# Subtitle fetching costs ~12s of network round trips after the metadata is
# known, and none of it has to happen before playback can start. Videos are
# registered as soon as their title is known and the subtitles land later,
# so the state of an in-flight fetch has to be readable from the request
# handlers -- same split the MKV extraction already uses.
_fetch_lock = threading.Lock()
_fetch_states: dict[str, str] = {}  # base name -> stage text, or an error
# base name -> time.monotonic() of its last failure. Separate from
# _fetch_states (whose error text ensure_current below has no reason to
# parse) and checked there to stop a video with no subtitles available from
# being silently re-fetched from scratch every single time it's reported as
# current again -- which, for a video the extension reports on every SPA
# navigation to it, used to mean every re-visit (or even just switching away
# and back) kicked off a fresh yt-dlp round trip for a result already known
# to fail, no better the second time than the first.
_fetch_failed_at: dict[str, float] = {}
RETRY_COOLDOWN_S = 600  # 10 minutes -- long enough that idle re-navigation stops re-triggering it, short enough that a transient failure (rate limiting, a network blip) isn't stuck until the process restarts.


def _set_stage(base: Path, stage: str | None) -> None:
    with _fetch_lock:
        if stage is None:
            _fetch_states.pop(base.name, None)
            _fetch_failed_at.pop(base.name, None)
        else:
            _fetch_states[base.name] = stage
            if stage.startswith("!"):
                _fetch_failed_at[base.name] = time.monotonic()


def _recently_failed(base: Path) -> bool:
    with _fetch_lock:
        failed_at = _fetch_failed_at.get(base.name)
    return failed_at is not None and time.monotonic() - failed_at < RETRY_COOLDOWN_S


def subtitle_status(path: Path) -> tuple[str, str]:
    """(state, detail) for a cached video, where state is "ready",
    "fetching" or "error". `path` is the placeholder, any sibling, or the
    base itself."""
    base = path.with_suffix("") if path.suffix == ".strm" else path
    if _english_subtitle(base):
        return "ready", ""
    with _fetch_lock:
        stage = _fetch_states.get(base.name)
    if stage is None:
        return "error", "字幕还没开始抓取"
    if stage.startswith("!"):
        return "error", stage[1:]
    return "fetching", stage



def safe_base_name(title: str, video_id: str) -> str:
    """Filename stem for a video, sanitized for Windows.

    The id is kept in the name because titles collide and get edited, while
    the id is what the embedded player actually needs.
    """
    title = ILLEGAL_CHARS_RE.sub("_", title).strip(". ")
    # Leave room for the longest suffix this writes (".en.words.json") inside
    # the 255-char limit, and don't let a trailing space sneak back in.
    title = title[:150].strip() or "video"
    return f"{title} [{video_id}]"


def _siblings(base: Path, suffix: str = "") -> list[Path]:
    """Files named `<base>.<something><suffix>`, found by string prefix.

    Deliberately not Path.glob: the base name ends in `[<video id>]`, and glob
    reads `[...]` as a character class, so the pattern would quietly match
    nothing at all.
    """
    prefix = base.name + "."
    return sorted(
        f for f in base.parent.iterdir()
        if f.name.startswith(prefix) and f.name.endswith(suffix)
    )


def _english_subtitle(base: Path) -> Path | None:
    """Any English .srt yt-dlp produced for this base name.

    The tag varies -- en, en-US, en-GB, en-orig -- so this matches the family
    rather than one exact filename.
    """
    for f in _siblings(base, ".srt"):
        tag = f.name[len(base.name) + 1:-4].lower()
        if tag == "en" or tag.startswith("en-") or tag.startswith("en."):
            return f
    return None


# ---- caption tracks via youtube-transcript-api ----------------------------
#
# Subtitles deliberately do *not* go through yt-dlp. yt-dlp is built to reach
# playable media, so it drives YouTube's full player API -- which now means a
# JS "n challenge" (needing a JS runtime), and, for anything authenticated, a
# Proof-of-Origin token it cannot mint. Measured on this machine, same moment,
# same videos: yt-dlp was refused ("Sign in to confirm you're not a bot")
# while these plain timedtext requests returned full transcripts.
#
# None of that machinery was ever wanted here -- this project only reads
# caption tracks and never downloads a single frame of video, so the whole
# player-API gauntlet was a toll being paid for nothing. Going straight at
# the caption endpoint drops the JS runtime, the remote solver script and the
# cookie handling along with it.
#
# Still an undocumented endpoint that YouTube can change without notice, same
# as yt-dlp's own extractors -- the tradeoff is a much smaller surface, not a
# supported one.


def _caption_tracks(video_id: str):
    """Real caption tracks for a video, or [] if the library isn't installed.

    Machine-translated variants are deliberately absent: the API lists only
    tracks that genuinely exist (a 16-language translation menu shows up as
    `translation_languages` on each track, reachable only by explicitly
    asking to translate, which nothing here does). That distinction is the
    whole point -- an auto-caption *translated* into English from another
    language is a machine translation of a machine transcription, no longer
    matching what is actually being said, and worthless for listening
    practice in a way that is not obvious from looking at it.
    """
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        return []
    try:
        return list(YouTubeTranscriptApi().list(video_id))
    except Exception:
        # No captions at all, video unavailable, network refusal -- all of
        # which mean the same thing to every caller: nothing to work with.
        return []


def _pick_track(tracks, lang_prefixes: tuple[str, ...], generated: bool):
    for track in tracks:
        code = (track.language_code or "").lower()
        if track.is_generated == generated and code.startswith(lang_prefixes):
            return track
    return None


def _track_vtt(track) -> str:
    """The track's raw vtt, which is the only form carrying the inline
    per-word timestamps (`<00:00:02.520><c> Americans</c>`) that
    clean_auto_captions rebuilds rolling captions from -- and that the
    word-by-word highlight is then built on. The library's own fetch()
    returns text already flattened to one string per cue, losing them.

    Reaches for the resolved URL the library worked out, which is private
    API: a URL scraped independently comes back 200 with an empty body,
    tested directly, so what matters is that this one was obtained the way
    the library obtains it. Callers treat a failure here as "no word timings
    available" rather than "no subtitles".
    """
    response = requests.get(
        track._url + "&fmt=vtt",
        headers={"User-Agent": _CAPTION_UA, "Accept-Language": "en-US"},
        timeout=60,
    )
    response.raise_for_status()
    return response.text


_CAPTION_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")


def _video_id_from_url(url: str) -> str:
    return urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("v", [""])[0]


def _snippets_to_cues(track) -> list[tuple[int, int, str]]:
    """A track's own fetch(), as (start_ms, end_ms, text) cues.

    Used for tracks where the raw vtt buys nothing: human-written subtitles
    are already whole lines with real punctuation, and the second language
    is only ever read as a block of text under the English.
    """
    cues = []
    for snippet in track.fetch():
        text = " ".join(snippet.text.split())
        if not text:
            continue
        start = int(snippet.start * 1000)
        cues.append((start, start + int(snippet.duration * 1000), text))
    return cues


def _write_manual_english(base: Path, tracks) -> Path | None:
    track = _pick_track(tracks, ("en",), generated=False)
    if not track:
        return None
    cues = _snippets_to_cues(track)
    if not cues:
        return None
    srt = base.with_name(f"{base.name}.en.srt")
    write_srt(cues, srt)
    return srt


def _write_secondary(base: Path, tracks) -> None:
    """The 副字幕 track, if this video happens to have a human-written one.

    Generated ones are skipped on purpose: a Chinese auto-caption on an
    English video can only be a machine translation of a machine
    transcription, which is exactly the thing the English side already
    refuses (see _caption_tracks).
    """
    try:
        track = _pick_track(tracks, SECONDARY_PREFIXES, generated=False)
        if not track:
            return
        cues = _snippets_to_cues(track)
        if cues:
            write_srt(cues, base.with_name(f"{base.name}.{track.language_code}.srt"))
    except Exception:
        pass  # an optional extra; never worth failing the English track over


def _fetch_auto_captions(base: Path, tracks, on_stage=None) -> Path | None:
    """Auto captions, repaired, written out as an ordinary .srt sidecar.

    Only an English track generated *for this video's own audio* counts --
    see _caption_tracks for why a translated one would be worse than none.
    """
    def stage(text):
        if on_stage:
            on_stage(text)

    track = _pick_track(tracks, ("en",), generated=True)
    if not track:
        return None

    stage("正在下载自动字幕")
    vtt = base.with_name(f"{base.name}.en-orig.vtt")
    vtt.write_text(_track_vtt(track), encoding="utf-8")

    stage("正在整理字幕")
    try:
        cues, word_stream = clean_auto_captions(vtt)
    finally:
        # .vtt is itself a subtitle extension, so a leftover would be picked
        # up by the sidecar scan ahead of the cleaned file.
        vtt.unlink(missing_ok=True)
    if not cues:
        return None

    srt = base.with_name(f"{base.name}.en.srt")
    write_srt(cues, srt)
    # Real per-word timing, saved alongside the .srt so a later pass --
    # punctuation restoration recutting sentences, or the word-by-word
    # highlight -- can reuse it instead of re-parsing the (by then deleted)
    # raw vtt. See load_word_stream / clean_auto_captions.
    save_word_stream(srt, word_stream)
    return srt


def _fetch_subtitles(base: Path, url: str) -> None:
    """The slow half of add(), run on its own thread.

    Prefers human-written subtitles and falls back to repaired auto-captions.
    Failure is recorded rather than raised: by the time this runs the caller
    is long gone and the video is already on screen.
    """
    try:
        _set_stage(base, "正在查可用字幕")
        # One listing serves every branch below -- the English track (human
        # or generated) and the optional second language all come out of it,
        # where the yt-dlp version needed a separate run per kind.
        tracks = _caption_tracks(_video_id_from_url(url))

        _set_stage(base, "正在找人工字幕")
        subtitle, kind = _write_manual_english(base, tracks), "manual"
        if not subtitle:
            _set_stage(base, "没有人工字幕，正在抓自动字幕")
            subtitle = _fetch_auto_captions(
                base, tracks, on_stage=lambda text: _set_stage(base, text))
            kind = "auto"

        # Best-effort and deliberately after English is settled: the second
        # language is an optional reading aid, and a video having none is
        # normal rather than a failure worth reporting.
        _write_secondary(base, tracks)

        if not subtitle:
            _set_stage(base, "!这个视频没有可用的英文字幕（既没有人工字幕，也没有英文原声的自动字幕）。")
            return

        marker = base.with_name(f"{base.name}.tutor.json")
        meta = {}
        if marker.exists():
            try:
                meta = json.loads(marker.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                pass
        meta["subtitle_kind"] = kind
        marker.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

        _set_stage(base, None)
        if kind == "auto":
            # Human-written subs already have real punctuation; only the
            # auto-caption fallback ever needs this. Fires after the ready
            # signal above so it never delays subtitles being usable --
            # polish_auto_captions_in_background re-checks is_unpunctuated
            # itself and no-ops if this track turned out fine already.
            request_polish(base)
    except Exception as e:
        _set_stage(base, "!" + (str(e) or repr(e))[-300:])


def _register(video_id: str, title: str, duration: float, url: str) -> dict:
    """Registers a video and starts fetching its subtitles in the
    background, given an id/title the caller already knows (e.g. read
    straight off a youtube.com page) -- no yt-dlp probe round trip needed.

    Never downloads media. Returns as soon as the placeholder is on disk --
    the actual subtitle round trips continue in the background thread.
    Callers poll subtitle_status() (or just /api/subtitles) for the rest.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    base = CACHE_DIR / safe_base_name(title, video_id)

    # Clear this video's existing subtitle files first. Without it, adding a
    # video a second time finds the *previous* run's .srt sitting there, takes
    # it for a freshly downloaded human track, labels the result "manual" and
    # keeps the old content -- so a re-add, the obvious way to refresh a video
    # after a fix, is exactly the case that silently does nothing.
    for stale in _siblings(base, ".srt") + _siblings(base, ".vtt"):
        stale.unlink(missing_ok=True)

    placeholder = base.with_name(f"{base.name}.strm")
    placeholder.write_text(url, encoding="utf-8")
    # Written before the subtitles exist so the video can be listed and played
    # immediately. subtitle_kind is filled in by the thread once it knows.
    base.with_name(f"{base.name}.tutor.json").write_text(
        json.dumps({
            "id": video_id,
            "title": title,
            "duration": duration,
        }, ensure_ascii=False),
        encoding="utf-8")

    _set_stage(base, "正在找人工字幕")
    threading.Thread(target=_fetch_subtitles, args=(base, url), daemon=True).start()

    return {
        "id": video_id,
        "title": title,
        "duration": duration,
        "path": str(placeholder),
        "subtitle_kind": None,  # not known until the fetch finishes
    }


def ensure_current(video_id: str, title: str, url: str) -> dict:
    """Like _register(), but a no-op (beyond returning the existing path) if
    this video's subtitles are already cached.

    _register() always wipes and re-fetches, meant for an explicit one-time
    "add" action. This is for a caller that reports the same video
    repeatedly just by playing it (the youtube.com extension, on every SPA
    navigation to a video it may well have seen before) -- re-registering on
    every one of those would nuke a perfectly good cached .srt and kick off a
    pointless yt-dlp round trip each time.

    Same reasoning covers a video that has no cached .srt because the *last*
    attempt failed, not because none was ever made: without the
    _recently_failed check below, every re-navigation to it would retry
    immediately, indistinguishable from the success case above in how often
    it fires. Left unchecked that turns one bad video (no captions at all,
    or a transient block) into a source of repeated yt-dlp round trips for
    as long as it stays "current" -- exactly the kind of traffic that risks
    provoking the rate limiting it's often failing from in the first place.
    """
    base = CACHE_DIR / safe_base_name(title, video_id)
    if _english_subtitle(base):
        return {"id": video_id, "path": str(base.with_name(f"{base.name}.strm"))}
    placeholder = base.with_name(f"{base.name}.strm")
    if placeholder.exists() and _recently_failed(base):
        return {"id": video_id, "path": str(placeholder)}
    return _register(video_id, title, 0, url)


def is_cached_path(path: Path) -> bool:
    """Whether `path` is one of ours.

    The player reports which video it's on, and that value ends up in
    playback_state.json, which the MCP tools then read subtitles from. Without
    this check any client on the LAN could point the tutor at an arbitrary
    file on disk.
    """
    try:
        return path.resolve().parent == CACHE_DIR.resolve()
    except OSError:
        return False
