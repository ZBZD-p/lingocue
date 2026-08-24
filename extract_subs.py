#!/usr/bin/env python3
"""
Extract subtitles for whatever video PotPlayer currently has loaded.

Strategy:
1. Read PotPlayer's playlist file to find the current video path.
2. Look for a sidecar subtitle file next to the video (.srt/.ass/.ssa/.smi/.vtt),
   preferring English-tagged files if the user wants English (--lang en).
3. If no sidecar file exists, use ffprobe/ffmpeg to pull an embedded subtitle
   track out of the video container (mkv/mp4) and convert it to .srt.
4. Emit both the raw .srt and a cleaned plain-text version (dedup'd, no
   timestamps/cues) next to the video, plus print a short summary to stdout.

Usage:
    python extract_subs.py                  # auto-detect from PotPlayer, prefer English
    python extract_subs.py --lang zh         # prefer Chinese track/sidecar
    python extract_subs.py --video "F:\...\ep01.mkv"   # explicit video, skip PotPlayer lookup
    python extract_subs.py --list-tracks     # just list embedded subtitle tracks and exit
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import app_config

# Windows consoles default to a legacy codepage that mangles non-ASCII
# (Chinese paths/track titles); force UTF-8 so status output prints correctly.
if sys.platform == "win32":
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(encoding="utf-8")

SUBTITLE_EXTS = [".srt", ".ass", ".ssa", ".smi", ".vtt"]

# Windows APPDATA location PotPlayer (portable "mini" build) keeps its playlist in.
POTPLAYER_PLAYLIST = Path(
    os.environ.get("APPDATA", "")
) / "PotPlayerMini64" / "Playlist" / "PotPlayerMini64.dpl"

def find_tool(name: str) -> str:
    """Locate ffmpeg/ffprobe: PATH first, then config.json's ffmpeg_dir."""
    from shutil import which

    found = which(name)
    if found:
        return found
    for d in app_config.ffmpeg_dirs():
        candidate = d / f"{name}.exe"
        if candidate.exists():
            return str(candidate)
    raise FileNotFoundError(
        f"找不到 {name}，请把它加进 PATH，或者在 config.json 里设置 ffmpeg_dir。"
    )


def _current_video_filename_from_window_title() -> str | None:
    """PotPlayer's window title updates in real time on every track change
    (unlike the .dpl playlist file below, which only gets flushed to disk on
    certain events and can lag behind by an episode or more). Typical title
    format is "<filename> - PotPlayer" -- strip that suffix to get the name."""
    try:
        import potplayer_progress
        hwnd = potplayer_progress.find_potplayer_hwnd()
        title = potplayer_progress.window_title(hwnd)
    except Exception:
        return None
    title = re.sub(r"\s*-\s*PotPlayer\b.*$", "", title, flags=re.IGNORECASE).strip()
    return title or None


def current_video_from_potplayer() -> Path:
    if not POTPLAYER_PLAYLIST.exists():
        raise FileNotFoundError(
            f"没找到 PotPlayer 播放列表文件：{POTPLAYER_PLAYLIST}\n"
            "确认 PotPlayer 正在播放，或者用 --video 直接指定视频路径。"
        )
    text = POTPLAYER_PLAYLIST.read_text(encoding="utf-8", errors="ignore")
    match = re.search(r"^playname=(.+)$", text, re.MULTILINE)
    if not match:
        raise RuntimeError(f"播放列表里没找到 playname= 这一行：{POTPLAYER_PLAYLIST}")
    playlist_path = Path(match.group(1).strip())

    # Cross-check against the live window title -- if they disagree (playlist
    # file is stale), prefer whatever file actually matches the title, looked
    # up in the same folder as the playlist entry (a series' episodes always
    # live together, so this reliably finds the real current file).
    title_filename = _current_video_filename_from_window_title()
    if title_filename and playlist_path.parent.exists() and playlist_path.name != title_filename:
        exact = playlist_path.parent / title_filename
        if exact.exists():
            return exact
        for f in playlist_path.parent.iterdir():
            if f.is_file() and f.name.lower() == title_filename.lower():
                return f

    if not playlist_path.exists():
        raise FileNotFoundError(f"PotPlayer 记录的当前视频文件不存在：{playlist_path}")
    return playlist_path


LANG_HINTS = {
    "en": ["eng", "en", "english"],
    "zh": ["chs", "cht", "chi", "zh", "zho", "chinese", "简体", "繁体", "中字", "中文"],
}


def find_sidecar_subtitle(video: Path, lang: str | None) -> Path | None:
    """Look for movie.srt, movie.eng.srt, movie.chs.ass, etc. next to the video."""
    candidates = []
    for f in video.parent.iterdir():
        if f.suffix.lower() not in SUBTITLE_EXTS:
            continue
        if not f.stem.lower().startswith(video.stem.lower()):
            continue
        # Skip this tool's own extraction output. It sits next to the video
        # and its name starts with the video's stem, so it looks exactly like
        # a user-supplied sidecar -- and since it carries no language hint the
        # fallback at the end of this function would hand it back for *any*
        # requested language. Asking for Chinese would then return the
        # English track that happened to be extracted first.
        if ".extracted" in f.stem.lower():
            continue
        candidates.append(f)
    if not candidates:
        return None
    exact = [f for f in candidates if f.stem.lower() == video.stem.lower()]

    if lang:
        hints = LANG_HINTS.get(lang, [lang])
        for f in candidates:
            tag = f.stem[len(video.stem):].lower()
            if any(h in tag for h in hints):
                return f
        # Nothing in that language. An untagged "video.srt" is still a fair
        # guess -- single-language releases don't bother tagging -- but a file
        # tagged as some *other* language is not: handing back movie.en.srt
        # for a Chinese request is how the bilingual view ended up showing the
        # English line twice, once in each row.
        return exact[0] if exact else None

    # No language asked for: any sidecar will do, preferring the untagged one.
    return exact[0] if exact else candidates[0]


def list_subtitle_tracks(video: Path, ffprobe: str) -> list[dict]:
    result = subprocess.run(
        [ffprobe, "-v", "quiet", "-print_format", "json", "-show_streams", str(video)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", check=True,
    )
    data = json.loads(result.stdout)
    tracks = []
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "subtitle":
            tags = stream.get("tags", {})
            tracks.append({
                "index": stream["index"],
                "codec": stream.get("codec_name"),
                "language": tags.get("language", ""),
                "title": tags.get("title", ""),
            })
    return tracks


def pick_track(tracks: list[dict], lang: str | None) -> dict | None:
    if not tracks:
        return None
    if lang:
        hints = LANG_HINTS.get(lang, [lang])
        for t in tracks:
            if any(h in (t["language"] or "").lower() or h in (t["title"] or "").lower() for h in hints):
                return t
    return tracks[0]


def partial_path_for(out_srt: Path) -> Path:
    """Where extract_embedded_track streams cues while it's still running.

    ffmpeg writes the .srt incrementally as it demuxes, so this file grows
    from the start of the episode toward the end over the course of the run.
    Readers can parse whatever has landed so far to show early subtitles
    without waiting for the whole container read to finish -- and without
    paying for a second ffmpeg process competing for the same disk.

    Deterministic (not pid-suffixed) precisely so a reader can find it.
    Keeps the .srt extension because ffmpeg picks its output muxer from the
    filename -- an unrecognized suffix fails instantly with EINVAL.
    """
    return out_srt.with_name(f"{out_srt.stem}.partial.srt")


def extract_embedded_track(video: Path, track_index: int, ffmpeg: str, out_srt: Path,
                           start_seconds: float | None = None,
                           duration_seconds: float | None = None) -> None:
    """Pull one embedded subtitle track out to `out_srt`.

    With start_seconds/duration_seconds this extracts only that time window.
    That matters a lot: a full extraction has to demux the entire container
    (subtitle packets are interleaved with video throughout the file), which
    measured ~84s on a 7.5GB 4K episode. Putting -ss *before* -i makes it an
    input seek, so ffmpeg jumps straight to that offset via the container
    index -- a 20-minute window then costs ~1.8s instead. -copyts keeps the
    original absolute timestamps so windowed cues still line up with the
    real playback position.
    """
    # Extraction can take a while on a fresh video, and multiple callers
    # (the chat context poll and the subtitle-card page) can end up
    # extracting the same video around the same time. Write to a temp file
    # and atomically rename into place, so a reader never sees a partially
    # written/truncated .srt from a still-running or concurrently-overwritten
    # extraction -- it either sees the old (missing) file or the complete one.
    # Must keep the .srt extension -- ffmpeg infers the output muxer from the
    # filename, so a temp name like "foo.srt.tmp1234" (no recognized
    # extension) fails immediately with "Unable to choose an output format"
    # (EINVAL), every single time, regardless of retries.
    tmp_path = partial_path_for(out_srt)
    # ffmpeg can occasionally exit non-zero for a transient I/O hiccup (e.g.
    # antivirus briefly locking the freshly-created temp file), so retry
    # once before giving up.
    cmd = [ffmpeg, "-y"]
    if start_seconds is not None:
        # Before -i on purpose: this is an *input* seek (index-based jump),
        # not an output seek (decode-and-discard from 0).
        cmd += ["-ss", f"{max(0.0, start_seconds):.3f}"]
    cmd += ["-i", str(video)]
    if duration_seconds is not None:
        cmd += ["-t", f"{duration_seconds:.3f}"]
    cmd += [
        # -map 0:INDEX picks the absolute stream index reported by ffprobe.
        # -c:s copy forces a true stream copy (no re-encode pass) --
        # subrip-to-srt needs no conversion anyway, but this makes sure
        # ffmpeg never does one.
        "-map", f"0:{track_index}", "-c:s", "copy",
    ]
    if start_seconds is not None:
        cmd += ["-copyts"]
    cmd += [
        # -nostats -loglevel error: ffmpeg's default per-frame progress spam
        # (thousands of "size=... time=..." lines) would otherwise fill the
        # captured stderr pipe for the whole demux pass.
        "-nostats", "-loglevel", "error",
        str(tmp_path),
    ]

    last_error = None
    for attempt in range(2):
        try:
            subprocess.run(
                cmd,
                capture_output=True, text=True, encoding="utf-8", errors="replace", check=True,
            )
            os.replace(tmp_path, out_srt)
            return
        except subprocess.CalledProcessError as e:
            last_error = e
            tmp_path.unlink(missing_ok=True)
    raise last_error


SRT_CUE_RE = re.compile(
    r"^\d+\s*$|^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}.*$"
)
ASS_TAG_RE = re.compile(r"\{[^}]*\}")


def clean_to_plain_text(subtitle_path: Path) -> str:
    raw = subtitle_path.read_text(encoding="utf-8", errors="ignore")
    lines_out = []
    seen = set()

    if subtitle_path.suffix.lower() in (".ass", ".ssa"):
        for line in raw.splitlines():
            if not line.startswith("Dialogue:"):
                continue
            # Dialogue: layer,start,end,style,name,ml,mr,mv,effect,text
            parts = line.split(",", 9)
            if len(parts) < 10:
                continue
            text = ASS_TAG_RE.sub("", parts[9]).replace("\\N", " ").strip()
            if text and text not in seen:
                seen.add(text)
                lines_out.append(text)
    else:
        for line in raw.splitlines():
            line = line.strip()
            if not line or SRT_CUE_RE.match(line):
                continue
            text = re.sub(r"<[^>]+>", "", line).strip()
            if text and text not in seen:
                seen.add(text)
                lines_out.append(text)

    return "\n".join(lines_out)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--video", help="显式指定视频路径，跳过从 PotPlayer 自动检测")
    parser.add_argument("--lang", help="偏好语言，比如 en / zh（不传就拿找到的第一个字幕）")
    parser.add_argument("--out-dir", help="输出目录，默认和视频同目录")
    parser.add_argument("--list-tracks", action="store_true", help="只列出内嵌字幕轨道然后退出")
    args = parser.parse_args()

    video = Path(args.video) if args.video else current_video_from_potplayer()
    print(f"[视频] {video}")

    out_dir = Path(args.out_dir) if args.out_dir else video.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.list_tracks:
        ffprobe = find_tool("ffprobe")
        tracks = list_subtitle_tracks(video, ffprobe)
        if not tracks:
            print("这个视频容器里没有内嵌字幕轨道。")
        for t in tracks:
            print(f"  stream #{t['index']}  codec={t['codec']}  lang={t['language'] or '?'}  title={t['title'] or ''}")
        return

    sidecar = find_sidecar_subtitle(video, args.lang)
    if sidecar:
        print(f"[找到外挂字幕] {sidecar}")
        subtitle_path = sidecar
    else:
        print("[没有外挂字幕，尝试提取内嵌轨道]")
        ffprobe = find_tool("ffprobe")
        ffmpeg = find_tool("ffmpeg")
        tracks = list_subtitle_tracks(video, ffprobe)
        track = pick_track(tracks, args.lang)
        if not track:
            print("这个视频既没有外挂字幕文件，容器里也没有内嵌字幕轨道。", file=sys.stderr)
            sys.exit(1)
        print(f"[选中内嵌轨道] stream #{track['index']} lang={track['language'] or '?'}")
        subtitle_path = out_dir / f"{video.stem}.extracted.srt"
        extract_embedded_track(video, track["index"], ffmpeg, subtitle_path)
        print(f"[已提取到] {subtitle_path}")

    plain_text = clean_to_plain_text(subtitle_path)
    text_out = out_dir / f"{video.stem}.subtitle.txt"
    text_out.write_text(plain_text, encoding="utf-8")

    line_count = plain_text.count("\n") + 1 if plain_text else 0
    print(f"[纯文本已写入] {text_out}  ({line_count} 行)")


if __name__ == "__main__":
    main()
