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

import html
import json
import os
import re
import shutil
import subprocess
import threading
import urllib.request
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


def write_srt(cues: list[tuple[int, int, str]], path: Path) -> None:
    path.write_text(
        "".join(
            f"{i}\n{_srt_clock(s)} --> {_srt_clock(e)}\n{t}\n\n"
            for i, (s, e, t) in enumerate(cues, 1)
        ),
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


def punctuate_with_funasr(cues, on_chunk=None):
    """Restore punctuation to an unpunctuated track via the local ct-punc
    model, one chunk of whole cues at a time. Returns a list of
    (start_ms, end_ms, text) cues ready to write out directly, or None if the
    model is unavailable or every chunk failed -- in which case the caller
    keeps what it already has rather than replacing a working file with an
    empty one.

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
    for i, chunk in enumerate(chunks, 1):
        punctuated_words = _punctuate_chunk(words_from_cues(chunk))
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

        cues = punctuate_with_funasr(cues, on_chunk=report)
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


def _run(args: list[str], on_line=None) -> str:
    """Run yt-dlp to completion and return its stdout.

    With `on_line`, output is streamed line by line as it arrives instead of
    being collected at the end, so a caller can narrate what's happening --
    see _friendly_stage for why that's worth the extra plumbing.
    """
    if on_line is None:
        result = subprocess.run(
            [_yt_dlp(), *args],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip()
            raise RuntimeError(detail[-600:] or f"yt-dlp 退出码 {result.returncode}")
        return result.stdout

    # stderr folded into stdout so the two can't interleave into a garbled
    # error message, and --newline so progress lines arrive as lines rather
    # than carriage-return redraws that would never terminate a read.
    proc = subprocess.Popen(
        [_yt_dlp(), *args, "--newline"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    lines = []
    for line in proc.stdout:
        line = line.rstrip()
        lines.append(line)
        on_line(line)
    if proc.wait() != 0:
        detail = "\n".join(lines).strip()
        raise RuntimeError(detail[-600:] or f"yt-dlp 退出码 {proc.returncode}")
    return "\n".join(lines)


# yt-dlp narrates itself on stdout -- "[youtube] <id>: Downloading webpage",
# "Downloading android vr player API JSON", and so on. Those lines are the
# only visible structure inside what is otherwise a single opaque ~5s wait,
# so they get translated into something worth showing rather than left to
# scroll past in a console nobody is looking at. Matched by substring
# because the exact wording varies with whichever player client yt-dlp picks
# on the day, and an unrecognized line simply leaves the last stage standing.
_YT_STAGE_TEXT = (
    ("downloading webpage", "正在打开视频页"),
    ("player api json", "正在解析播放信息"),
    ("player api", "正在解析播放信息"),
    ("downloading api json", "正在解析播放信息"),
    ("downloading m3u8", "正在解析播放信息"),
    ("downloading subtitles", "正在下载字幕"),
    ("writing video subtitles", "正在保存字幕"),
    ("converting subtitles", "正在转换字幕格式"),
    ("writing video metadata", "正在读取视频信息"),
)


def _friendly_stage(line: str) -> str | None:
    low = line.lower()
    for needle, text in _YT_STAGE_TEXT:
        if needle in low:
            return text
    return None


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


def _info_json(base: Path) -> Path:
    return base.with_name(f"{base.name}.info.json")


def _auto_caption_url(base: Path) -> str | None:
    """Direct URL of the en-orig auto-caption vtt, read out of the info.json
    the human-subtitle pass already wrote.

    This exists purely to skip a second yt-dlp run. Asking yt-dlp for auto
    captions separately means re-doing the entire page extraction -- the
    expensive part, measured at ~4.7s of the ~5s -- just to arrive at a URL
    the first pass already had in hand. Measured end to end: 12.6s for the
    two-run version against 7.2s going straight to the URL.
    """
    try:
        data = json.loads(_info_json(base).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    tracks = (data.get("automatic_captions") or {}).get("en-orig") or []
    for track in tracks:
        if track.get("ext") == "vtt" and track.get("url"):
            return track["url"]
    return None


def _download(url: str, dest: Path, on_progress=None) -> None:
    """Fetch `url` into `dest`, reporting (bytes_done, bytes_total) as it
    goes -- total is 0 when the server doesn't say."""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as response:
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        with dest.open("wb") as out:
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                if on_progress:
                    on_progress(done, total)


def _fetch_auto_captions(base: Path, url: str, on_stage=None) -> Path | None:
    """Auto captions, repaired, written out as an ordinary .srt sidecar.

    Only an `en-orig` track is requested, and its absence is taken as a
    refusal. That tag is YouTube's marker for "the original audio is
    English"; a plain `en` on a video spoken in another language is a machine
    translation of a machine transcription, which no longer corresponds to
    what is actually being said -- worthless for listening practice, and
    quietly so, which is worse.
    """
    def stage(text):
        if on_stage:
            on_stage(text)

    vtt = None
    direct = _auto_caption_url(base)
    if direct:
        candidate = base.with_name(f"{base.name}.en-orig.vtt")

        def progress(done, total):
            stage("正在下载自动字幕 %d%%" % (done * 100 // total) if total
                  else "正在下载自动字幕")

        try:
            _download(direct, candidate, progress)
            vtt = candidate
        except Exception:
            # A stale or rejected caption URL shouldn't cost the whole
            # fallback -- drop the partial file and take the slow path.
            candidate.unlink(missing_ok=True)

    if vtt is None:
        stage("正在抓自动字幕")

        def narrate(line):
            text = _friendly_stage(line)
            if text:
                stage(text)

        _run([
            "--skip-download",
            "--write-auto-subs",
            "--sub-langs", "en-orig",
            # No --convert-subs here on purpose: the per-word timestamps that
            # make the rolling-caption repair possible only exist in the raw
            # vtt, and the conversion flattens them away.
            "--no-warnings",
            "-o", f"{base}.%(ext)s",
            url,
        ], on_line=narrate)
        vtt = next(iter(_siblings(base, ".vtt")), None)

    if not vtt:
        return None
    stage("正在整理字幕")
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

        def narrate(line):
            text = _friendly_stage(line)
            if text:
                _set_stage(base, text)

        _run([
            "--skip-download",
            "--write-subs",           # human-written only; the fallback is below
            "--sub-langs", SUB_LANGS,
            "--convert-subs", "srt",  # YouTube serves vtt; srt is what parse_cues expects
            # Costs nothing measurable on top of the extraction this pass is
            # already doing, and carries the auto-caption URLs -- which is
            # what lets the fallback below skip a second extraction entirely.
            "--write-info-json",
            "--no-warnings",
            "-o", f"{base}.%(ext)s",
            url,
        ], on_line=narrate)

        subtitle, kind = _english_subtitle(base), "manual"
        if not subtitle:
            _set_stage(base, "没有人工字幕，正在抓自动字幕")
            subtitle = _fetch_auto_captions(
                base, url, on_stage=lambda text: _set_stage(base, text))
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
    finally:
        # Half a megabyte per video of metadata nothing downstream reads --
        # it's fetched only for the caption URLs in _auto_caption_url, and
        # those have been used by now one way or the other.
        _info_json(base).unlink(missing_ok=True)


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
    """
    base = CACHE_DIR / safe_base_name(title, video_id)
    if _english_subtitle(base):
        return {"id": video_id, "path": str(base.with_name(f"{base.name}.strm"))}
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
