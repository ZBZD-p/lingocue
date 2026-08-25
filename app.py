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
MCP_CONFIG_FILE = ROOT / "mcp_config.json"


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
VOCAB_FILE = ROOT / "vocab.json"
DEEPSEEK_CONFIG_FILE = ROOT / "deepseek_config.json"

sys.path.insert(0, str(ROOT))
import deepseek_chat  # noqa: E402
import dictionary  # noqa: E402
import jellyfin  # noqa: E402
import playback  # noqa: E402
import subs_now  # noqa: E402
import youtube  # noqa: E402

JELLYFIN_ORIGIN = jellyfin.config()["base_url"]

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
    "mcp__video-subtitles__search_subtitles"
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
    "passages. Keep answers focused; don't pad with filler."
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
    model: str | None = None
    effort: str | None = None
    # "claude" (default, unset) or "deepseek" -- model/effort above are
    # Claude Code CLI-specific and ignored on the DeepSeek path, which reads
    # its own model choice from deepseek_config.json instead.
    engine: str | None = None


class DeepSeekConfig(BaseModel):
    api_key: str
    model: str = deepseek_chat.DEFAULT_MODEL
    base_url: str = deepseek_chat.DEFAULT_BASE_URL


class VocabEntry(BaseModel):
    video_title: str | None = None
    subtitle_text: str | None = None
    question: str
    answer: str = ""


class PlaybackState(BaseModel):
    position_ms: int
    duration_ms: int
    status: str  # "playing" | "paused"
    # Set by the YouTube page, which knows exactly what it loaded. Absent for
    # the Jellyfin panel, whose <video> element carries no identity at all.
    source: str | None = None


class YouTubeWatch(BaseModel):
    # Read straight off the youtube.com page by the extension's content
    # script, so there's no yt-dlp probe round trip to look them up.
    id: str
    title: str
    url: str


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
        info = youtube.ensure_current(body.id, body.title, body.url)
    except Exception as e:
        raise HTTPException(400, str(e))
    path = Path(info["path"])
    playback.write(str(path), 0, 0, "paused")
    return {"ok": True, "path": str(path), "video_id": body.id}


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
        playback.write(str(path), state.position_ms, state.duration_ms, state.status)
        return {"ok": True, "path": str(path), "play_method": "YouTube"}

    try:
        playing = jellyfin.now_playing()
    except Exception as e:
        raise HTTPException(502, f"读取 Jellyfin 会话失败：{e}")
    if not playing or not playing.get("path"):
        raise HTTPException(409, "Jellyfin 当前没有在播放任何内容")

    playback.write(playing["path"], state.position_ms, state.duration_ms, state.status)
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
def get_position():
    """Just the live position, straight out of the state file the panel
    keeps updated -- cheap enough for the subtitle page to poll frequently.
    /api/context does a bit more work (subtitle-window lookup) but stays
    cheap too, since it only needs to refresh a few times a minute."""
    try:
        return {"available": True, **playback.read()}
    except RuntimeError as e:
        return {"available": False, "error": str(e)}


@app.get("/api/context")
def get_context(lang: str = "en", lookback_minutes: float = 5.0):
    """Current video/position plus the subtitle window up to now.

    Calls subs_now in-process (not a subprocess) so it shares the same
    extraction lock as /api/subtitles -- otherwise this poll and the
    subtitle-card page loading at the same time on a freshly-opened video
    would both independently kick off extraction for it."""
    try:
        progress = playback.read()
    except RuntimeError as e:
        return {"available": False, "error": str(e)}

    subtitle_text = ""
    status_line = ""
    try:
        video = playback.current_video()
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


def serialize_cues(cues: list, secondary: list | None) -> list[dict]:
    if secondary is None:
        return [{"start_ms": s, "end_ms": e, "text": t} for s, e, t in cues]
    return [
        {"start_ms": s, "end_ms": e, "text": t, "text2": t2}
        for s, e, t, t2 in subs_now.merge_cues(cues, secondary)
    ]


@app.get("/api/subtitles")
def get_subtitles(lang: str = "en", secondary: str | None = None):
    """Full timestamped cue list for the currently-playing video -- powers
    the card-by-card subtitle browser (as opposed to /api/context, which
    only returns a deduplicated text blob for chat purposes).

    With `secondary` set, each cue also carries `text2`: the line covering the
    same moment in that language, for the side-by-side bilingual view."""
    try:
        video = playback.current_video()
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

    return reply({
        "available": True,
        "complete": True,
        "video_title": video.name,
        "cues": serialize_cues(cues, sec_cues),
    })


# ---- Chat ----------------------------------------------------------------

def build_claude_command(req: ChatRequest) -> list[str]:
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
    cmd += ["--agents", json.dumps(AGENTS, ensure_ascii=False)]
    cmd += ["--agent", TUTOR_AGENT_NAME]
    if req.model:
        cmd += ["--model", req.model]
    if req.effort:
        cmd += ["--effort", req.effort]
    if req.session_id:
        cmd += ["--resume", req.session_id]
    return cmd


def ndjson(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


def stream_claude_events(cmd: list[str], prompt: str):
    """Run claude in stream-json mode and yield simplified NDJSON events:
    thinking_delta / text_delta while the response is generated, then a
    final `done` (or `error`) event once the process exits."""
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
        cwd=str(ROOT),
    )
    proc.stdin.write(prompt)
    proc.stdin.close()

    full_reply = ""
    got_result = False

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
            if inner_type == "content_block_delta":
                delta = inner.get("delta", {})
                if delta.get("type") == "thinking_delta":
                    yield ndjson({"type": "thinking_delta", "text": delta.get("thinking", "")})
                elif delta.get("type") == "text_delta":
                    text = delta.get("text", "")
                    full_reply += text
                    yield ndjson({"type": "text_delta", "text": text})
            elif inner_type == "message_delta":
                usage = inner.get("usage", {})
                if usage:
                    yield ndjson({"type": "usage", "output_tokens": usage.get("output_tokens")})
        elif evt_type == "result":
            got_result = True
            if evt.get("is_error"):
                yield ndjson({"type": "error", "message": evt.get("result") or "claude 返回了错误"})
            else:
                yield ndjson({
                    "type": "done",
                    "reply": evt.get("result", full_reply),
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


@app.post("/api/chat")
def chat(req: ChatRequest):
    if req.engine == "deepseek":
        # A raw HTTP call, not a claude subprocess: no ~13s CLI-startup
        # overhead, no per-turn mcp_server.py spawn. Same tool functions
        # either way (tutor_tools.py), same NDJSON event shape out, so the
        # frontend doesn't know or care which backend answered.
        return StreamingResponse(
            deepseek_chat.stream_chat(TUTOR_SYSTEM_PROMPT, req.message,
                                      session_id=req.session_id, model=req.model),
            media_type="application/x-ndjson",
        )
    # No context-stuffing on purpose: the agent has real tools and should
    # call them for whatever it actually needs, instead of every message
    # paying for the whole episode's subtitles whether relevant or not.
    return StreamingResponse(
        stream_claude_events(build_claude_command(req), req.message),
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
    uvicorn.run(app, host="0.0.0.0", port=8420)
