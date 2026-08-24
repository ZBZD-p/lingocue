#!/usr/bin/env python3
"""
Extract text subtitles from an MKV by walking the EBML structure directly and
*seeking past* video/audio payloads instead of reading them.

Why this exists: ffmpeg extracts subtitles by demuxing the whole container --
on a 7.5GB 4K episode that's a full 7.5GB sequential read (~84s measured),
even though the subtitle track itself is only ~30KB. ffmpeg is built for
transcoding pipelines, so it streams everything through.

An MKV is a tree of EBML elements, each prefixed with an ID and a size. That
means a reader can look at a block's header, see it belongs to the video
track, and jump the file pointer past its payload without ever transferring
those bytes. Only subtitle blocks get read. The volume of data actually
pulled off disk drops from "the whole file" to "block headers plus the
subtitle track".

Supports the text codecs that matter here (SubRip / SSA / ASS). Image-based
subtitles (PGS, VobSub) are out of scope -- those need OCR, not extraction.

Usage:
    python mkv_subs.py VIDEO.mkv --lang en -o out.srt
    python mkv_subs.py VIDEO.mkv --list
"""

import argparse
import re
import sys
import time
from pathlib import Path

# ---- EBML element IDs (stored with their length-marker bits intact) -------
ID_SEGMENT = 0x18538067
ID_INFO = 0x1549A966
ID_TIMECODE_SCALE = 0x2AD7B1
ID_TRACKS = 0x1654AE6B
ID_TRACK_ENTRY = 0xAE
ID_TRACK_NUMBER = 0xD7
ID_TRACK_TYPE = 0x83
ID_CODEC_ID = 0x86
ID_LANGUAGE = 0x22B59C
ID_TRACK_NAME = 0x536E
ID_CLUSTER = 0x1F43B675
ID_TIMECODE = 0xE7
ID_SIMPLE_BLOCK = 0xA3
ID_BLOCK_GROUP = 0xA0
ID_BLOCK = 0xA1
ID_BLOCK_DURATION = 0x9B

TRACK_TYPE_SUBTITLE = 0x11

# Master elements we descend into rather than skip.
MASTER_IDS = {ID_SEGMENT, ID_INFO, ID_TRACKS, ID_TRACK_ENTRY, ID_CLUSTER, ID_BLOCK_GROUP}

TEXT_CODECS = {
    "S_TEXT/UTF8": "srt",
    "S_TEXT/ASCII": "srt",
    "S_TEXT/SSA": "ass",
    "S_TEXT/ASS": "ass",
    "S_SSA": "ass",
    "S_ASS": "ass",
}

UNKNOWN_SIZE = object()


class Reader:
    """Buffered EBML primitive reader over a binary file object."""

    def __init__(self, f):
        self.f = f

    def tell(self):
        return self.f.tell()

    def seek(self, pos, whence=0):
        self.f.seek(pos, whence)

    def read(self, n):
        return self.f.read(n)

    def read_id(self):
        """Element IDs keep their marker bits -- the raw bytes *are* the ID."""
        first = self.f.read(1)
        if not first:
            return None
        b0 = first[0]
        if b0 & 0x80:
            length = 1
        elif b0 & 0x40:
            length = 2
        elif b0 & 0x20:
            length = 3
        elif b0 & 0x10:
            length = 4
        else:
            # Not a valid ID start byte -- the stream is misaligned.
            return None
        value = b0
        for byte in self.f.read(length - 1):
            value = (value << 8) | byte
        return value

    def read_size(self):
        """Sizes are VINTs with the marker bit stripped. All-ones means the
        element runs until the next element that can follow it (used for
        live-muxed clusters), which we report as UNKNOWN_SIZE."""
        first = self.f.read(1)
        if not first:
            return None
        b0 = first[0]
        mask = 0x80
        length = 1
        while length <= 8 and not (b0 & mask):
            mask >>= 1
            length += 1
        if length > 8:
            return None
        value = b0 & (mask - 1)
        all_ones = value == (mask - 1)
        for byte in self.f.read(length - 1):
            value = (value << 8) | byte
            all_ones = all_ones and byte == 0xFF
        return UNKNOWN_SIZE if all_ones else value


def _uint(data: bytes) -> int:
    value = 0
    for byte in data:
        value = (value << 8) | byte
    return value


def read_block_track_and_time(data: bytes):
    """Parse the front of a (Simple)Block: track number VINT, then a signed
    16-bit timecode relative to the cluster, then flags. Returns
    (track_number, relative_ms, payload_offset)."""
    b0 = data[0]
    mask = 0x80
    length = 1
    while length <= 8 and not (b0 & mask):
        mask >>= 1
        length += 1
    track = b0 & (mask - 1)
    for byte in data[1:length]:
        track = (track << 8) | byte
    rel = int.from_bytes(data[length:length + 2], "big", signed=True)
    return track, rel, length + 3


def read_tracks(reader: Reader, tracks_end: int) -> list[dict]:
    tracks = []
    while reader.tell() < tracks_end:
        elem_id = reader.read_id()
        if elem_id is None:
            break
        size = reader.read_size()
        if size is None or size is UNKNOWN_SIZE:
            break
        end = reader.tell() + size
        if elem_id == ID_TRACK_ENTRY:
            # Per the Matroska spec an absent Language element means "eng" --
            # which is exactly how English tracks usually show up, untagged
            # while the other languages carry explicit tags. Defaulting to ""
            # here would make an --lang en request fall through to the first
            # track in the file (typically Chinese) instead.
            entry = {"number": None, "type": None, "codec": "", "language": "eng", "title": ""}
            while reader.tell() < end:
                sub_id = reader.read_id()
                if sub_id is None:
                    break
                sub_size = reader.read_size()
                if sub_size is None or sub_size is UNKNOWN_SIZE:
                    break
                payload = reader.read(sub_size)
                if sub_id == ID_TRACK_NUMBER:
                    entry["number"] = _uint(payload)
                elif sub_id == ID_TRACK_TYPE:
                    entry["type"] = _uint(payload)
                elif sub_id == ID_CODEC_ID:
                    entry["codec"] = payload.decode("ascii", "replace").rstrip("\x00")
                elif sub_id == ID_LANGUAGE:
                    entry["language"] = payload.decode("ascii", "replace").rstrip("\x00")
                elif sub_id == ID_TRACK_NAME:
                    entry["title"] = payload.decode("utf-8", "replace").rstrip("\x00")
            reader.seek(end)
            if entry["type"] == TRACK_TYPE_SUBTITLE and entry["number"] is not None:
                tracks.append(entry)
        else:
            reader.seek(end)
    return tracks


def _scan_segment(reader: Reader, segment_end: int, want_track: int | None,
                  on_progress=None):
    """Walk the segment. Returns (subtitle_tracks, cues) -- cues is empty when
    want_track is None (metadata-only pass).

    on_progress(cues, fraction) is called periodically with the cues found so
    far, in order, so a caller can display early subtitles while the rest of
    the file is still being scanned."""
    tracks: list[dict] = []
    cues: list[tuple[int, int | None, str]] = []
    timecode_scale = 1_000_000  # nanoseconds per tick; 1ms default
    cluster_time = 0
    segment_start = reader.tell()
    span = max(1, segment_end - segment_start)
    last_report = 0.0

    while reader.tell() < segment_end:
        elem_id = reader.read_id()
        if elem_id is None:
            break
        size = reader.read_size()
        if size is None:
            break
        start = reader.tell()

        if size is UNKNOWN_SIZE:
            # Only clusters realistically use this; descend and let the inner
            # loop resync on the next recognizable element.
            if elem_id in MASTER_IDS:
                continue
            break

        end = start + size

        if elem_id == ID_TRACKS:
            tracks = read_tracks(reader, end)
            reader.seek(end)
            if want_track is None:
                return tracks, cues
            continue

        if elem_id == ID_INFO:
            while reader.tell() < end:
                sub_id = reader.read_id()
                if sub_id is None:
                    break
                sub_size = reader.read_size()
                if sub_size is None or sub_size is UNKNOWN_SIZE:
                    break
                payload = reader.read(sub_size)
                if sub_id == ID_TIMECODE_SCALE:
                    timecode_scale = _uint(payload) or timecode_scale
            reader.seek(end)
            continue

        if elem_id == ID_CLUSTER and want_track is not None:
            cluster_time = _scan_cluster(reader, end, want_track, timecode_scale, cues)
            reader.seek(end)
            if on_progress is not None:
                now = time.monotonic()
                if now - last_report >= 0.5:
                    last_report = now
                    on_progress(cues, (end - segment_start) / span)
            continue

        # Everything else (Cues, SeekHead, Attachments, Tags, and clusters we
        # don't care about) gets jumped over -- this is the whole point: the
        # bytes never leave the disk.
        reader.seek(end)

    return tracks, cues


def _scan_cluster(reader: Reader, cluster_end: int, want_track: int,
                  timecode_scale: int, cues: list) -> int:
    cluster_time = 0
    ms_per_tick = timecode_scale / 1_000_000
    while reader.tell() < cluster_end:
        elem_id = reader.read_id()
        if elem_id is None:
            break
        size = reader.read_size()
        if size is None or size is UNKNOWN_SIZE:
            break
        end = reader.tell() + size

        if elem_id == ID_TIMECODE:
            cluster_time = _uint(reader.read(size))
            continue

        if elem_id == ID_SIMPLE_BLOCK:
            # Peek just the header. If it's another track, skip the payload.
            head = reader.read(min(12, size))
            track, rel, offset = read_block_track_and_time(head)
            if track != want_track:
                reader.seek(end)
                continue
            reader.seek(end - size + offset)
            text = reader.read(end - reader.tell()).decode("utf-8", "replace")
            start_ms = int((cluster_time + rel) * ms_per_tick)
            cues.append((start_ms, None, text))
            reader.seek(end)
            continue

        if elem_id == ID_BLOCK_GROUP:
            group_end = end
            block_start = None
            block_text = None
            duration = None
            while reader.tell() < group_end:
                sub_id = reader.read_id()
                if sub_id is None:
                    break
                sub_size = reader.read_size()
                if sub_size is None or sub_size is UNKNOWN_SIZE:
                    break
                sub_end = reader.tell() + sub_size
                if sub_id == ID_BLOCK:
                    head = reader.read(min(12, sub_size))
                    track, rel, offset = read_block_track_and_time(head)
                    if track == want_track:
                        reader.seek(sub_end - sub_size + offset)
                        block_text = reader.read(sub_end - reader.tell()).decode("utf-8", "replace")
                        block_start = int((cluster_time + rel) * ms_per_tick)
                    reader.seek(sub_end)
                elif sub_id == ID_BLOCK_DURATION:
                    duration = int(_uint(reader.read(sub_size)) * ms_per_tick)
                else:
                    reader.seek(sub_end)
            if block_text is not None and block_start is not None:
                end_ms = block_start + duration if duration is not None else None
                cues.append((block_start, end_ms, block_text))
            reader.seek(group_end)
            continue

        reader.seek(end)
    return cluster_time


def _open_segment(reader: Reader, file_size: int) -> int:
    """Skip the EBML header and enter the Segment; returns its end offset."""
    while True:
        elem_id = reader.read_id()
        if elem_id is None:
            raise ValueError("这不是一个有效的 EBML/MKV 文件。")
        size = reader.read_size()
        if size is None:
            raise ValueError("这不是一个有效的 EBML/MKV 文件。")
        if elem_id == ID_SEGMENT:
            return file_size if size is UNKNOWN_SIZE else reader.tell() + size
        reader.seek(size, 1)


def list_subtitle_tracks(video: Path) -> list[dict]:
    file_size = video.stat().st_size
    with open(video, "rb") as f:
        reader = Reader(f)
        segment_end = _open_segment(reader, file_size)
        tracks, _ = _scan_segment(reader, segment_end, None)
    return tracks


LANG_HINTS = {
    "en": ["eng", "en", "english"],
    "zh": ["chs", "cht", "chi", "zh", "zho", "chinese", "简体", "繁体", "中字", "中文"],
}


def pick_track(tracks: list[dict], lang: str | None) -> dict | None:
    text_tracks = [t for t in tracks if t["codec"] in TEXT_CODECS]
    if not text_tracks:
        return None
    if lang:
        hints = LANG_HINTS.get(lang, [lang])
        for t in text_tracks:
            haystack = f"{t['language']} {t['title']}".lower()
            if any(h in haystack for h in hints):
                return t
    return text_tracks[0]


def extract_cues(video: Path, lang: str | None = None, on_progress=None) -> tuple[dict, list]:
    """Returns (track_info, cues) where cues are (start_ms, end_ms|None, text).

    on_progress(normalized_cues, fraction) fires periodically during the scan
    so callers can show subtitles from the start of the episode while the
    tail is still being read."""
    file_size = video.stat().st_size
    with open(video, "rb") as f:
        reader = Reader(f)
        segment_end = _open_segment(reader, file_size)
        tracks, _ = _scan_segment(reader, segment_end, None)
        track = pick_track(tracks, lang)
        if track is None:
            raise RuntimeError(
                "这个 MKV 里没有可直接提取的文字字幕轨道"
                "（图形字幕如 PGS/VobSub 需要 OCR，不在支持范围）。"
            )

        wrapped = None
        if on_progress is not None:
            def wrapped(raw_cues, fraction):
                # Hand out display-ready cues; the raw form still carries ASS
                # field/markup wrappers the UI shouldn't see.
                on_progress(normalize_cues(track, raw_cues), fraction)

        f.seek(0)
        reader = Reader(f)
        segment_end = _open_segment(reader, file_size)
        _, cues = _scan_segment(reader, segment_end, track["number"], on_progress=wrapped)
    cues.sort(key=lambda c: c[0])
    return track, cues


ASS_TAG_RE = re.compile(r"\{[^}]*\}")


def _ass_text(raw: str) -> str:
    # ASS block payloads in MKV are the Dialogue fields *after* the first 8
    # commas (ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect).
    parts = raw.split(",", 8)
    text = parts[8] if len(parts) == 9 else raw
    return ASS_TAG_RE.sub("", text).replace("\\N", " ").replace("\\n", " ").strip()


def _fmt_ts(ms: int) -> str:
    if ms < 0:
        ms = 0
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms_part = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms_part:03d}"


def normalize_cues(track: dict, cues: list) -> list[tuple[int, int, str]]:
    """Raw block payloads -> display-ready (start_ms, end_ms, text) tuples:
    ASS field/markup stripped, blank cues dropped, missing end times filled."""
    kind = TEXT_CODECS.get(track["codec"], "srt")
    out = []
    for i, (start_ms, end_ms, raw) in enumerate(cues, 1):
        text = _ass_text(raw) if kind == "ass" else raw.strip()
        if not text:
            continue
        if end_ms is None:
            # SimpleBlocks carry no duration; run until the next cue (capped)
            # so the line doesn't linger for the rest of the episode.
            nxt = cues[i][0] if i < len(cues) else start_ms + 3000
            end_ms = min(nxt, start_ms + 8000)
        out.append((start_ms, end_ms, text))
    return out


def to_srt(track: dict, cues: list) -> str:
    blocks = [
        f"{i}\n{_fmt_ts(start)} --> {_fmt_ts(end)}\n{text}\n"
        for i, (start, end, text) in enumerate(normalize_cues(track, cues), 1)
    ]
    return "\n".join(blocks)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("video")
    parser.add_argument("--lang", help="偏好语言，比如 en / zh")
    parser.add_argument("-o", "--out", help="输出 .srt 路径")
    parser.add_argument("--list", action="store_true", help="只列出文字字幕轨道")
    args = parser.parse_args()

    video = Path(args.video)
    if args.list:
        for t in list_subtitle_tracks(video):
            mark = "" if t["codec"] in TEXT_CODECS else "  (图形字幕，不支持)"
            print(f"  track {t['number']}  {t['codec']}  lang={t['language'] or '?'}  {t['title']}{mark}")
        return

    track, cues = extract_cues(video, args.lang)
    srt = to_srt(track, cues)
    if args.out:
        Path(args.out).write_text(srt, encoding="utf-8")
        print(f"track {track['number']} ({track['codec']}, {track['language']}) -> {args.out}  ({len(cues)} cues)")
    else:
        sys.stdout.write(srt)


if __name__ == "__main__":
    main()
