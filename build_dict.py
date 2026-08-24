#!/usr/bin/env python3
"""
Build the local lookup dictionary used for hover definitions.

Downloads ECDICT (github.com/skywind3000/ECDICT, MIT) and reduces it to a
small SQLite file. The source CSV is ~63 MB of 770k entries with 13 columns;
almost all of that is dead weight here:

- Most entries are proper nouns, technical terms and inflected junk that will
  never appear in a TV subtitle. Filtering on corpus frequency (BNC/COCA)
  keeps the words people actually say.
- Only four columns matter for a hover tooltip: the word, its phonetic
  spelling, the Chinese gloss, and the inflection list.

The inflection list is the reason this can't just be a flat word->gloss map.
ECDICT stores forms on the lemma ("run" carries "p:ran/d:run/i:running"), so
without expanding that into a reverse index, hovering "running" finds
nothing -- which would be most of the verbs in any real subtitle line.

Run once:
    python build_dict.py
Re-run with --keep-csv to leave the download in place for inspection.
"""

import argparse
import csv
import os
import sqlite3
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CSV_PATH = ROOT / "ecdict.csv"
DB_PATH = ROOT / "dictionary.db"
CSV_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv"

# Rank cutoff in the BNC and COCA frequency lists. 50k is far past the point
# of diminishing returns for scripted dialogue -- it covers ordinary speech,
# slang and most of the deliberately obscure words a show reaches for --
# while dropping the long tail of specialist vocabulary that makes up the
# bulk of the file.
FREQ_CUTOFF = 50_000


def download(url: str, dest: Path) -> None:
    print(f"下载 {url}")
    # Only emit on a whole-percent change: urlretrieve calls back per block,
    # which is thousands of times for a 63 MB file, and the \r overwrite that
    # keeps that tidy in a terminal turns into thousands of lines the moment
    # output is piped or captured.
    last_pct = -1

    def progress(count, block_size, total):
        nonlocal last_pct
        if total <= 0:
            return
        done = min(count * block_size, total)
        pct = done * 100 // total
        if pct == last_pct:
            return
        last_pct = pct
        sys.stdout.write(f"\r  {pct}%  ({done // 1048576} / {total // 1048576} MB)")
        sys.stdout.flush()

    urllib.request.urlretrieve(url, dest, reporthook=progress)
    print()


def parse_rank(value: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def is_common(row: dict) -> bool:
    bnc, frq = parse_rank(row.get("bnc")), parse_rank(row.get("frq"))
    # Rank 0 means "absent from that corpus", so an entry qualifies if either
    # list places it inside the cutoff.
    in_bnc = 0 < bnc <= FREQ_CUTOFF
    in_frq = 0 < frq <= FREQ_CUTOFF
    if in_bnc or in_frq:
        return True
    # Keep exam-syllabus words regardless of corpus rank: they're the ones a
    # learner is most likely to look up, and some sit outside the top 50k.
    return bool(row.get("tag", "").strip())


def inflections(exchange: str) -> list[str]:
    """Forms listed in ECDICT's exchange field, e.g. "p:ran/d:run/i:running".

    The key before each colon is the relationship (past tense, participle,
    plural, comparative...). Only the form itself is needed here, since the
    reverse index just has to answer "what lemma does this spelling belong
    to". The "0"/"1" keys are skipped: they point *from* an inflected entry
    back to its lemma, which would map a lemma onto itself or onto an
    unrelated stem.
    """
    forms = []
    for part in (exchange or "").split("/"):
        if ":" not in part:
            continue
        key, _, form = part.partition(":")
        if key in ("0", "1"):
            continue
        form = form.strip()
        if form:
            forms.append(form)
    return forms


def build(keep_csv: bool) -> None:
    if not CSV_PATH.exists():
        download(CSV_URL, CSV_PATH)
    else:
        print(f"已存在 {CSV_PATH.name}，跳过下载")

    if DB_PATH.exists():
        DB_PATH.unlink()

    db = sqlite3.connect(DB_PATH)
    db.executescript("""
        CREATE TABLE entries (
            word       TEXT PRIMARY KEY,
            phonetic   TEXT,
            translation TEXT
        );
        -- Maps any inflected spelling to its lemma. Separate table rather
        -- than a column so lookups stay a single indexed hit either way.
        CREATE TABLE forms (
            form  TEXT PRIMARY KEY,
            lemma TEXT NOT NULL
        );
    """)

    total = kept = form_count = 0
    entries, forms = [], []

    with CSV_PATH.open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            total += 1
            if not is_common(row):
                continue
            word = (row.get("word") or "").strip()
            translation = (row.get("translation") or "").strip()
            if not word or not translation:
                continue

            kept += 1
            entries.append((word.lower(), (row.get("phonetic") or "").strip(), translation))
            for form in inflections(row.get("exchange", "")):
                forms.append((form.lower(), word.lower()))

            if len(entries) >= 20_000:
                db.executemany("INSERT OR REPLACE INTO entries VALUES (?,?,?)", entries)
                db.executemany("INSERT OR IGNORE INTO forms VALUES (?,?)", forms)
                form_count += len(forms)
                entries, forms = [], []

    db.executemany("INSERT OR REPLACE INTO entries VALUES (?,?,?)", entries)
    db.executemany("INSERT OR IGNORE INTO forms VALUES (?,?)", forms)
    form_count += len(forms)
    db.commit()
    db.execute("VACUUM")
    db.close()

    size_mb = DB_PATH.stat().st_size / 1048576
    print(f"读入 {total} 条，保留 {kept} 条，词形映射 {form_count} 条")
    print(f"生成 {DB_PATH.name}：{size_mb:.1f} MB")

    if not keep_csv:
        os.remove(CSV_PATH)
        print(f"已删除源文件 {CSV_PATH.name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep-csv", action="store_true", help="保留下载的 CSV 源文件")
    build(parser.parse_args().keep_csv)
