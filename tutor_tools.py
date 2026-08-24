#!/usr/bin/env python3
"""
Playback/subtitle lookups the tutor agent can call as tools, shared by
whichever chat backend is driving the conversation.

Plain functions here, not @mcp.tool()-decorated ones: mcp_server.py wraps
these for the Claude Code CLI path (which only speaks MCP), and
deepseek_chat.py calls them directly for the DeepSeek path (a hand-rolled
tool loop has no MCP client in the middle, so there is nothing here for MCP
to add). Splitting the logic out once, so both paths look up "what's playing"
the same way and can't quietly drift apart from each other.
"""

from pathlib import Path

import playback
import subs_now


def _dedupe_texts(cues: list[tuple[int, int, str]]) -> list[str]:
    seen = set()
    lines = []
    for _, _, text in cues:
        if text not in seen:
            seen.add(text)
            lines.append(text)
    return lines


def _video_and_cues(lang: str):
    video = playback.current_video()
    subtitle_path = subs_now.resolve_subtitle(video, lang, video.parent)
    cues = subs_now.parse_cues(subtitle_path)
    return video, cues


def get_playback_status() -> dict:
    """Get what's currently playing right now: video title, current playback
    position (seconds), total duration (seconds), and whether it's
    playing/paused. Call this first if you don't already know the current
    position."""
    info = playback.read()
    return {
        "video_title": info["title"],
        "position_seconds": round(info["position_ms"] / 1000, 1),
        "duration_seconds": round(info["duration_ms"] / 1000, 1),
        "status": info["status"],
    }


def get_subtitle_near_now(window_seconds: float = 15.0, lang: str = "en") -> dict:
    """Get subtitle lines from the last `window_seconds` up to the CURRENT
    playback position. Use this for "what did they just say" / "explain this
    part" style questions where the user means whatever's playing right now.
    Does NOT load the whole episode -- only this recent window."""
    position_ms = playback.read()["position_ms"]
    video, cues = _video_and_cues(lang)
    start_ms = max(0, position_ms - int(window_seconds * 1000))
    selected = [c for c in cues if start_ms <= c[0] <= position_ms]
    return {
        "video_title": video.name,
        "position_seconds": round(position_ms / 1000, 1),
        "window_start_seconds": round(start_ms / 1000, 1),
        "lines": _dedupe_texts(selected),
    }


def get_subtitle_range(start_seconds: float, end_seconds: float, lang: str = "en") -> dict:
    """Get subtitle lines for an EXPLICIT time range in the currently-playing
    video (e.g. start_seconds=300, end_seconds=360 for the 5:00-6:00 mark).
    Use this to look at a specific part of the episode -- earlier/later than
    now, or a scene the user names by time -- without loading the whole
    episode's subtitles."""
    video, cues = _video_and_cues(lang)
    start_ms, end_ms = int(start_seconds * 1000), int(end_seconds * 1000)
    selected = [c for c in cues if start_ms <= c[0] <= end_ms]
    return {
        "video_title": video.name,
        "range_seconds": [start_seconds, end_seconds],
        "lines": _dedupe_texts(selected),
    }


def search_subtitles(query: str, lang: str = "en", max_results: int = 15) -> dict:
    """Search the ENTIRE currently-playing episode's subtitles for a word or
    phrase (case-insensitive substring match) and return matching lines with
    their timestamps in seconds. Use this to find where in the episode
    something was said -- this is how you look at material outside the
    current playback window WITHOUT loading the whole transcript into
    context."""
    video, cues = _video_and_cues(lang)
    q = query.lower()
    matches = []
    for start_ms, _end_ms, text in cues:
        if q in text.lower():
            matches.append({"time_seconds": round(start_ms / 1000, 1), "text": text})
            if len(matches) >= max_results:
                break
    return {"video_title": video.name, "query": query, "matches": matches}


# name -> (callable, JSON-schema parameters). One place both chat backends
# read from: mcp_server.py's @mcp.tool() wrappers infer their schema from
# type hints, but a hand-rolled tool-calling loop has no such inference and
# needs the schema written out plainly.
TOOLS = {
    "get_playback_status": (
        get_playback_status,
        {"type": "object", "properties": {}, "required": []},
    ),
    "get_subtitle_near_now": (
        get_subtitle_near_now,
        {
            "type": "object",
            "properties": {
                "window_seconds": {"type": "number", "description": "How far back from now, in seconds. Default 15."},
                "lang": {"type": "string", "description": "Subtitle language code. Default 'en'."},
            },
            "required": [],
        },
    ),
    "get_subtitle_range": (
        get_subtitle_range,
        {
            "type": "object",
            "properties": {
                "start_seconds": {"type": "number"},
                "end_seconds": {"type": "number"},
                "lang": {"type": "string", "description": "Subtitle language code. Default 'en'."},
            },
            "required": ["start_seconds", "end_seconds"],
        },
    ),
    "search_subtitles": (
        search_subtitles,
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Word or phrase to search for (case-insensitive substring match)."},
                "lang": {"type": "string", "description": "Subtitle language code. Default 'en'."},
                "max_results": {"type": "integer", "description": "Cap on matches returned. Default 15."},
            },
            "required": ["query"],
        },
    ),
}


def tool_descriptions() -> dict[str, str]:
    """Each tool's full docstring, whitespace-normalized, keyed by name.

    The whole docstring, not just its first line: the guidance on *when* to
    reach for a tool ("use this for 'what did they just say' style
    questions", "without loading the whole episode's subtitles") lives past
    the first sentence, and a model deciding which of four lookups fits a
    question needs that, not just what each one technically returns.
    """
    import re
    return {
        name: re.sub(r"\s+", " ", (fn.__doc__ or "")).strip()
        for name, (fn, _schema) in TOOLS.items()
    }
