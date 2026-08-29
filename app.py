"""
Backend for the English tutor panel that gets injected into Jellyfin's web UI.

Playback itself is entirely Jellyfin's job -- it browses F:\\电视剧, and streams
to the browser (Direct Stream: the 4K HEVC video is passed through untouched
and only the EAC3 audio gets converted, since Chrome can hardware-decode
HEVC Main10 here but has no EAC3 or MKV support). This process never touches
video.

What it does own: the tutor features beside the player -- chat with Claude
about what's on screen, the timestamped subtitle-card browser, and the vocab
notebook. The panel script runs inside Jellyfin's own page and reports
playback position here; everything else keys off that.

Run:
    python app.py
Then open Jellyfin at http://127.0.0.1:8096 -- the panel is injected there.
http://127.0.0.1:8420 also serves the same panel standalone, for using the
chat/vocab pages without a video open.
"""

import json
import mimetypes
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
# Ahead of every local import below, not just the block further down: uvicorn
# can be pointed at app:app from any working directory, and app_config is
# needed here at module level.
sys.path.insert(0, str(ROOT))

import app_config  # noqa: E402

MCP_CONFIG_FILE = app_config.MCP_CONFIG_FILE

# Windows' registry-backed mimetypes lookup often has no entry for these,
# which leaves StaticFiles falling back to application/octet-stream for
# static/fonts/*.woff2 -- browsers still load @font-face resources served
# that way, but there's no reason to rely on that leniency when the real
# type is one line to register.
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")


def write_mcp_config() -> None:
    """(Re)generate mcp_config.json from this file's own location.

    The Claude Code CLI needs an absolute path to mcp_server.py, which makes
    this file machine-specific and useless to commit -- a checked-in copy
    would point at whatever machine last wrote it. Generating it at startup
    means a fresh clone works with no setup step, and moving the project
    directory fixes itself on the next run.
    """
    MCP_CONFIG_FILE.write_text(json.dumps({
        "mcpServers": {
            "video-subtitles": {
                # sys.executable, not "python": inside a venv the bare name
                # may resolve to a different interpreter that doesn't have
                # this project's dependencies installed.
                "command": sys.executable,
                "args": [str(ROOT / "mcp_server.py")],
            }
        }
    }, ensure_ascii=False, indent=2), encoding="utf-8")


# At import, not in __main__: uvicorn can be pointed at app:app directly, and
# the config has to exist either way before the first chat turn spawns claude.
write_mcp_config()
VOCAB_FILE = app_config.VOCAB_FILE
PHRASES_FILE = app_config.PHRASES_FILE
DEEPSEEK_CONFIG_FILE = app_config.DEEPSEEK_CONFIG_FILE

import deepseek_chat  # noqa: E402
import dictionary  # noqa: E402
import indexer  # noqa: E402
import jellyfin  # noqa: E402
import knowledge  # noqa: E402
import playback  # noqa: E402
import scoring  # noqa: E402
import subs_now  # noqa: E402
import vocab_test  # noqa: E402
import youtube  # noqa: E402

# On Windows `claude` resolves to claude.cmd; subprocess.run() with a plain
# argv list won't find .cmd files via CreateProcess (no shell, no PATHEXT
# lookup), so resolve the real executable path up front via shutil.which.
CLAUDE_BIN = shutil.which("claude")
if not CLAUDE_BIN:
    raise RuntimeError("找不到 claude 命令，确认 Claude Code CLI 已安装并在 PATH 里。")

# The agent reaches playback and subtitles exclusively through the MCP tools
# in mcp_server.py -- not by us stuffing subtitle text into the prompt, and
# not by it poking around the filesystem. So: no filesystem tools, no shell,
# no editing, no sub-agents, no web access.
DISALLOWED_TOOLS = "Bash Edit Write NotebookEdit Agent WebSearch WebFetch Read Grep Glob"

# MCP tools must be pre-approved or a `-p` (non-interactive) session just
# fails with "you haven't granted it yet" -- there's no terminal to show a
# permission prompt on. These 4 are mcp_server.py's entire surface.
ALLOWED_TOOLS = (
    "mcp__video-subtitles__get_playback_status "
    "mcp__video-subtitles__get_subtitle_near_now "
    "mcp__video-subtitles__get_subtitle_range "
    "mcp__video-subtitles__search_subtitles "
    "mcp__video-subtitles__suggest_phrase"
)

TUTOR_AGENT_NAME = "lingocue"
TUTOR_SYSTEM_PROMPT = (
    "You are a friendly, precise English tutor helping a Chinese-speaking "
    "learner who is watching a show with English subtitles. You are NOT "
    "given subtitle text up front -- you have MCP tools (prefixed "
    "mcp__video-subtitles__) to look things up yourself, on demand: "
    "get_playback_status (what's playing, current position/duration), "
    "get_subtitle_near_now (subtitles in a recent window up to the current "
    "position -- use this by default for 'what did they just say' style "
    "questions), get_subtitle_range (subtitles for an explicit start/end "
    "time you choose), and search_subtitles (find a word/phrase anywhere in "
    "the episode by keyword). Call only what you actually need for the "
    "question -- don't call get_subtitle_range or search_subtitles for a "
    "huge span 'just in case'; start with get_subtitle_near_now (or "
    "get_playback_status if you don't even know the position yet) and widen "
    "only if that's not enough. Explain vocabulary, grammar points, idioms, "
    "phrasal verbs, and cultural/register nuance clearly. Mix Chinese "
    "explanation with English examples so the learner builds real "
    "intuition, not just translation. Quote short lines only, never long "
    "passages. Keep answers focused; don't pad with filler. When a subtitle "
    "line you're discussing has a genuinely useful multi-word phrase, "
    "collocation, idiom, or fixed expression worth remembering as a whole "
    "(not a single word -- that's a separate feature the user handles "
    "themselves), call suggest_phrase to offer saving it; don't call it for "
    "every phrase in a line, just the one(s) actually worth keeping, and "
    "don't ask permission first -- the user sees it as a save prompt and "
    "decides on their own."
)
AGENTS = {TUTOR_AGENT_NAME: {"description": "英语学习助手", "prompt": TUTOR_SYSTEM_PROMPT}}

app = FastAPI(title="LingoCue")

# The panel script runs on Jellyfin's origin (:8096) but calls this backend
# on :8420 -- different port means cross-origin, so without this every fetch
# from the injected panel fails.
#
# A regex rather than a fixed list because the origin depends on how the
# device reached Jellyfin: the desktop browser uses 127.0.0.1, a phone on the
# same network uses the machine's LAN address. Matching any host on :8096
# covers both without hardcoding an IP that changes with DHCP. This binds to
# a private network only (see the host arg at the bottom of this file), so
# the permissiveness stays inside the LAN.
app.add_middleware(
    CORSMiddleware,
    # Also allows the Chrome extension that injects the panel straight into
    # youtube.com's own page -- that page's origin is fixed (unlike
    # Jellyfin's LAN-address-dependent one above), so it's a plain literal
    # rather than folded into the regex.
    allow_origin_regex=r"https?://[^/]+:8096|https://www\.youtube\.com",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def no_cache_app_assets(request, call_next):
    """Never let the browser cache the panel's JS/CSS.

    Jellyfin's page loads tutor-panel.js on every visit; a stale cached copy
    running against a newer backend is the kind of thing that produces
    baffling "this used to work" bugs during development.
    """
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None
    # Claude Code CLI-specific -- ignored on the DeepSeek path, which reads
    # its own model choice from deepseek_config.json instead.
    model: str | None = None
    # Shared by both engines (DeepSeek's own reasoning_effort vocabulary is
    # narrower -- see deepseek_chat.REASONING_EFFORT_MAP).
    effort: str | None = None
    # DeepSeek-only: "on" (default)/"off" for its thinking mode. Claude's
    # extended thinking has no equivalent off switch exposed by the CLI.
    thinking: str | None = None
    # "claude" (default, unset) or "deepseek".
    engine: str | None = None
    # User-authored addition to TUTOR_SYSTEM_PROMPT, from the settings page.
    # Appended, not substituted -- the tool-use instructions there aren't
    # something a free-text field should be able to silently drop.
    custom_prompt: str | None = None


class DeepSeekConfig(BaseModel):
    api_key: str
    model: str = deepseek_chat.DEFAULT_MODEL
    base_url: str = deepseek_chat.DEFAULT_BASE_URL


class VocabEntry(BaseModel):
    video_title: str | None = None
    subtitle_text: str | None = None
    question: str
    answer: str = ""
    # Exam syllabi the word belongs to (cet4, cet6, ielts, ...), from
    # whatever the hover popup's dictionary lookup already returned -- see
    # dictionary.define(). Empty for a word on no such list.
    tags: list[str] = []
    # YouTube only (see tutor-panel.js's youtubeJumpTarget) -- a Jellyfin
    # local file has no external address to jump back to, so both are None
    # there. video_url already has the timestamp folded into its own `t=`
    # param; timestamp_seconds is kept alongside it only because a raw
    # number is more useful to have on hand than re-parsing the URL.
    video_url: str | None = None
    timestamp_seconds: float | None = None


class PhraseEntry(BaseModel):
    video_title: str | None = None
    subtitle_text: str | None = None
    phrase: str
    meaning: str = ""
    video_url: str | None = None
    timestamp_seconds: float | None = None


class PlaybackState(BaseModel):
    position_ms: int
    duration_ms: int
    status: str  # "playing" | "paused"
    # Set by the YouTube page, which knows exactly what it loaded. Absent for
    # the Jellyfin panel, whose <video> element carries no identity at all.
    source: str | None = None
    # Client-generated, stable per browser tab (see tutor-panel.js's TAB_ID) --
    # keeps two tabs watching different videos from overwriting each other's
    # playback_state.json entry. See playback.py's module docstring.
    tab_id: str


class YouTubeWatch(BaseModel):
    # Read straight off the youtube.com page by the extension's content
    # script, so there's no yt-dlp probe round trip to look them up.
    id: str
    title: str
    url: str
    # See PlaybackState.tab_id above.
    tab_id: str
    # Actually the channel's @handle (e.g. "@mondaydotcom"), not YouTube's
    # internal UC... channel id -- see content.js's channelIdFor for why: a
    # video grid card only ever exposes the handle, never the UC... id, and
    # this needs to be the same kind of string on both ends to work as
    # channel_profile's join key. Often empty on a video's very first
    # registration (page hasn't caught up yet) and filled in on a later call
    # for the same video; see youtube.py's _merge_marker.
    channel_id: str = ""


class YouTubeCaptionUpload(BaseModel):
    # id/title, not tab_id: this identifies a *video* (matching how youtube.
    # safe_base_name derives the cache filename), not a browser tab.
    id: str
    title: str
    kind: str  # "manual" | "auto" -- see youtube.save_uploaded_subtitles
    json3: str


def load_vocab() -> list[dict]:
    if not VOCAB_FILE.exists():
        return []
    return json.loads(VOCAB_FILE.read_text(encoding="utf-8"))


def save_vocab(entries: list[dict]) -> None:
    VOCAB_FILE.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "standalone.html")


@app.post("/api/youtube/watch")
def youtube_watch(body: YouTubeWatch):
    """Registers the cache placeholder for the video the youtube.com
    extension's content script says is playing (or reuses it if this video
    was seen before) and makes it the current one, in a single call.
    """
    try:
        info = youtube.ensure_current(body.id, body.title, body.url, body.channel_id)
    except Exception as e:
        raise HTTPException(400, str(e))
    path = Path(info["path"])
    playback.write(body.tab_id, str(path), 0, 0, "paused")
    return {"ok": True, "path": str(path), "video_id": body.id}


@app.post("/api/youtube/subtitles-upload")
def youtube_subtitles_upload(body: YouTubeCaptionUpload):
    """Fallback for a video the extension's content script had to fetch
    captions for itself -- see youtube.save_uploaded_subtitles's docstring.
    """
    ok, detail = youtube.save_uploaded_subtitles(body.id, body.title, body.kind, body.json3)
    return {"ok": ok, "detail": detail}


_lemma_ranks = None


def _lex() -> indexer.LemmaRanks:
    # Loaded once per process, not per request: it's the whole 57k-row
    # word_rank table plus forms/entries held in memory (see indexer.py),
    # and nothing in it changes without a `python build_dict.py` re-run,
    # which only happens with the process stopped.
    global _lemma_ranks
    if _lemma_ranks is None:
        _lemma_ranks = indexer.LemmaRanks(indexer.DICT_DB)
    return _lemma_ranks


def _find_cache_base(video_id: str) -> Path | None:
    """Locate this video's cache files by video_id alone -- safe_base_name
    always ends a marker's filename with "[<video_id>].tutor.json", so a
    plain string-suffix check finds it without reconstructing the filename
    from a title. The frontend's only candidate title (playback.py's
    "title", which is actually a *filename* -- see get_playback_status)
    doesn't round-trip through safe_base_name, so rebuilding the path from
    it silently missed every real cache hit.

    More than one marker can match: the same video registered twice under
    two different titles (content.js's title-correction race, or an old
    registration from before that was fixed) leaves two cache entries for
    one video_id, and only one of them necessarily has real subtitles.
    Confirmed for real: a member-only video registered once under a stale
    unrelated title (no subtitles ever fetched under it) and once under its
    real title (subtitles fetched fine) -- picking whichever glob happened
    to return first, as this used to, silently landed on the empty one and
    reported "unindexed" even though the video was fully usable under its
    other name. A base with an .en.srt sibling always wins over one without.
    """
    suffix = f"[{video_id}].tutor.json"
    candidates = [m for m in youtube.CACHE_DIR.glob("*.tutor.json") if m.name.endswith(suffix)]
    bases = [m.with_name(m.name[: -len(".tutor.json")]) for m in candidates]
    for base in bases:
        if base.with_name(f"{base.name}.en.srt").exists():
            return base
    return bases[0] if bases else None


def _index_on_demand(db, video_id: str):
    """A video the offline `python indexer.py` backfill hasn't seen yet --
    e.g. anything watched since the last run -- gets profiled right here
    instead of waiting for a cron-style re-run. Pure local file + CPU work,
    same zero-network-request guarantee as the batch indexer."""
    base = _find_cache_base(video_id)
    if base is None:
        return None
    srt = base.with_name(f"{base.name}.en.srt")
    if not srt.exists():
        return None
    marker = base.with_name(f"{base.name}.tutor.json")
    try:
        title = json.loads(marker.read_text(encoding="utf-8")).get("title", "")
    except (json.JSONDecodeError, OSError):
        title = ""
    try:
        channel_id = json.loads(marker.read_text(encoding="utf-8")).get("channel_id", "")
    except (json.JSONDecodeError, OSError):
        channel_id = ""
    cues = subs_now.parse_srt_cues(srt)
    profile = indexer.profile_video(cues, _lex())
    if profile is None:
        return None
    db.execute(
        """INSERT OR REPLACE INTO video_profile
           (video_id, title, duration_sec, total_tokens, band_dist, rare_words,
            speech_rate, proper_ratio, indexed_at, source, channel_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (video_id, title, profile["duration_sec"], profile["total_tokens"],
         json.dumps(profile["band_dist"]), json.dumps(profile["rare_words"]),
         profile["speech_rate"], profile["proper_ratio"], int(time.time()), "live", channel_id),
    )
    db.commit()
    return profile["total_tokens"], profile["band_dist"], profile["speech_rate"]


# p_known below this is worth flagging -- matches knowledge.prior_p_known's
# own "rank == V" midpoint, i.e. words at or past the edge of what the
# vocab-size estimate says the user knows.
VOCAB_HIGHLIGHT_THRESHOLD = 0.5

# Strips leading/trailing punctuation the same way tutor-panel.js's
# appendWordSpans does (token.replace(/^[^\w']+|[^\w']+$/g, "")) -- this
# endpoint has to tokenize identically to the client, not just "close
# enough", since the client matches spans back by exact (lowercased) word
# string, not by position.
_HIGHLIGHT_TRIM_RE = re.compile(r"^[^\w']+|[^\w']+$")


class VocabHighlightRequest(BaseModel):
    cues: list[str]  # raw cue text, same strings the subtitle cards render


@app.post("/api/vocab-highlight")
def vocab_highlight(body: VocabHighlightRequest):
    """Which words in each cue are likely unknown to the user right now --
    for the subtitle page's optional "生词高亮" setting. One batch call for
    the whole video's cues (tutor-panel.js does this once when subtitles
    load), not one per line: cheap either way (pure local lookups), but no
    reason to make 200 requests when one covers it.
    """
    lex = _lex()
    db = knowledge.open_db()
    try:
        known = knowledge.known_map(db)
        v = knowledge.vocab_size(db)
    finally:
        db.close()

    result = []
    for cue_text in body.cues:
        unknown = []
        for i, raw in enumerate(cue_text.split()):
            token = _HIGHLIGHT_TRIM_RE.sub("", raw)
            # \w includes digits, so "12" or "1920s" survive the trim above
            # -- confirmed for real that both were getting flagged "unknown"
            # (no word_rank entry, so straight to the rarest-band fallback)
            # as if they were obscure vocabulary. Requiring pure letters (+
            # apostrophe) excludes any token with a digit mixed in, not just
            # bare numbers.
            if not token or not re.fullmatch(r"[A-Za-z']+", token):
                continue
            lower = token.lower()
            if (token[:1].isupper() and i > 0 and lower not in indexer.NOT_PROPER
                    and not lex.is_known(lower)):
                continue  # likely a proper noun -- see indexer.py's proper-noun stripping
            if lower in indexer.FILLER_WORDS:
                continue  # "um"/"uh" -- see indexer.FILLER_WORDS
            norm = indexer.NEGATIVE_CONTRACTIONS.get(lower) or indexer.dictionary.CLITIC_RE.sub("", lower)
            if not norm:
                continue
            lemma = lex.lemma_of(norm)
            p = known.get(lemma)
            if p is None:
                rank, _band = lex.rank_band(lemma)
                p = knowledge.prior_p_known(rank, v)
            if p < VOCAB_HIGHLIGHT_THRESHOLD:
                unknown.append(lower)
        result.append(unknown)
    return {"result": result}


@app.get("/api/difficulty/{video_id}")
def get_difficulty(video_id: str):
    """New-words-per-minute for a YouTube video, given what we already know
    (or can cheaply learn) about it and the user's vocabulary."""
    db = knowledge.open_db()
    try:
        row = db.execute(
            "SELECT total_tokens, band_dist, speech_rate FROM video_profile WHERE video_id = ?",
            (video_id,),
        ).fetchone()
        if row is None:
            live = _index_on_demand(db, video_id)
            row = live and (live[0], json.dumps(live[1]), live[2])
        if row is None:
            return {"status": "unindexed"}
        _total_tokens, band_dist_json, speech_rate = row
        band_dist = json.loads(band_dist_json)
        v = knowledge.vocab_size(db)
    finally:
        db.close()

    density = scoring.unknown_per_min(band_dist, speech_rate, v)
    return {
        "status": "ok",
        "density_per_min": round(density, 1),
        "label": scoring.label_for(density),
        "vocab_size": v,
    }


# A channel estimate this thin isn't worth showing -- matches the design's
# own "n_videos < 3 isn't reliable enough to badge with" call (see
# indexer.py's channel_profile docstring).
MIN_CHANNEL_VIDEOS_FOR_ESTIMATE = 3


class DifficultyBatchItem(BaseModel):
    id: str
    # The channel's @handle, pulled from the grid card's own channel link --
    # see YouTubeWatch.channel_id for why it's a handle, not a channel id.
    # Purely a fallback key for videos with no video_profile row of their own
    # yet (nothing ever registered/watched them). Optional, best-effort.
    channel_id: str = ""


class DifficultyBatchRequest(BaseModel):
    items: list[DifficultyBatchItem]


@app.post("/api/difficulty/batch")
def get_difficulty_batch(body: DifficultyBatchRequest):
    """Difficulty for many videos at once -- the grid-page badge injection's
    only path, since it has no per-video indexing trigger the way the single
    open video does (nothing was ever registered for a video nobody clicked
    on, so there's no cache to index on demand). Everything here is a local
    SQLite read; never touches YouTube."""
    ids = [item.id for item in body.items]
    channel_by_id = {item.id: item.channel_id for item in body.items if item.channel_id}

    db = knowledge.open_db()
    try:
        v = knowledge.vocab_size(db)
        placeholders = ",".join("?" * len(ids)) if ids else "''"
        video_rows = db.execute(
            f"SELECT video_id, band_dist, speech_rate FROM video_profile "
            f"WHERE video_id IN ({placeholders})", ids,
        ).fetchall() if ids else []
        by_video = {vid: (json.loads(bd), sr) for vid, bd, sr in video_rows}

        wanted_channels = list({channel_by_id[vid] for vid in ids
                                 if vid not in by_video and vid in channel_by_id})
        channel_by_channel_id = {}
        if wanted_channels:
            cplaceholders = ",".join("?" * len(wanted_channels))
            for cid, n_videos, band_dist_json, speech_rate in db.execute(
                f"SELECT channel_id, n_videos, band_dist, speech_rate FROM channel_profile "
                f"WHERE channel_id IN ({cplaceholders})", wanted_channels,
            ).fetchall():
                if n_videos >= MIN_CHANNEL_VIDEOS_FOR_ESTIMATE:
                    channel_by_channel_id[cid] = (json.loads(band_dist_json), speech_rate)

        result = {}
        for vid in ids:
            if vid in by_video:
                band_dist, speech_rate = by_video[vid]
                density = scoring.unknown_per_min(band_dist, speech_rate, v)
                result[vid] = {"status": "ok", "source": "video",
                                "density_per_min": round(density, 1), "label": scoring.label_for(density)}
                continue
            channel_hit = channel_by_channel_id.get(channel_by_id.get(vid))
            if channel_hit:
                band_dist, speech_rate = channel_hit
                density = scoring.unknown_per_min(band_dist, speech_rate, v)
                result[vid] = {"status": "ok", "source": "channel",
                                "density_per_min": round(density, 1), "label": scoring.label_for(density)}
                continue
            result[vid] = {"status": "unassessed"}
        return {"result": result, "vocab_size": v}
    finally:
        db.close()


class VocabTestAnswer(BaseModel):
    lemma: str
    rank: int
    known: bool
    is_fake: bool = False


class VocabTestStage2Request(BaseModel):
    answers: list[VocabTestAnswer]  # stage 1 only, real words


class VocabTestFinishRequest(BaseModel):
    answers: list[VocabTestAnswer]  # every answer from both stages, fakes included


def _to_pairs(answers: list[VocabTestAnswer]) -> list[tuple[int, bool]]:
    return [(a.rank, a.known) for a in answers if not a.is_fake]


@app.get("/api/vocab-test/status")
def vocab_test_status():
    db = knowledge.open_db()
    try:
        v = knowledge.vocab_size(db)
    finally:
        db.close()
    return {"vocab_size": v, "level_label": vocab_test.level_label(v),
            "is_default": v == knowledge.DEFAULT_VOCAB_SIZE}


@app.post("/api/vocab-test/stage1")
def vocab_test_stage1():
    used: set[str] = set()
    items = vocab_test.generate_stage(_lex(), vocab_test.COARSE_RANKS, used, with_fakes=False)
    return {"items": items}


@app.post("/api/vocab-test/stage2")
def vocab_test_stage2(body: VocabTestStage2Request):
    v1 = vocab_test.fit_vocab_size(_to_pairs(body.answers))
    used = {a.lemma for a in body.answers}
    ranks = vocab_test.stage_two_ranks(v1)
    items = vocab_test.generate_stage(_lex(), ranks, used, with_fakes=True)
    return {"items": items, "stage1_estimate": v1}


@app.post("/api/vocab-test/finish")
def vocab_test_finish(body: VocabTestFinishRequest):
    fake_known = sum(1 for a in body.answers if a.is_fake and a.known)
    retake_suggested = fake_known > vocab_test.MAX_FAKE_KNOWN_BEFORE_RETAKE
    v = vocab_test.fit_vocab_size(_to_pairs(body.answers))

    db = knowledge.open_db()
    try:
        knowledge.set_vocab_size(db, v)
    finally:
        db.close()

    return {
        "vocab_size": v,
        "level_label": vocab_test.level_label(v),
        "retake_suggested": retake_suggested,
        "fake_known": fake_known,
    }


@app.get("/api/vocab")
def get_vocab():
    # Newest first -- that's what you just learned, most likely to still be
    # fresh/relevant, so it belongs at the top of the review list.
    return list(reversed(load_vocab()))


@app.post("/api/vocab")
def add_vocab(entry: VocabEntry):
    entries = load_vocab()
    record = {
        "id": uuid.uuid4().hex[:12],
        "created_at": time.time(),
        "video_title": entry.video_title,
        "subtitle_text": entry.subtitle_text,
        "question": entry.question,
        "answer": entry.answer,
        "tags": entry.tags,
        "video_url": entry.video_url,
        "timestamp_seconds": entry.timestamp_seconds,
        "streak": 0,
        # 0 means "due now" -- a freshly-saved word is immediately quizzable,
        # same as before this field existed.
        "next_review_at": 0,
    }
    entries.append(record)
    save_vocab(entries)
    return record


@app.delete("/api/vocab/{entry_id}")
def delete_vocab(entry_id: str):
    entries = load_vocab()
    remaining = [e for e in entries if e.get("id") != entry_id]
    if len(remaining) == len(entries):
        raise HTTPException(404, "没找到这条记录")
    save_vocab(remaining)
    return {"ok": True}


# Leitner-style spacing: box 0 is "never graded (or just got a wrong
# answer), always due"; each correct grading moves up a box and pushes
# next_review_at out by that box's interval, in days; a wrong grading drops
# straight back to box 0, due immediately. The box concept itself isn't new
# -- "streak" was already exactly this before real dates existed, just
# without anything to say *when* a non-zero box should come due again.
REVIEW_INTERVAL_DAYS = [0, 1, 2, 4, 8, 16]
MASTERED_STREAK = 6


class VocabGrade(BaseModel):
    result: str  # "known" | "unknown"


@app.post("/api/vocab/{entry_id}/grade")
def grade_vocab(entry_id: str, body: VocabGrade):
    if body.result not in ("known", "unknown"):
        raise HTTPException(400, "result 必须是 known 或 unknown")
    entries = load_vocab()
    for e in entries:
        if e.get("id") == entry_id:
            # "unknown" doubles as the reset path: the panel also sends it
            # when someone taps a mastered word's badge to pull it back into
            # rotation, not just for a genuine wrong answer in the quiz --
            # both cases want the same "back to box 0, due now" effect, and
            # REVIEW_INTERVAL_DAYS[0] == 0 gives them that for free below.
            e["streak"] = min(e.get("streak", 0) + 1, MASTERED_STREAK) if body.result == "known" else 0
            days = REVIEW_INTERVAL_DAYS[min(e["streak"], len(REVIEW_INTERVAL_DAYS) - 1)]
            e["next_review_at"] = time.time() + days * 86400
            save_vocab(entries)
            return {
                "ok": True,
                "streak": e["streak"],
                "mastered": e["streak"] >= MASTERED_STREAK,
                "next_review_at": e["next_review_at"],
            }
    raise HTTPException(404, "没找到这条记录")


def load_phrases() -> list[dict]:
    if not PHRASES_FILE.exists():
        return []
    return json.loads(PHRASES_FILE.read_text(encoding="utf-8"))


def save_phrases(entries: list[dict]) -> None:
    PHRASES_FILE.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")


@app.get("/api/phrases")
def get_phrases():
    return list(reversed(load_phrases()))


@app.post("/api/phrases")
def add_phrase(entry: PhraseEntry):
    entries = load_phrases()
    record = {
        "id": uuid.uuid4().hex[:12],
        "created_at": time.time(),
        "video_title": entry.video_title,
        "subtitle_text": entry.subtitle_text,
        "phrase": entry.phrase,
        "meaning": entry.meaning,
        "video_url": entry.video_url,
        "timestamp_seconds": entry.timestamp_seconds,
    }
    entries.append(record)
    save_phrases(entries)
    return record


@app.delete("/api/phrases/{entry_id}")
def delete_phrase(entry_id: str):
    entries = load_phrases()
    remaining = [e for e in entries if e.get("id") != entry_id]
    if len(remaining) == len(entries):
        raise HTTPException(404, "没找到这条记录")
    save_phrases(remaining)
    return {"ok": True}


@app.get("/api/define")
def define_word(word: str):
    """Offline dictionary lookup for the subtitle hover tooltip.

    Hovering has to feel instant, which rules out asking the model: that's
    seconds per word and a cost per lookup. The chat pathway stays for
    in-context explanation, where the latency buys something.
    """
    if not dictionary.available():
        return {"found": False, "error": "词典未安装，先运行 python build_dict.py"}
    entry = dictionary.define(word)
    return {"found": True, **entry} if entry else {"found": False}


@app.post("/api/playback-state")
def report_playback_state(state: PlaybackState):
    """Called by the injected panel every couple of seconds.

    Split responsibility, because neither side knows the whole story: the
    panel has an accurate position (it reads the <video> element every tick)
    but no idea which file that is -- Jellyfin plays through MSE, so the
    element's src is an opaque blob: URL. The server knows exactly which
    item is playing but only gets progress reports from its client every
    several seconds. So: position from the panel, identity from /Sessions.

    The YouTube page is the exception: it loaded the video itself, so it sends
    `source` and Jellyfin is not consulted at all. That value is checked
    against the cache directory before being written -- it ends up in
    playback_state.json, which the MCP tools read subtitles from, so an
    unchecked path would let any client on the LAN aim the tutor at an
    arbitrary file.
    """
    if state.source:
        path = Path(state.source)
        if not youtube.is_cached_path(path) or not path.exists():
            raise HTTPException(400, "source 不是已添加的 YouTube 视频")
        playback.write(state.tab_id, str(path), state.position_ms, state.duration_ms, state.status)
        return {"ok": True, "path": str(path), "play_method": "YouTube"}

    try:
        playing = jellyfin.now_playing()
    except Exception as e:
        raise HTTPException(502, f"读取 Jellyfin 会话失败：{e}")
    if not playing or not playing.get("path"):
        raise HTTPException(409, "Jellyfin 当前没有在播放任何内容")

    playback.write(state.tab_id, playing["path"], state.position_ms, state.duration_ms, state.status)
    return {"ok": True, "path": playing["path"], "play_method": playing.get("play_method")}


# ---- Background subtitle extraction -------------------------------------
# Pulling an embedded subtitle track is expensive because the track's data is
# interleaved with video throughout the container. ffmpeg streams the whole
# file to get at it (~75-84s on a cold 8GB 4K episode). mkv_subs.py does
# better by walking the EBML tree and seeking past video payloads (~24s,
# byte-identical output), but it's still tens of seconds.
#
# So extraction never happens inside a request handler: a sync endpoint would
# hold a uvicorn threadpool thread for that whole time, and with the subtitle
# page polling /api/position frequently those polls pile up behind it and the
# whole UI appears frozen. Instead every endpoint returns immediately with
# whatever is ready, and extraction runs on its own thread, publishing cues
# as it finds them.
_extract_lock = threading.Lock()
_extract_states: dict[str, str] = {}  # key -> "running" | error message
_prefetched: set[str] = set()
_partial_cache: dict[str, list] = {}
_partial_progress: dict[str, float] = {}
# Only one extraction touches the disk at a time. Running the current
# episode's extraction alongside a prefetch just halves each one's read
# throughput -- they contend for the same spindle rather than overlapping
# usefully.
_extraction_slot = threading.Semaphore(1)


def _extract_key(video: Path, lang: str) -> str:
    return f"{video}|{lang}"


def start_extraction_if_needed(video: Path, lang: str) -> str:
    """Never blocks. Returns "ready", "extracting", or an error message."""
    if subs_now.find_existing_subtitle(video, lang, video.parent):
        return "ready"

    key = _extract_key(video, lang)
    with _extract_lock:
        state = _extract_states.get(key)
        if state == "running":
            return "extracting"
        if state:
            # A previous attempt failed. Surface the error once and clear it,
            # so the next poll/retry gets a fresh attempt rather than being
            # stuck on a stale failure forever.
            _extract_states.pop(key, None)
            return state
        _extract_states[key] = "running"

    def on_progress(cues, fraction):
        # Cues found so far, in episode order. Publishing them as we go is
        # what lets the subtitle page fill in from the start of the episode
        # instead of waiting for the whole scan.
        with _extract_lock:
            _partial_cache[key] = list(cues)
            _partial_progress[key] = fraction

    def worker():
        with _extraction_slot:
            try:
                subs_now.resolve_subtitle(video, lang, video.parent, on_progress=on_progress)
                result = None
            except Exception as e:
                result = str(e) or repr(e)
        with _extract_lock:
            if result is None:
                _extract_states.pop(key, None)
                _partial_cache.pop(key, None)
                _partial_progress.pop(key, None)
            else:
                _extract_states[key] = result

    threading.Thread(target=worker, daemon=True).start()
    return "extracting"


def get_partial_cues(video: Path, lang: str) -> tuple[list, float]:
    """Whatever the in-flight extraction has turned up so far, plus how far
    through the file it has read (0..1). Pure dict lookup -- the cues are
    published by the extraction thread itself, so no second reader process
    is ever spawned to compete with it for disk bandwidth."""
    key = _extract_key(video, lang)
    with _extract_lock:
        return list(_partial_cache.get(key, [])), _partial_progress.get(key, 0.0)


def prefetch_next_episode(video: Path, lang: str) -> None:
    """Start extracting the *next* file in the folder while you're still
    watching this one. An episode runs ~45 minutes and extraction takes ~1.5,
    so by the time you actually switch, its subtitles are already cached and
    the subtitle page opens instantly instead of stalling."""
    key = _extract_key(video, lang)
    if key in _prefetched:
        return
    _prefetched.add(key)
    try:
        siblings = sorted(
            f for f in video.parent.iterdir()
            if f.is_file() and f.suffix.lower() in (".mkv", ".mp4")
        )
        idx = siblings.index(video)
    except (OSError, ValueError):
        return
    if idx + 1 < len(siblings):
        start_extraction_if_needed(siblings[idx + 1], lang)


@app.get("/api/position")
def get_position(tab_id: str | None = None):
    """Just the live position, straight out of the state file the panel
    keeps updated -- cheap enough for the subtitle page to poll frequently.
    /api/context does a bit more work (subtitle-window lookup) but stays
    cheap too, since it only needs to refresh a few times a minute."""
    try:
        return {"available": True, **playback.read(tab_id)}
    except RuntimeError as e:
        return {"available": False, "error": str(e)}


@app.get("/api/context")
def get_context(lang: str = "en", lookback_minutes: float = 5.0, tab_id: str | None = None):
    """Current video/position plus the subtitle window up to now.

    Calls subs_now in-process (not a subprocess) so it shares the same
    extraction lock as /api/subtitles -- otherwise this poll and the
    subtitle-card page loading at the same time on a freshly-opened video
    would both independently kick off extraction for it."""
    try:
        progress = playback.read(tab_id)
    except RuntimeError as e:
        return {"available": False, "error": str(e)}

    subtitle_text = ""
    status_line = ""
    try:
        video = playback.current_video(tab_id)
        status = start_extraction_if_needed(video, lang)
        prefetch_next_episode(video, lang)
        if status == "extracting":
            status_line = f"[视频] {video.name} | 正在后台提取字幕，请稍等…"
        elif status != "ready":
            status_line = f"[视频] {video.name} | 字幕提取失败：{status}"
        else:
            window_start_ms = max(0, progress["position_ms"] - int(lookback_minutes * 60_000))
            subtitle_path, lines, cue_count = subs_now.get_recent_window(
                video, lang, video.parent, progress["position_ms"], window_start_ms,
                allow_extract=False,
            )
            subtitle_text = "\n".join(lines)
            status_line = (
                f"[视频] {video.name} | [当前位置] {playback.fmt_ms(progress['position_ms'])}  "
                f"[取用区间] {playback.fmt_ms(window_start_ms)} - {playback.fmt_ms(progress['position_ms'])} "
                f"| [字幕来源] {subtitle_path.name}  ({cue_count} 条台词，去重后 {len(lines)} 行)"
            )
    except Exception as e:
        status_line = str(e)

    return {
        "available": True,
        "progress": progress,
        "subtitle_text": subtitle_text,
        "status_line": status_line,
    }


def secondary_cues(video: Path, lang: str) -> tuple[list, str]:
    """Companion-language cues for the bilingual view. Never blocks.

    Returns (cues, status) where status is "ready", "extracting", or an error
    message. A second language means a second full pass over the container,
    so this follows the same rule as the primary one: kick the work off, hand
    back whatever exists now, and let the client poll.
    """
    status = start_extraction_if_needed(video, lang)
    if status == "extracting":
        # Partial cues arrive in episode order, so the start of the episode
        # gets its translation well before the scan reaches the end.
        partial, _ = get_partial_cues(video, lang)
        return partial, "extracting"
    if status != "ready":
        return [], status
    try:
        path = subs_now.find_existing_subtitle(video, lang, video.parent)
        return subs_now.parse_cues(path), "ready"
    except Exception as e:
        return [], str(e) or repr(e)


def serialize_cues(cues: list, secondary: list | None,
                   word_stream: list | None = None) -> list[dict]:
    if secondary is None:
        rows = [{"start_ms": s, "end_ms": e, "text": t} for s, e, t in cues]
    else:
        rows = [
            {"start_ms": s, "end_ms": e, "text": t, "text2": t2}
            for s, e, t, t2 in subs_now.merge_cues(cues, secondary)
        ]
    return attach_word_times(rows, word_stream)


def attach_word_times(rows: list[dict], word_stream: list | None) -> list[dict]:
    """Give each cue a `words` list of [start_ms, end_ms] pairs, one per word
    of its own text, for the panel's word-by-word highlight.

    `word_stream` is the whole track's real per-word timing (youtube.py's
    .words.json sidecar), flat and in the same order the cues flatten to --
    which holds by construction, see clean_auto_captions. The only check
    worth making is the total count: if that matches, position i of the
    stream is position i of the flattened cues, full stop. Comparing the
    *text* would be actively wrong, since the punctuation pass legitimately
    changes trailing punctuation and capitalization after the sidecar was
    written.

    A mismatch drops the timings entirely rather than attaching a shifted
    subset -- the panel treats an absent `words` as "no word highlighting
    for this video" and renders exactly as it did before, which is a much
    better failure than highlighting the wrong words.

    Times only, no text: the text is already in each cue, and repeating it
    per word measurably inflates the payload on a feature-length video
    (20k+ words).
    """
    if not word_stream:
        return rows
    counts = [len(row["text"].split()) for row in rows]
    if sum(counts) != len(word_stream):
        return rows
    at = 0
    for row, n in zip(rows, counts):
        row["words"] = [[s, e] for s, e, _ in word_stream[at:at + n]]
        at += n
    return rows


@app.get("/api/subtitles")
def get_subtitles(lang: str = "en", secondary: str | None = None, words: int = 0,
                   tab_id: str | None = None):
    """Full timestamped cue list for the currently-playing video -- powers
    the card-by-card subtitle browser (as opposed to /api/context, which
    only returns a deduplicated text blob for chat purposes).

    With `secondary` set, each cue also carries `text2`: the line covering the
    same moment in that language, for the side-by-side bilingual view.

    With `words` set, each cue also carries `words`: per-word timings for the
    word-by-word highlight (see attach_word_times). Behind a parameter rather
    than always-on because it roughly doubles the payload and only one of the
    panel's settings ever wants it -- and because only YouTube auto-captions
    have the data at all, so most videos would pay the check for nothing."""
    try:
        video = playback.current_video(tab_id)
    except Exception as e:
        return {"available": False, "error": str(e)}

    # A YouTube video is registered the moment its title is known, so its
    # subtitles may still be in flight. Answered before the extraction path
    # below, which would otherwise try to demux a 43-byte .strm placeholder.
    # The shape matches the MKV "still extracting" reply on purpose: the panel
    # already knows how to poll and report progress for that.
    if youtube.is_cached_path(video):
        state, detail = youtube.subtitle_status(video)
        if state == "fetching":
            return {"available": False, "status": "extracting",
                    "progress": 0, "message": detail, "video_title": video.name}
        if state == "error":
            return {"available": False, "status": "error", "error": detail}

    status = start_extraction_if_needed(video, lang)
    if not youtube.is_cached_path(video):
        # Prefetching the "next episode" means nothing for a folder of
        # unrelated YouTube videos.
        prefetch_next_episode(video, lang)

    sec_cues = None
    sec_status = None
    if secondary:
        sec_cues, sec_status = secondary_cues(video, secondary)
        if not youtube.is_cached_path(video):
            prefetch_next_episode(video, secondary)

    def reply(payload: dict) -> dict:
        # Reported separately from the primary `complete` flag: the English
        # side can be finished while the translation is still being pulled,
        # and the client needs to keep polling for exactly that case.
        if secondary:
            payload["secondary_status"] = sec_status
        return payload

    if status != "ready":
        if status != "extracting":
            return reply({"available": False, "status": "error", "error": status})
        # Extraction is still running. Serve whatever cues it has published
        # so far -- they arrive in episode order, so the page fills in from
        # the beginning and the client upgrades to the complete list on a
        # later poll.
        partial, fraction = get_partial_cues(video, lang)
        if not partial:
            return reply({
                "available": False,
                "status": "extracting",
                "progress": fraction,
                "video_title": video.name,
            })
        return reply({
            "available": True,
            "complete": False,
            "progress": fraction,
            "video_title": video.name,
            "cues": serialize_cues(partial, sec_cues),
        })

    try:
        subtitle_path = subs_now.find_existing_subtitle(video, lang, video.parent)
        cues = subs_now.parse_cues(subtitle_path)
    except Exception as e:
        return reply({"available": False, "status": "error", "error": str(e)})

    # None for anything that isn't a YouTube auto-caption track -- human
    # subtitles and MKV extractions never get a sidecar written, and
    # load_word_stream answers for that without needing to be asked what
    # kind of video this is.
    word_stream = youtube.load_word_stream(subtitle_path) if words else None

    return reply({
        "available": True,
        "complete": True,
        "video_title": video.name,
        "cues": serialize_cues(cues, sec_cues, word_stream),
        # True while a YouTube auto-caption track is queued/running through
        # local punctuation restoration -- the cues above are already the
        # (currently unpunctuated) working copy, this just tells the panel
        # a better version may replace them shortly, worth a quiet retry.
        "polishing": youtube.is_polishing(video),
    })


# ---- Chat ----------------------------------------------------------------

def _system_prompt(req: ChatRequest) -> str:
    extra = (req.custom_prompt or "").strip()
    return f"{TUTOR_SYSTEM_PROMPT}\n\n{extra}" if extra else TUTOR_SYSTEM_PROMPT


def build_claude_command(req: ChatRequest, system_prompt: str) -> list[str]:
    # The prompt is NOT passed here -- it goes over stdin (see chat()).
    # claude on Windows resolves to claude.CMD, and cmd.exe's argument
    # handling mangles/truncates a single argv value that contains embedded
    # newlines (confirmed: a multi-line -p "..." argument silently drops
    # everything after the first line, and --output-format json stops being
    # honored too). Piping the prompt via stdin sidesteps cmd.exe's argument
    # parsing entirely and works correctly with multi-line text.
    cmd = [
        CLAUDE_BIN, "-p",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--disallowedTools", DISALLOWED_TOOLS,
        "--allowedTools", ALLOWED_TOOLS,
        # Still a full Claude Code session (not --bare, which requires an API
        # key and would break OAuth/subscription auth).
        # --disable-slash-commands stops it from seeing globally installed
        # skills so it doesn't get ideas about re-running extraction scripts
        # -- it should reach for the MCP tools instead.
        "--disable-slash-commands",
        "--mcp-config", str(MCP_CONFIG_FILE),
    ]
    agents = {TUTOR_AGENT_NAME: {"description": AGENTS[TUTOR_AGENT_NAME]["description"], "prompt": system_prompt}}
    cmd += ["--agents", json.dumps(agents, ensure_ascii=False)]
    cmd += ["--agent", TUTOR_AGENT_NAME]
    # Passed explicitly rather than left unset -- leaving them out would hand
    # the choice to claude's own CLI default, which this project doesn't
    # control and isn't necessarily "sonnet"/"medium" (see MODEL_OPTIONS'/
    # EFFORT_OPTIONS' labels in tutor-panel.js, which promise exactly that).
    cmd += ["--model", req.model or "sonnet"]
    cmd += ["--effort", req.effort or "medium"]
    if req.session_id:
        cmd += ["--resume", req.session_id]
    return cmd


def ndjson(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


def stream_claude_events(cmd: list[str], prompt: str):
    """Run claude in stream-json mode and yield simplified NDJSON events:
    thinking_delta / text_delta while the response is generated, then a
    final `done` (or `error`) event once the process exits.

    Tool calls (get_playback_status, search_subtitles, etc.) happen entirely
    inside the subprocess/MCP layer and are never surfaced here -- with one
    deliberate exception: suggest_phrase (see tutor_tools.py) is meant to be
    seen by the user as a save prompt, not just silently answered back to the
    model, so a tool_use content block by that name gets its own
    phrase_suggestion event once its (streamed, same as text) arguments are
    complete."""
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
        cwd=str(ROOT),
    )
    proc.stdin.write(prompt)
    proc.stdin.close()

    full_reply = ""
    got_result = False
    result_is_error = False
    result_message = None
    # A tool_use block's `input` arrives the same way text does -- streamed
    # in fragments (input_json_delta) rather than one whole blob -- so this
    # accumulates by content-block index until the block closes and its JSON
    # can actually be parsed.
    pending_tool_uses: dict[int, dict] = {}

    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            continue

        evt_type = evt.get("type")
        if evt_type == "stream_event":
            inner = evt.get("event", {})
            inner_type = inner.get("type")
            if inner_type == "content_block_start":
                block = inner.get("content_block", {})
                if block.get("type") == "tool_use":
                    pending_tool_uses[inner.get("index")] = {"name": block.get("name"), "json": ""}
            elif inner_type == "content_block_delta":
                delta = inner.get("delta", {})
                if delta.get("type") == "thinking_delta":
                    yield ndjson({"type": "thinking_delta", "text": delta.get("thinking", "")})
                elif delta.get("type") == "text_delta":
                    text = delta.get("text", "")
                    full_reply += text
                    yield ndjson({"type": "text_delta", "text": text})
                elif delta.get("type") == "input_json_delta":
                    idx = inner.get("index")
                    if idx in pending_tool_uses:
                        pending_tool_uses[idx]["json"] += delta.get("partial_json", "")
            elif inner_type == "content_block_stop":
                pending = pending_tool_uses.pop(inner.get("index"), None)
                # Streamed under its full MCP-qualified name (see
                # ALLOWED_TOOLS), not the bare "suggest_phrase" tutor_tools.py
                # itself uses -- comparing against the bare name here silently
                # dropped every real call, so the card never rendered and
                # nothing ever reached phrases.json even though the model had
                # genuinely called the tool and told the user it had.
                if pending and pending["name"] == "mcp__video-subtitles__suggest_phrase":
                    try:
                        args = json.loads(pending["json"])
                    except json.JSONDecodeError:
                        args = None
                    if args:
                        yield ndjson({
                            "type": "phrase_suggestion",
                            "phrase": args.get("phrase", ""),
                            "meaning": args.get("meaning", ""),
                            "subtitle_text": args.get("subtitle_text", ""),
                        })
            elif inner_type == "message_delta":
                usage = inner.get("usage", {})
                if usage:
                    yield ndjson({"type": "usage", "output_tokens": usage.get("output_tokens")})
        elif evt_type == "result":
            got_result = True
            if evt.get("is_error"):
                # Deferred rather than yielded here: a failure that happens
                # before claude ever frames a `result` (bad --resume session
                # id, expired auth) leaves `result` empty, and the actual
                # reason is only on stderr -- which isn't fully written until
                # the process exits. Reading it now could mean reading it
                # too early.
                result_is_error = True
                result_message = evt.get("result")
            else:
                # full_reply, not evt.get("result", ...): a response that
                # pauses to call a tool (suggest_phrase, or a deferred tool
                # needing its own ToolSearch lookup first -- see the CLI's
                # own deferred-tools mechanism) spans several separate
                # message_start/message_stop turns within this one process,
                # and the CLI's own top-level "result" field only holds the
                # LAST turn's text, not the whole conversation -- confirmed
                # for real: it silently dropped everything the model said
                # before the tool call. full_reply is built from every
                # text_delta across every turn, so it's always the complete
                # reply already (the frontend showed exactly this while
                # streaming); the CLI's field can only ever be a subset.
                yield ndjson({
                    "type": "done",
                    "reply": full_reply,
                    "session_id": evt.get("session_id"),
                    "cost_usd": evt.get("total_cost_usd"),
                    "duration_ms": evt.get("duration_ms"),
                })

    proc.wait()
    stderr_text = proc.stderr.read()

    if not got_result:
        # Process exited without ever sending a `result` event -- something
        # went wrong upstream (crash, or output wasn't valid stream-json at
        # all). Surface whatever we've got so the chat doesn't just hang.
        yield ndjson({
            "type": "error",
            "message": (
                stderr_text.strip()[:1000]
                or full_reply[:1000]
                or "claude 没有返回任何内容"
            ),
        })
    elif result_is_error:
        yield ndjson({
            "type": "error",
            "message": result_message or stderr_text.strip()[:1000] or "claude 返回了错误",
        })


@app.post("/api/chat")
def chat(req: ChatRequest):
    system_prompt = _system_prompt(req)
    if req.engine == "deepseek":
        # A raw HTTP call, not a claude subprocess: no ~13s CLI-startup
        # overhead, no per-turn mcp_server.py spawn. Same tool functions
        # either way (tutor_tools.py), same NDJSON event shape out, so the
        # frontend doesn't know or care which backend answered.
        return StreamingResponse(
            deepseek_chat.stream_chat(system_prompt, req.message,
                                      session_id=req.session_id, model=req.model,
                                      effort=req.effort, thinking=req.thinking),
            media_type="application/x-ndjson",
        )
    # No context-stuffing on purpose: the agent has real tools and should
    # call them for whatever it actually needs, instead of every message
    # paying for the whole episode's subtitles whether relevant or not.
    return StreamingResponse(
        stream_claude_events(build_claude_command(req, system_prompt), req.message),
        media_type="application/x-ndjson",
    )


@app.get("/api/deepseek-config")
def get_deepseek_config():
    """Whether a key is on file, never the key itself -- the settings page
    uses this to show "已配置" instead of silently re-displaying a secret
    it already has no legitimate reason to read back."""
    cfg = deepseek_chat.config()
    return {
        "configured": bool(cfg and cfg.get("api_key")),
        "model": (cfg or {}).get("model") or deepseek_chat.DEFAULT_MODEL,
    }


@app.post("/api/deepseek-config")
def set_deepseek_config(body: DeepSeekConfig):
    DEEPSEEK_CONFIG_FILE.write_text(
        json.dumps(body.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")
    deepseek_chat.reload_config()
    return {"ok": True}


app.mount("/static", StaticFiles(directory=str(ROOT / "static")), name="static")


if __name__ == "__main__":
    import uvicorn
    # 0.0.0.0 so phones and tablets on the same network can load the panel --
    # Jellyfin already listens on all interfaces, and a panel that only
    # answered on loopback would break the moment the page was opened from
    # any other device. Nothing here is exposed beyond the LAN unless the
    # machine's firewall/router is configured to forward the port.
    uvicorn.run(app, host="0.0.0.0", port=app_config.port())
