#!/usr/bin/env python3
"""
Subtitle sourcing and time-window lookup for the currently-playing video.

Sources subtitles (sidecar file, previously extracted cache, or a fresh
extraction from the container) and slices them by timestamp, so callers can
ask for "the lines between these two positions" without caring where the
subtitles came from.

Carried over from the PotPlayer-era version of this tool, minus its CLI:
playback position now comes from Jellyfin (see playback.py), so nothing here
needs to know how the player reports where it is -- callers pass timestamps
in directly.
"""

import os
import re
import sys
import threading
from pathlib import Path

if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_subs  # noqa: E402
import mkv_subs  # noqa: E402

SRT_TIME_RE = re.compile(r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})")
ASS_TIME_RE = re.compile(r"(\d{1,2}):(\d{2}):(\d{2})\.(\d{2})")
ASS_TAG_RE = re.compile(r"\{[^}]*\}")


def _clock_to_ms(h, m, s, frac, frac_is_centiseconds=False) -> int:
    ms = int(frac) * 10 if frac_is_centiseconds else int(frac)
    return ((int(h) * 60 + int(m)) * 60 + int(s)) * 1000 + ms


def parse_srt_cues(path: Path) -> list[tuple[int, int, str]]:
    text = path.read_text(encoding="utf-8", errors="ignore")
    cues = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = block.splitlines()
        time_idx = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if time_idx is None:
            continue
        times = SRT_TIME_RE.findall(lines[time_idx])
        if len(times) < 2:
            continue
        start_ms = _clock_to_ms(*times[0])
        end_ms = _clock_to_ms(*times[1])
        raw_text = " ".join(lines[time_idx + 1:])
        cue_text = re.sub(r"<[^>]+>", "", raw_text).strip()
        if cue_text:
            cues.append((start_ms, end_ms, cue_text))
    return cues


def parse_ass_cues(path: Path) -> list[tuple[int, int, str]]:
    text = path.read_text(encoding="utf-8", errors="ignore")
    cues = []
    for line in text.splitlines():
        if not line.startswith("Dialogue:"):
            continue
        parts = line.split(",", 9)
        if len(parts) < 10:
            continue
        start_m = ASS_TIME_RE.match(parts[1].strip())
        end_m = ASS_TIME_RE.match(parts[2].strip())
        if not start_m or not end_m:
            continue
        start_ms = _clock_to_ms(*start_m.groups(), frac_is_centiseconds=True)
        end_ms = _clock_to_ms(*end_m.groups(), frac_is_centiseconds=True)
        cue_text = ASS_TAG_RE.sub("", parts[9]).replace("\\N", " ").strip()
        if cue_text:
            cues.append((start_ms, end_ms, cue_text))
    return cues


def parse_cues(subtitle_path: Path) -> list[tuple[int, int, str]]:
    if subtitle_path.suffix.lower() in (".ass", ".ssa"):
        return parse_ass_cues(subtitle_path)
    return parse_srt_cues(subtitle_path)


# A cue pair counts as a match when they overlap by this much of the shorter
# of the two -- relative to the shorter one on purpose, so a brief Chinese
# line sitting inside a long English sentence still counts as a full match
# instead of being scored down for being short.
MERGE_MIN_OVERLAP = 0.3


def merge_cues(primary: list[tuple[int, int, str]],
               secondary: list[tuple[int, int, str]],
               min_overlap: float = MERGE_MIN_OVERLAP) -> list[tuple[int, int, str, str | None]]:
    """Pair each primary cue with the secondary-language text covering the
    same moment, returning (start_ms, end_ms, text, text2 | None).

    The two tracks are cut independently -- a translation routinely splits or
    merges lines relative to the original -- so pairing by index would drift
    apart within a few exchanges. Overlap in time is the only thing the two
    reliably share.

    Both lists are sorted by start, so this sweeps them together rather than
    rescanning the secondary list per cue: an episode is 400+ lines each side
    and the quadratic version is felt on every page load.
    """
    merged = []
    j = 0
    for start, end, text in primary:
        # Secondary cues ending before this one starts can't overlap it, and
        # can't overlap anything later either -- so drop them for good.
        while j < len(secondary) and secondary[j][1] <= start:
            j += 1

        parts = []
        k = j
        while k < len(secondary) and secondary[k][0] < end:
            s2, e2, text2 = secondary[k]
            overlap = min(end, e2) - max(start, s2)
            shorter = max(1, min(end - start, e2 - s2))
            if overlap / shorter >= min_overlap:
                parts.append(text2)
            k += 1

        # Several matches get joined: a translation often covers one long
        # original line with two short ones.
        merged.append((start, end, text, " ".join(parts) if parts else None))
    return merged


# Guards concurrent extraction of the *same* video within this process --
# e.g. the chat context poll and the subtitle-card page both resolving a
# freshly-opened episode's subtitles around the same time. Without this,
# both would independently kick off ffmpeg extraction; the atomic rename in
# extract_embedded_track already prevents a torn read, but the lock also
# avoids doing the (slow, first-time) extraction work twice.
_extract_locks_guard = threading.Lock()
_extract_locks: dict[str, threading.Lock] = {}


def _lock_for(key: str) -> threading.Lock:
    with _extract_locks_guard:
        lock = _extract_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _extract_locks[key] = lock
        return lock


def cache_path(video: Path, lang: str, out_dir: Path) -> Path:
    """Where an extracted track for this language is cached.

    The language belongs in the filename: without it, asking for Chinese on a
    video whose English track was already extracted just hands back the
    English file, and a bilingual view ends up showing the same text twice.
    """
    return out_dir / f"{video.stem}.extracted.{lang}.srt"


def find_existing_subtitle(video: Path, lang: str, out_dir: Path) -> Path | None:
    """Whatever subtitle is available *right now* -- a sidecar file, or a
    previously extracted cache -- without ever starting a new extraction.
    Callers that must not block (request handlers) use this."""
    sidecar = extract_subs.find_sidecar_subtitle(video, lang)
    if sidecar:
        return sidecar
    cached = cache_path(video, lang, out_dir)
    if cached.exists():
        return cached
    # Caches written before the filename carried a language are all English:
    # nothing ever asked for anything else, since the only caller hardcoded
    # lang=en. Reading them saves re-extracting an entire season at ~24s an
    # episode. Nothing renames or deletes them -- this is read-only fallback.
    if lang == "en":
        legacy = out_dir / f"{video.stem}.extracted.srt"
        if legacy.exists():
            return legacy
    return None


def pick_subtitle_track(video: Path, lang: str) -> dict:
    ffprobe = extract_subs.find_tool("ffprobe")
    tracks = extract_subs.list_subtitle_tracks(video, ffprobe)
    track = extract_subs.pick_track(tracks, lang)
    if not track:
        raise RuntimeError(f"这个视频没有外挂字幕，也没有内嵌 {lang} 字幕轨道。")
    return track


def resolve_subtitle(video: Path, lang: str, out_dir: Path, on_progress=None) -> Path:
    existing = find_existing_subtitle(video, lang, out_dir)
    if existing:
        return existing

    cached = cache_path(video, lang, out_dir)
    with _lock_for(str(cached)):
        if cached.exists():  # another thread may have finished while we waited
            return cached

        # Preferred path for MKV: walk the EBML structure ourselves and seek
        # past video/audio payloads instead of streaming the whole container
        # through ffmpeg. Measured on cold 8GB 4K episodes: ~24s vs ~75s, with
        # byte-identical output. It also reports progress as it goes, so the
        # UI can show early subtitles before the scan reaches the end.
        if video.suffix.lower() == ".mkv":
            try:
                track, cues = mkv_subs.extract_cues(video, lang, on_progress=on_progress)
                srt = mkv_subs.to_srt(track, cues)
                tmp = cached.with_name(f"{cached.stem}.partial.srt")
                tmp.write_text(srt, encoding="utf-8")
                os.replace(tmp, cached)
                return cached
            except Exception:
                # Falls through to ffmpeg -- covers image-based tracks (PGS,
                # VobSub) and any container quirk the parser doesn't handle.
                pass

        ffmpeg = extract_subs.find_tool("ffmpeg")
        track = pick_subtitle_track(video, lang)
        extract_subs.extract_embedded_track(video, track["index"], ffmpeg, cached)
        return cached


def get_recent_window(video: Path, lang: str, out_dir: Path, position_ms: int,
                      window_start_ms: int, allow_extract: bool = True):
    """Resolve subtitles for `video` and return (subtitle_path, dedup'd lines,
    cue_count) for cues in [window_start_ms, position_ms].

    With allow_extract=False this never starts an extraction -- it raises if
    nothing is cached yet. Request handlers use that so they can't block for
    the ~80s a cold full-container read takes; they kick extraction off on a
    background thread instead."""
    if allow_extract:
        subtitle_path = resolve_subtitle(video, lang, out_dir)
    else:
        subtitle_path = find_existing_subtitle(video, lang, out_dir)
        if subtitle_path is None:
            raise RuntimeError("字幕还没提取好")
    cues = parse_cues(subtitle_path)
    selected = [c for c in cues if window_start_ms <= c[0] <= position_ms]

    seen = set()
    lines = []
    for _, _, text in selected:
        if text not in seen:
            seen.add(text)
            lines.append(text)

    return subtitle_path, lines, len(selected)
