#!/usr/bin/env python3
"""
MCP server exposing playback/subtitle access as tools, so the tutor agent can
look things up on demand instead of the backend stuffing the whole episode's
subtitles into every prompt.

Tools:
    get_playback_status()                           -- what's playing, where
    get_subtitle_near_now(window_seconds, lang)     -- subtitles around "now"
    get_subtitle_range(start_seconds, end_seconds)  -- an explicit window
    search_subtitles(query, lang)                   -- find a phrase anywhere

Runs as a separate subprocess spawned by the `claude` CLI per chat turn (see
app.py's --mcp-config), which is why playback state goes through a file
rather than app.py's memory -- see playback.py.

The tools themselves live in tutor_tools.py, not here: this file's only job
is wrapping them for the MCP protocol Claude Code speaks. deepseek_chat.py
calls the same underlying functions directly, with no MCP client in between
-- a hand-rolled tool loop has no use for MCP, and duplicating the lookup
logic in two places would just let them drift apart.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import tutor_tools  # noqa: E402

from mcp.server.mcpserver import MCPServer  # noqa: E402

mcp = MCPServer("video-subtitles")


@mcp.tool()
def get_playback_status() -> dict:
    """Get what's currently playing right now: video title, current playback
    position (seconds), total duration (seconds), and whether it's
    playing/paused. Call this first if you don't already know the current
    position."""
    return tutor_tools.get_playback_status()


@mcp.tool()
def get_subtitle_near_now(window_seconds: float = 15.0, lang: str = "en") -> dict:
    """Get subtitle lines from the last `window_seconds` up to the CURRENT
    playback position. Use this for "what did they just say" / "explain this
    part" style questions where the user means whatever's playing right now.
    Does NOT load the whole episode -- only this recent window."""
    return tutor_tools.get_subtitle_near_now(window_seconds, lang)


@mcp.tool()
def get_subtitle_range(start_seconds: float, end_seconds: float, lang: str = "en") -> dict:
    """Get subtitle lines for an EXPLICIT time range in the currently-playing
    video (e.g. start_seconds=300, end_seconds=360 for the 5:00-6:00 mark).
    Use this to look at a specific part of the episode -- earlier/later than
    now, or a scene the user names by time -- without loading the whole
    episode's subtitles."""
    return tutor_tools.get_subtitle_range(start_seconds, end_seconds, lang)


@mcp.tool()
def search_subtitles(query: str, lang: str = "en", max_results: int = 15) -> dict:
    """Search the ENTIRE currently-playing episode's subtitles for a word or
    phrase (case-insensitive substring match) and return matching lines with
    their timestamps in seconds. Use this to find where in the episode
    something was said -- this is how you look at material outside the
    current playback window WITHOUT loading the whole transcript into
    context."""
    return tutor_tools.search_subtitles(query, lang, max_results)


if __name__ == "__main__":
    mcp.run()
