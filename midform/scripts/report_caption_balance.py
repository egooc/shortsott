#!/usr/bin/env python3
"""Report balanced display-caption segmentation quality for generated SRT files."""

import argparse
import json
import re
from pathlib import Path


def normalize_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def visible_len(value):
    return len(re.sub(r"\s+", "", normalize_text(value)))


def parse_srt(path):
    text = Path(path).read_text(encoding="utf-8-sig")
    entries = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if len(lines) >= 3 and "-->" in lines[1]:
            entries.append({"index": lines[0], "text": normalize_text(" ".join(lines[2:])), "chars": visible_len(" ".join(lines[2:]))})
    return entries


def protected_caption(text):
    compact = normalize_text(text)
    return any(token in compact for token in [
        "안 할 거야",
        "버티고 있었는데",
        "무너지지 않자",
        "물러서지 않았",
        "끝나지 않았",
        "수 스톰",
        "실버 서퍼",
        "리드 리처즈",
        "버키 반즈",
        "윈터 솔져",
        "수 있다는",
        "수 없",
        "수밖에",
        "공격 쪽으로",
        "쪽으로",
        "때문에",
        "뿐만",
    ])


def ends_sentence(text):
    return bool(re.search(r"[.!?。！？]$", normalize_text(text)))


def balance_violations(entries):
    overlong = []
    too_short = []
    ratio_violations = []
    for entry in entries:
        limit = 14 if protected_caption(entry["text"]) else 11
        if entry["chars"] > limit:
            overlong.append(entry | {"limit": limit})
        if entry["chars"] < 4:
            too_short.append(entry)
    for left, right in zip(entries, entries[1:]):
        if ends_sentence(left["text"]):
            continue
        smaller = max(1, min(left["chars"], right["chars"]))
        larger = max(left["chars"], right["chars"])
        if larger / smaller > 2.5:
            ratio_violations.append({"left": left, "right": right, "ratio": round(larger / smaller, 3)})
    return overlong, too_short, ratio_violations


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--srt", action="append", required=True, help="Label=path")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    report = {}
    for item in args.srt:
        label, _, raw_path = item.partition("=")
        entries = parse_srt(raw_path)
        overlong, too_short, ratio = balance_violations(entries)
        report[label] = {
            "srt": raw_path,
            "status": "passed" if not overlong and not too_short and not ratio else "failed",
            "subtitle_count": len(entries),
            "max_chars": max([entry["chars"] for entry in entries] or [0]),
            "overlong": overlong,
            "too_short": too_short,
            "ratio_violations": ratio,
            "entries": entries,
        }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: {"status": value["status"], "subtitle_count": value["subtitle_count"], "max_chars": value["max_chars"], "overlong": len(value["overlong"]), "too_short": len(value["too_short"]), "ratio_violations": len(value["ratio_violations"])} for key, value in report.items()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
