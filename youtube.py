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

    Some Title [dQw4w9WgXcQ].strm       <- a few dozen bytes, holds the URL
    Some Title [dQw4w9WgXcQ].en.srt     <- the real payload
    Some Title [dQw4w9WgXcQ].info.json  <- title / duration / id

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

import concurrent.futures
import html
import json
import os
import random
import re
import shutil
import subprocess
import threading
from pathlib import Path

import app_config
import subs_now

# Defaults to <project>/youtube; set youtube_cache_dir in config.json to put
# it next to a media library instead. Resolved once at import, so a change to
# config.json takes effect on the next app.py start.
CACHE_DIR = app_config.youtube_cache_dir()

# English first because it's the one being studied; the Chinese variants feed
# the 副字幕 setting when a video happens to have them (most don't).
SUB_LANGS = "en.*,zh-Hans,zh-Hant,zh-CN,zh"

# Windows forbids these outright, and trailing dots/spaces get silently
# stripped by the filesystem -- which would leave the .srt and the placeholder
# with names that no longer match, breaking the sidecar lookup.
ILLEGAL_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


VTT_TIME_RE = re.compile(r"(\d{2}):(\d{2}):(\d{2})\.(\d{3})")
VTT_TAG_RE = re.compile(r"<[^>]*>")

# Rolling captions advance by emitting a ~10ms cue between real ones. They
# carry no new text, only the transition.
SPACER_MAX_MS = 30


def _vtt_ms(groups) -> int:
    h, m, sec, milli = groups
    return ((int(h) * 60 + int(m)) * 60 + int(sec)) * 1000 + int(milli)


def clean_auto_captions(vtt_path: Path) -> list[tuple[int, int, str]]:
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

    Per-word stamps are still read where present, because they date the line
    better than the block does: a block's own start is when the *previous*
    line was still on screen.
    """
    blocks = re.split(r"\n\s*\n", vtt_path.read_text(encoding="utf-8", errors="ignore").strip())
    cues: list[tuple[int, int, str]] = []
    previous_words: list[str] = []

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

        payload = lines[time_idx + 1:]
        timed = [l for l in payload if VTT_TIME_RE.search(l)]
        text = html.unescape(VTT_TAG_RE.sub("", " ".join(payload)))
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            continue

        words = text.split()
        overlap = min(len(previous_words), len(words))
        while overlap > 0 and previous_words[-overlap:] != words[:overlap]:
            overlap -= 1
        previous_words = words
        fresh = words[overlap:]
        if not fresh:
            continue

        inner = VTT_TIME_RE.findall(" ".join(timed)) if timed else []
        cues.append((min(_vtt_ms(inner[0]), end) if inner else start, end, " ".join(fresh)))

    return resegment_sentences(cues)



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


def resegment_sentences(cues: list[tuple[int, int, str]]) -> list[tuple[int, int, str]]:
    """Recut cues so each one is a sentence.

    Works on a word stream rather than by merging whole cues: a cue boundary
    frequently falls mid-sentence *and* a sentence frequently ends mid-cue, so
    merging alone can never produce clean sentences. Word times interpolated
    across a cue's span -- the exact per-word stamps exist only in the raw vtt,
    and evenly spacing them is off by a fraction of a second at worst, which is
    well inside the loop's own lead-in padding.

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
    return cut_words_into_cues(words_from_cues(cues))


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


def words_from_cues(cues: list[tuple[int, int, str]]) -> list[tuple[int, int, str]]:
    """Flatten cues into a word stream, one (start_ms, end_ms, word) per word.

    Word times are interpolated across each cue's span rather than read from
    per-word stamps -- those exist only in the raw vtt, and evenly spacing
    them is off by a fraction of a second at worst, well inside the loop's
    own lead-in padding. Shared by resegment_sentences and the AI punctuation
    pass below, which both need the same word-level view for different
    reasons (cutting on punctuation vs. sending chunks to the model).
    """
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


# ---- AI punctuation restoration ------------------------------------------
#
# is_unpunctuated tracks are left as raw per-line cues by resegment_sentences
# because there is no punctuation to cut on -- see that function's docstring.
# Those raw cues are already reasonable (source line breaks sit near phrase
# length), but a real sentence is better, and turning a word stream with no
# punctuation into one with correctly-placed punctuation is a task language
# models are good at. This runs as a *second*, optional background pass
# rather than inside the main fetch: measured on real chunks, a Haiku call
# over ~220-300 words takes 60-100s (see PUNCTUATE_CHUNK_WORDS below), and a
# ~20-minute video can carry 3000+ words -- tens of minutes total. Making the
# subtitle tab wait on that would trade an already-decent fallback for a
# blank progress screen for most of that time. Instead the fast path ships
# unchanged, and this quietly upgrades the cached .srt in place once it's
# done; the existing no-cache polling picks up the new content the same way
# it already does for progressive MKV extraction.
_claude_bin_cache: str | None = ""  # "" = not looked up yet, None = not found


def _claude_bin() -> str | None:
    """Resolved lazily and cached: most videos are already punctuated and
    never need this, so most sessions should never pay for the lookup."""
    global _claude_bin_cache
    if _claude_bin_cache == "":
        _claude_bin_cache = shutil.which("claude")
    return _claude_bin_cache


# claude -p with no tool access -- this is a pure text transformation, not an
# agent turn, so nothing here should be able to touch the filesystem or the
# network regardless of what the input text says.
_PUNCTUATE_DISALLOWED_TOOLS = (
    "Bash Edit Write NotebookEdit Agent WebSearch WebFetch Read Grep Glob"
)

# A prose-style "add punctuation to this text" is standard, fast generation.
# An earlier version asked for one word per line to make validation trivial;
# that alone made a 220-word chunk take 60-100s for reasons that didn't show
# up in a subprocess-overhead baseline (~13s), so it's something about that
# output shape specifically, not model or flag choice -- switched to prose
# and pay the small cost of tokenizing the response instead.
# Diagnosed on real output, not guessed: an earlier version of this prompt
# forbade merging words but didn't say how, and Haiku's idea of "not merging"
# still hyphenates a compound modifier ("last minute" -> "last-minute") and
# joins a repeated word with an em dash ("this this" -> "this—this") --
# both standard, correct English style, and both collapse two
# whitespace-separated input tokens into one output token. Validation splits
# on whitespace, so every one of those was scored as a dropped word and the
# whole chunk was rejected -- on one real failing chunk, both of its two
# actual discrepancies turned out to be exactly this, not lost content.
# Spelling out the specific forbidden move (not just "don't merge") is what
# fixes it, since the model wasn't disobeying "don't merge" -- it didn't
# think a hyphen counted.
_PUNCTUATE_SYSTEM_PROMPT = (
    "Non-interactive pipeline stage. Input is English speech with no "
    "punctuation, words space-separated. Output the exact same words in the "
    "exact same order, space-separated on one line, with sentence-ending "
    "punctuation and commas inserted where a fluent reader would place them, "
    "attached to the end of the relevant word. Never add/remove/reorder/"
    "merge/split any word, never change spelling or case. In particular: "
    "never join two of the input words together with a hyphen, en dash, or "
    "em dash, even where standard style would (a compound modifier like "
    "'last minute decision' must stay three separate space-separated words, "
    "not 'last-minute decision'; a repeated word like 'this this' stays two "
    "words, not 'this—this') -- every output word must be separated from its "
    "neighbors by whitespace and whitespace alone. Output only that one line "
    "-- no commentary, no heading, no code fence, no questions."
)

# Calibrated against real timing, not guessed: 220 words measured at 60-100s
# depending on phrasing. Chunking exists for two reasons beyond raw latency --
# it bounds how much of the video a single bad or hallucinated response can
# damage (rejected chunks below fall back to their original unpunctuated
# words rather than corrupting anything), and it lets progress be reported
# instead of one opaque multi-minute call.
PUNCTUATE_CHUNK_WORDS = 260
# Generous relative to the ~60-100s measured: covers a slow chunk without
# mistaking "still working" for "stuck".
PUNCTUATE_TIMEOUT_S = 150


def _chunk_cues(cues, target_words):
    """Group whole source cues into chunks of about `target_words` words
    each. Cuts always fall on a cue boundary, never mid-cue -- a YouTube
    caption line is only 7-10 words, so this is barely coarser than cutting
    by word count, and what it buys back matters: when a chunk fails
    validation (see punctuate_with_ai), the fallback is that chunk's own
    original cues, completely unmodified. That fallback is only as good as
    the source line breaks it's declining to replace *because* nothing here
    ever flattens a failed chunk into a word stream that would need to be
    re-cut by a weaker heuristic instead.
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


# Built from an explicit character list via re.escape rather than a literal
# character-class string: that string has to hold ', ", and ] all at once,
# and hand-escaping all three inside a regex character class is exactly the
# kind of thing that's easy to get subtly wrong (an earlier version did).
_PUNCTUATE_TRAILING_CHARS = list('.!?,;:"\')]')
_PUNCTUATE_STRIP_RE = re.compile(
    "[" + "".join(re.escape(c) for c in _PUNCTUATE_TRAILING_CHARS) + "]+$")


def _punctuate_chunk(words):
    """One chunk through the model. Returns None on any failure -- a timeout,
    a crash, or (this is the important one) the response not being a
    word-for-word match for the input -- so the caller can fall back to
    leaving that stretch unpunctuated instead of trusting a response that may
    have silently dropped, added, or reworded something."""
    claude_bin = _claude_bin()
    if not claude_bin:
        return None

    tokens = [w[2] for w in words]
    try:
        result = subprocess.run(
            [claude_bin, "-p", "--model", "haiku", "--effort", "low",
             "--append-system-prompt", _PUNCTUATE_SYSTEM_PROMPT,
             "--disallowedTools", _PUNCTUATE_DISALLOWED_TOOLS],
            input=" ".join(tokens),
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=PUNCTUATE_TIMEOUT_S,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if result.returncode != 0:
        return None

    out_tokens = result.stdout.split()
    if len(out_tokens) != len(tokens):
        return None
    # Case-insensitive, and only the punctuation this pass is allowed to add
    # is stripped before comparing -- so a response that changed a word,
    # merged two words together, or reordered anything fails validation
    # rather than being silently trusted.
    for original, produced in zip(tokens, out_tokens):
        if original.lower() != _PUNCTUATE_STRIP_RE.sub("", produced).lower():
            return None

    return [(s, e, produced) for (s, e, _), produced in zip(words, out_tokens)]


# How many `claude -p` subprocesses run at once. Each chunk is independent --
# no shared state, no filesystem writes inside _punctuate_chunk -- so nothing
# about correctness requires doing them one at a time; the first version did
# purely because a sequential loop was simpler to write, and it cost the
# obvious price: a 13-chunk video took ~15 minutes wall-clock, all of it
# waiting rather than working. Kept modest rather than "as many as there are
# chunks" since concurrent-request behavior under this account/session
# wasn't something to assume -- 4 is a starting point, not a measured ceiling.
PUNCTUATE_MAX_WORKERS = 4


def punctuate_with_ai(cues, on_chunk=None):
    """Restore punctuation to an unpunctuated track via the model, one chunk
    of whole cues at a time, chunks in flight concurrently. Returns a list of
    (start_ms, end_ms, text) cues ready to write out directly, or None if the
    model is unavailable or every chunk failed -- in which case the caller
    keeps what it already has rather than replacing a working file with an
    empty one.

    A chunk that fails validation contributes its own original cues,
    untouched, rather than aborting the whole video or -- the bug an earlier
    version had -- being flattened to words and recut by the same weak
    pause/length heuristic that produces long, awkward cards when there's no
    real punctuation to cut on. Measured on a real run: with two AI jobs
    competing for the same account at once, several chunks failed validation
    (plausibly just contention, not a correctness problem in the validation
    itself), and recutting their fallback words that way produced 40+ second
    cards -- worse than the original per-line cues the whole feature exists
    to improve on. Falling back to those original cues unmodified instead
    means a failed chunk can only ever leave that stretch exactly as good as
    it already was, never worse.
    """
    if not _claude_bin() or not cues:
        return None

    chunks = _chunk_cues(cues, PUNCTUATE_CHUNK_WORDS)
    chunk_words = [words_from_cues(c) for c in chunks]
    results: list[list[tuple[int, int, str]] | None] = [None] * len(chunks)
    completed = 0

    # Workers submitted up front and collected as they land, not chunk by
    # chunk: reassembly below re-sorts by original index anyway, so nothing
    # depends on completion order -- only on every submitted chunk finishing
    # before the reassembly reads its slot.
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=min(PUNCTUATE_MAX_WORKERS, len(chunks))
    ) as pool:
        future_to_index = {pool.submit(_punctuate_chunk, w): i for i, w in enumerate(chunk_words)}
        for future in concurrent.futures.as_completed(future_to_index):
            i = future_to_index[future]
            try:
                results[i] = future.result()
            except Exception:
                results[i] = None
            completed += 1
            if on_chunk:
                on_chunk(completed, len(chunks))

    out: list[tuple[int, int, str]] = []
    any_succeeded = False
    for original_cues, punctuated_words in zip(chunks, results):
        if punctuated_words is not None:
            out.extend(cut_words_into_cues(punctuated_words))
            any_succeeded = True
        else:
            out.extend(original_cues)
    return out if any_succeeded else None


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

        def report(done, total):
            _set_stage(base, "!AI 正在优化字幕断句 (%d/%d)" % (done, total))
            # The leading "!" above is subtitle_status's error marker, reused
            # here as a lightweight "still working" note rather than adding a
            # third state -- see subtitle_status. It is overwritten as soon
            # as this finishes, one way or the other.

        cues = punctuate_with_ai(cues, on_chunk=report)
        if cues is None:
            _set_stage(base, None)
            return

        # punctuate_with_ai already returns finished (start, end, text) cues
        # -- successful chunks cut into sentences, failed ones passed through
        # as their own original cues -- so there's nothing left to recut here.
        tmp = srt.with_suffix(".polish.tmp")
        write_srt(cues, tmp)
        os.replace(tmp, srt)  # atomic: a concurrent reader sees old or new, never partial
    except Exception:
        pass
    finally:
        _set_stage(base, None)


def write_srt(cues: list[tuple[int, int, str]], path: Path) -> None:
    path.write_text(
        "".join(
            f"{i}\n{_srt_clock(s)} --> {_srt_clock(e)}\n{t}\n\n"
            for i, (s, e, t) in enumerate(cues, 1)
        ),
        encoding="utf-8",
    )


# Subtitle fetching costs ~12s of network round trips after the metadata is
# known, and none of it has to happen before playback can start. Videos are
# registered as soon as their title is known and the subtitles land later,
# so the state of an in-flight fetch has to be readable from the request
# handlers -- same split the MKV extraction already uses.
_fetch_lock = threading.Lock()
_fetch_states: dict[str, str] = {}  # base name -> stage text, or an error


def _set_stage(base: Path, stage: str | None) -> None:
    with _fetch_lock:
        if stage is None:
            _fetch_states.pop(base.name, None)
        else:
            _fetch_states[base.name] = stage


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


def _yt_dlp() -> str:
    found = shutil.which("yt-dlp")
    if not found:
        raise RuntimeError("找不到 yt-dlp，确认它已安装并在 PATH 里（pip install yt-dlp）。")
    return found


def _run(args: list[str]) -> str:
    result = subprocess.run(
        [_yt_dlp(), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(detail[-600:] or f"yt-dlp 退出码 {result.returncode}")
    return result.stdout


def safe_base_name(title: str, video_id: str) -> str:
    """Filename stem for a video, sanitized for Windows.

    Built here rather than left to yt-dlp's own output template so the exact
    resulting path is known up front. Guessing it afterwards would mean
    globbing the directory and hoping the newest match is the right one.

    The id is kept in the name because titles collide and get edited, while
    the id is what the embedded player actually needs.
    """
    title = ILLEGAL_CHARS_RE.sub("_", title).strip(". ")
    # Leave room for the longest suffix this writes (".info.json") inside the
    # 255-char limit, and don't let a trailing space sneak back in.
    title = title[:150].strip() or "video"
    return f"{title} [{video_id}]"


def search(query: str, limit: int = 10) -> list[dict]:
    """Search YouTube by keyword, without an API key.

    yt-dlp's ytsearch: pseudo-URL scrapes YouTube's own search results, so
    this needs nothing beyond the yt-dlp dependency already required for
    everything else here -- no Google Cloud project, no separate quota to
    manage, no second credential for the user to go set up.

    --flat-playlist is what keeps this fast: a normal search extracts each
    result video individually (one full yt-dlp pass per result), while flat
    mode reads only what the search results page itself already carries.
    That's enough for a picker -- id, title, channel, duration, view count --
    just not a thumbnail URL, which flat mode leaves blank. Built instead
    from the video id via YouTube's own stable, unauthenticated thumbnail
    CDN convention, rather than paying for a second extraction pass per
    result just to get back a URL this predictable.
    """
    out = _run([
        "--flat-playlist", "--skip-download", "--no-warnings", "--dump-json",
        f"ytsearch{limit}:{query}",
    ])
    results = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        video_id = d.get("id")
        if not video_id:
            continue
        results.append({
            "id": video_id,
            "title": d.get("title") or "(无标题)",
            "channel": d.get("channel") or d.get("uploader") or "",
            "duration": d.get("duration") or 0,
            "view_count": d.get("view_count") or 0,
            "thumbnail": f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg",
        })
    return results


# A homepage-like feed without a real account: YouTube's actual algorithm
# needs one, and this project has no access to the user's. The old logged-out
# Trending feed (a plausible substitute) is gone -- yt-dlp confirms the URL
# now just redirects to the homepage -- so this rolls its own out of the same
# search() this module already has, seeded with topics picked for what this
# project actually needs (spoken, likely-captioned English), not general
# popularity. That bias is deliberate: the hit-rate numbers measured earlier
# (TED 6/6, English lessons 2/6, podcasts 1/6, gaming 0/6) are exactly why a
# real "trending" feed would be a worse fit here, dominated by music videos
# and gaming clips with poor or no caption coverage.
DISCOVER_TOPICS = [
    "TED talk", "documentary explained", "news explained",
    "podcast interview", "science explained", "history explained",
    "life advice talk", "interesting facts", "how things work",
    "true crime story", "psychology explained", "tech review",
]

# Generous relative to a single search() call (~2-4s measured): covers a slow
# one without a stuck yt-dlp process hanging the whole feed, since this now
# runs automatically on page load rather than only after a deliberate search.
DISCOVER_TOPIC_TIMEOUT_S = 15


def discover(limit: int = 12) -> list[dict]:
    """A shuffled grid of videos across a random subset of topics, searched
    in parallel. "Refresh" is just calling this again -- a new random subset
    of topics (and YouTube's own search ranking, which isn't static either)
    is what makes each call turn up a different batch, without this having
    to track any state about what was shown before.
    """
    chosen = random.sample(DISCOVER_TOPICS, k=min(4, len(DISCOVER_TOPICS)))
    per_topic = limit // len(chosen) + 2  # headroom: dedup below can only shrink this

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(chosen)) as pool:
        futures = [pool.submit(search, topic, per_topic) for topic in chosen]
        for f in futures:
            try:
                # One topic's search failing or hanging shouldn't blank the
                # whole feed -- the other topics still fill it in.
                results.extend(f.result(timeout=DISCOVER_TOPIC_TIMEOUT_S))
            except Exception:
                pass

    random.shuffle(results)
    seen = set()
    deduped = []
    for r in results:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        deduped.append(r)
    return deduped[:limit]


def probe(url: str) -> dict:
    """Title / id / duration, without writing anything."""
    out = _run(["--skip-download", "--no-warnings",
                "--print", "%(id)s", "--print", "%(title)s", "--print", "%(duration)s",
                url])
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    if len(lines) < 2:
        raise RuntimeError(f"读不出视频信息：{out.strip()[:300]}")
    video_id, title = lines[0], lines[1]
    try:
        duration = float(lines[2])
    except (IndexError, ValueError):
        duration = 0.0
    return {"id": video_id, "title": title, "duration": duration}


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


def _fetch_auto_captions(base: Path, url: str) -> Path | None:
    """Auto captions, repaired, written out as an ordinary .srt sidecar.

    Only an `en-orig` track is requested, and its absence is taken as a
    refusal. That tag is YouTube's marker for "the original audio is
    English"; a plain `en` on a video spoken in another language is a machine
    translation of a machine transcription, which no longer corresponds to
    what is actually being said -- worthless for listening practice, and
    quietly so, which is worse.
    """
    _run([
        "--skip-download",
        "--write-auto-subs",
        "--sub-langs", "en-orig",
        # No --convert-subs here on purpose: the per-word timestamps that make
        # the rolling-caption repair possible only exist in the raw vtt, and
        # the conversion flattens them away.
        "--no-warnings",
        "-o", f"{base}.%(ext)s",
        url,
    ])

    vtt = next(iter(_siblings(base, ".vtt")), None)
    if not vtt:
        return None
    try:
        cues = clean_auto_captions(vtt)
    finally:
        # .vtt is itself a subtitle extension, so a leftover would be picked
        # up by the sidecar scan ahead of the cleaned file.
        vtt.unlink(missing_ok=True)
    if not cues:
        return None

    srt = base.with_name(f"{base.name}.en.srt")
    write_srt(cues, srt)
    return srt


def _fetch_subtitles(base: Path, url: str) -> None:
    """The slow half of add(), run on its own thread.

    Prefers human-written subtitles and falls back to repaired auto-captions.
    Failure is recorded rather than raised: by the time this runs the caller
    is long gone and the video is already on screen.
    """
    try:
        _set_stage(base, "正在找人工字幕")
        _run([
            "--skip-download",
            "--write-subs",           # human-written only; the fallback is below
            "--sub-langs", SUB_LANGS,
            "--convert-subs", "srt",  # YouTube serves vtt; srt is what parse_cues expects
            "--no-warnings",
            "-o", f"{base}.%(ext)s",
            url,
        ])

        subtitle, kind = _english_subtitle(base), "manual"
        if not subtitle:
            _set_stage(base, "没有人工字幕，正在抓自动字幕")
            subtitle = _fetch_auto_captions(base, url)
            kind = "auto"

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

        # AI punctuation restoration (polish_auto_captions_in_background,
        # below) is built but deliberately not wired in here. On a real,
        # uncontended run it only punctuated ~12% of a genuinely unpunctuated
        # video -- most chunks failed the strict word-preservation check --
        # and switching the model behind it to Kimi in instant mode traded
        # that for real content drift (a dropped word, a silently "corrected"
        # spelling) instead of the earlier merge/split false positives. Not
        # worth the background Claude usage it would otherwise spend on every
        # future unpunctuated auto-caption video for that little benefit.
        # The raw per-line cues this falls back to are already reasonable
        # (see resegment_sentences) -- this was chasing an improvement on
        # top of an already-working baseline, not fixing something broken.
        _set_stage(base, None)
    except Exception as e:
        _set_stage(base, "!" + (str(e) or repr(e))[-300:])


def add(url: str) -> dict:
    """Register a video and start fetching its subtitles in the background.

    Never downloads media. Returns as soon as the title is known -- roughly a
    quarter of the total work -- because the remaining ~12s of subtitle round
    trips is time the video could already be playing. Callers poll
    subtitle_status() (or just /api/subtitles) for the rest.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    info = probe(url)
    base = CACHE_DIR / safe_base_name(info["title"], info["id"])

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
            "id": info["id"],
            "title": info["title"],
            "duration": info["duration"],
        }, ensure_ascii=False),
        encoding="utf-8")

    _set_stage(base, "正在找人工字幕")
    threading.Thread(target=_fetch_subtitles, args=(base, url), daemon=True).start()

    return {
        "id": info["id"],
        "title": info["title"],
        "duration": info["duration"],
        "path": str(placeholder),
        "subtitle_kind": None,  # not known until the fetch finishes
    }


def list_videos() -> list[dict]:
    """Everything added so far, newest first."""
    if not CACHE_DIR.exists():
        return []
    items = []
    for strm in CACHE_DIR.glob("*.strm"):
        base = strm.with_suffix("")
        title, duration, kind = base.name, 0.0, None
        marker = base.with_name(f"{base.name}.tutor.json")
        if marker.exists():
            try:
                meta = json.loads(marker.read_text(encoding="utf-8"))
                title = meta.get("title") or title
                duration = float(meta.get("duration") or 0)
                kind = meta.get("subtitle_kind", kind)
            except (json.JSONDecodeError, OSError, ValueError):
                pass  # the filename still carries a usable title
        items.append({
            "id": video_id_for(strm),
            "title": title,
            "duration": duration,
            "path": str(strm),
            "subtitle_kind": kind,
            "has_secondary": any(
                f.name[len(base.name) + 1:].lower().startswith("zh")
                for f in _siblings(base, ".srt")
            ),
        })
    items.sort(key=lambda i: Path(i["path"]).stat().st_mtime, reverse=True)
    return items


def video_id_for(path: Path) -> str | None:
    """The YouTube id, read back out of the `[id]` suffix in the filename."""
    match = re.search(r"\[([A-Za-z0-9_-]{6,})\]$", path.with_suffix("").name)
    return match.group(1) if match else None


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
