"""Collect frequently used hashtags/tags from longform videos in our categories.

Research helper (docs/source-eligibility-spec-2026-08-10.md taxonomy). Uses
yt-dlp metadata only - nothing is downloaded. Two seed pools:
  1. YouTube search per (category x language JA/KO) query, longform only
     (duration >= 240s), N results each.
  2. Our own queue source URLs (videos that actually shipped highlights).

Output: ranked hashtag/tag counts per category+language, JSON + stdout table.

Usage
  python scripts/collect_category_hashtags.py [--per-query 12] [--json OUT]
      [--skip-own-sources]
"""

import argparse
import collections
import glob
import json
import os
import re
import subprocess
import sys

# Windows consoles default to cp949 here; hashtags are JA/KO/CJK text.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

CATEGORY_QUERIES = {
    "metal": {"ja": "金属加工 工場 製造工程", "ko": "금속가공 공장 제조과정"},
    "food_factory": {"ja": "食品工場 大量生産 製造過程", "ko": "식품공장 대량생산 제조과정"},
    "craft": {"ja": "職人 伝統工芸 製作過程", "ko": "장인 공예 제작과정"},
    "machine_assembly": {"ja": "工場 機械 組立工程", "ko": "공장 기계 조립 공정"},
    "material_transform": {"ja": "ガラス 製造 工場 工程", "ko": "유리 제작 공정 공장"},
    "agri_processing": {"ja": "収穫 加工 農業機械", "ko": "수확 가공 농기계"},
}

HASHTAG_RE = re.compile(r"#[0-9A-Za-z_À-ɏ぀-ヿ㐀-鿿가-힯]+")
ROOT = os.path.join(os.path.dirname(__file__), "..")


def ytdlp_json_lines(target, extra_args=None, timeout=600):
    cmd = ["yt-dlp", target, "--skip-download", "--dump-json",
           "--no-warnings", "--ignore-errors", "--socket-timeout", "15"]
    cmd += extra_args or []
    out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                         errors="replace", timeout=timeout)
    videos = []
    for line in (out.stdout or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            videos.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return videos


def extract_terms(video):
    terms = collections.Counter()
    for tag in video.get("tags") or []:
        tag = str(tag).strip()
        if 1 < len(tag) <= 40:
            terms[tag.lower() if tag.isascii() else tag] += 1
    text = f"{video.get('title') or ''}\n{video.get('description') or ''}"
    for match in HASHTAG_RE.findall(text):
        if len(match) > 2:
            terms[match.lower() if match.isascii() else match] += 1
    return terms


def own_source_urls():
    urls = set()
    for config_path in glob.glob(os.path.join(ROOT, "queue", "process", "item_*", "item_config.json")):
        try:
            with open(config_path, encoding="utf-8") as fh:
                url = (json.load(fh).get("source_url") or "").strip()
            if url.startswith("http"):
                urls.add(url)
        except (OSError, json.JSONDecodeError):
            continue
    return sorted(urls)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--per-query", type=int, default=12)
    parser.add_argument("--json", dest="json_out")
    parser.add_argument("--skip-own-sources", action="store_true")
    args = parser.parse_args()

    report = {"categories": {}, "own_sources": {"video_count": 0, "terms": {}}}

    for category, queries in CATEGORY_QUERIES.items():
        report["categories"][category] = {}
        for lang, query in queries.items():
            print(f"[search] {category}/{lang}: {query}", file=sys.stderr, flush=True)
            videos = ytdlp_json_lines(
                f"ytsearch{args.per_query}:{query}",
                extra_args=["--match-filter", "duration>=240"])
            counts = collections.Counter()
            for video in videos:
                counts.update(extract_terms(video))
            report["categories"][category][lang] = {
                "query": query,
                "video_count": len(videos),
                "terms": dict(counts.most_common(40)),
            }

    if not args.skip_own_sources:
        urls = own_source_urls()
        print(f"[own] fetching {len(urls)} queue source urls", file=sys.stderr, flush=True)
        counts = collections.Counter()
        fetched = 0
        for url in urls:
            videos = ytdlp_json_lines(url, timeout=90)
            for video in videos:
                counts.update(extract_terms(video))
                fetched += 1
        report["own_sources"] = {"video_count": fetched, "terms": dict(counts.most_common(60))}

    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.json_out:
        os.makedirs(os.path.dirname(args.json_out), exist_ok=True)
        with open(args.json_out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        print(f"wrote {args.json_out}", file=sys.stderr)

    for category, langs in report["categories"].items():
        for lang, data in langs.items():
            top = list(data["terms"].items())[:12]
            print(f"\n== {category} / {lang} ({data['video_count']} videos) ==")
            for term, count in top:
                print(f"  {count:3d}  {term}")
    if report["own_sources"]["video_count"]:
        print(f"\n== own sources ({report['own_sources']['video_count']} videos) ==")
        for term, count in list(report["own_sources"]["terms"].items())[:20]:
            print(f"  {count:3d}  {term}")


if __name__ == "__main__":
    main()
