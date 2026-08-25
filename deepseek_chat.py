#!/usr/bin/env python3
"""
DeepSeek-backed alternative to the Claude Code CLI chat path in app.py.

Why this exists: a bare `claude -p` invocation costs ~13s of fixed startup
overhead before it generates a single token (measured earlier this session --
even a trivial one-line reply took that long), and every chat turn on top of
that spawns a fresh mcp_server.py subprocess for MCP tool access. A raw HTTP
call to a hosted API has neither cost.

There is no MCP layer here: MCP is Claude Code CLI's protocol for reaching
tools, and a hand-rolled tool-calling loop against an OpenAI-compatible API
has its own equivalent (the `tools` request field, `tool_calls` in the
response) that doesn't need MCP as an intermediary. Both paths end up calling
the exact same functions in tutor_tools.py either way.

Streaming events are emitted in the same NDJSON shape stream_claude_events()
in app.py already produces (thinking_delta / text_delta / usage / done /
error), so the frontend needs no changes to consume either backend -- only
app.py's chat() picks which generator to hand to the response stream.
"""

import json
import re
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import tutor_tools

CONFIG_FILE = Path(__file__).resolve().parent / "deepseek_config.json"
DEFAULT_MODEL = "deepseek-chat"
DEFAULT_BASE_URL = "https://api.deepseek.com"

# A runaway tool-call loop (model keeps calling tools and never answers)
# shouldn't spin forever -- bounded the same way MAX_CARD_CHARS or
# PUNCTUATE_TIMEOUT_S elsewhere in this project bound their own loops.
MAX_TOOL_ROUNDS = 6

_config = None


def config() -> dict | None:
    """None (not an error) when the file doesn't exist yet -- unconfigured
    is an expected, normal state here, unlike jellyfin.config() where the
    file is assumed to already exist."""
    global _config
    if _config is None:
        if not CONFIG_FILE.exists():
            return None
        _config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    return _config


def reload_config() -> None:
    """Called after the settings page writes a new key/model, so this
    process picks it up without a restart -- config() alone would keep
    serving the cached (possibly pre-existing, possibly absent) value."""
    global _config
    _config = None


# tutor_tools.TOOLS already pairs each function with its JSON-schema
# parameters; this just wraps that into the shape an OpenAI-compatible
# `tools` request field expects, with the full docstring (not just its first
# line -- see tutor_tools.tool_descriptions) as each one's description.
def _tool_schemas() -> list[dict]:
    descriptions = tutor_tools.tool_descriptions()
    return [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": descriptions[name],
                "parameters": schema,
            },
        }
        for name, (_fn, schema) in tutor_tools.TOOLS.items()
    ]


# sessions: session_id -> message list. In-memory, lost on restart -- matches
# the durability bar other best-effort state in this backend already accepts
# (app.py's own _extract_states is the same kind of thing), and Claude Code
# CLI's --resume session store isn't treated as something users depend on
# surviving a restart either.
_sessions: dict[str, list[dict]] = {}


def ndjson(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


def _post(cfg: dict, messages: list[dict]):
    body = json.dumps({
        "model": cfg.get("model") or DEFAULT_MODEL,
        "messages": messages,
        "tools": _tool_schemas(),
        "stream": True,
    }).encode("utf-8")
    req = urllib.request.Request(
        (cfg.get("base_url") or DEFAULT_BASE_URL).rstrip("/") + "/chat/completions",
        data=body, method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {cfg['api_key']}",
        },
    )
    return urllib.request.urlopen(req, timeout=120)


def _execute_tool(name: str, arguments_json: str):
    entry = tutor_tools.TOOLS.get(name)
    if not entry:
        return {"error": f"unknown tool: {name}"}
    fn, _schema = entry
    try:
        args = json.loads(arguments_json) if arguments_json.strip() else {}
        return fn(**args)
    except Exception as e:
        # A malformed tool call becomes a tool *result* the model can see and
        # react to (retry with corrected arguments, or explain the failure to
        # the user), not a hard error that kills the whole turn.
        return {"error": str(e) or repr(e)}


def stream_chat(system_prompt: str, user_message: str,
                session_id: str | None = None, model: str | None = None):
    """Mirrors stream_claude_events()'s contract: yields NDJSON strings,
    ending in exactly one `done` or `error` event."""
    cfg = config()
    if not cfg or not cfg.get("api_key"):
        yield ndjson({"type": "error",
                     "message": "DeepSeek 还没配置 API key，去设置页填一下。"})
        return
    if model:
        cfg = {**cfg, "model": model}

    sid = session_id or str(uuid.uuid4())
    messages = _sessions.get(sid)
    if messages is None:
        messages = [{"role": "system", "content": system_prompt}]
    messages.append({"role": "user", "content": user_message})

    full_reply = ""
    for _round in range(MAX_TOOL_ROUNDS):
        try:
            resp = _post(cfg, messages)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:500]
            yield ndjson({"type": "error", "message": f"DeepSeek 返回错误 {e.code}：{detail}"})
            return
        except Exception as e:
            yield ndjson({"type": "error", "message": str(e) or repr(e)})
            return

        assistant_content = ""
        # Streamed tool calls arrive as fragments keyed by index -- one
        # chunk might carry only a few characters of one argument string --
        # so they're accumulated across the whole response, not read whole.
        tool_calls: dict[int, dict] = {}
        finish_reason = None

        for raw_line in resp:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[len("data:"):].strip()
            if payload == "[DONE]":
                break
            try:
                chunk = json.loads(payload)
            except json.JSONDecodeError:
                continue
            choices = chunk.get("choices") or []
            if not choices:
                continue
            choice = choices[0]
            delta = choice.get("delta") or {}

            if delta.get("reasoning_content"):
                yield ndjson({"type": "thinking_delta", "text": delta["reasoning_content"]})
            if delta.get("content"):
                assistant_content += delta["content"]
                full_reply += delta["content"]
                yield ndjson({"type": "text_delta", "text": delta["content"]})
            for tc in delta.get("tool_calls") or []:
                idx = tc.get("index", 0)
                slot = tool_calls.setdefault(idx, {"id": None, "name": "", "arguments": ""})
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] += fn["name"]
                if fn.get("arguments"):
                    slot["arguments"] += fn["arguments"]
            if choice.get("finish_reason"):
                finish_reason = choice["finish_reason"]

        if finish_reason == "tool_calls" and tool_calls:
            ordered = [tool_calls[i] for i in sorted(tool_calls)]
            messages.append({
                "role": "assistant",
                "content": assistant_content or None,
                "tool_calls": [
                    {"id": t["id"], "type": "function",
                     "function": {"name": t["name"], "arguments": t["arguments"]}}
                    for t in ordered
                ],
            })
            for t in ordered:
                result = _execute_tool(t["name"], t["arguments"])
                messages.append({
                    "role": "tool",
                    "tool_call_id": t["id"],
                    "content": json.dumps(result, ensure_ascii=False),
                })
            continue  # ask again with the tool results appended

        messages.append({"role": "assistant", "content": assistant_content})
        _sessions[sid] = messages
        yield ndjson({"type": "done", "reply": full_reply, "session_id": sid})
        return

    yield ndjson({"type": "error", "message": "工具调用次数太多，可能陷入循环了。"})
