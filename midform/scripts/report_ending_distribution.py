#!/usr/bin/env python3
"""Report Korean narration ending distribution for midform scripts."""

import argparse
import json
import re
from pathlib import Path


SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?。！？])\s+")


def split_sentences(text):
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    if not text:
        return []
    return [item.strip() for item in SENTENCE_SPLIT_RE.split(text) if item.strip()]


def classify_ending(sentence):
    text = str(sentence or "").strip()
    text = re.sub(r"[\"'“”‘’()\[\]{}]+$", "", text)
    text = re.sub(r"[.!?。！？]+$", "", text).strip()
    if re.search(r"버렸(?:습니다|죠|는데)?$", text):
        return "beoryeot"
    if re.search(r"(?:는데|했는데|였는데|이었는데|인데)$", text):
        return "neunde"
    if re.search(r"(?:죠|했죠|였죠|이었죠|었죠|았죠)$", text):
        return "jyo"
    if re.search(r"(?:습니다|했습니다|됩니다|였습니다|이었습니다|립니다|입니다|니다)$", text):
        return "nida"
    return "other"


def measure_script(path):
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    rows = []
    for segment in data.get("segments") or []:
        if segment.get("tts_enabled") is False or segment.get("segment_type") in {"dialogue_quote", "dialogue"}:
            continue
        for sentence in split_sentences(segment.get("narration")):
            rows.append(
                {
                    "segment_id": segment.get("segment_id"),
                    "sentence": sentence,
                    "ending": classify_ending(sentence),
                }
            )
    keys = ["nida", "jyo", "neunde", "beoryeot", "other"]
    counts = {key: sum(1 for row in rows if row["ending"] == key) for key in keys}
    total = len(rows)
    return {
        "script_path": str(Path(path)),
        "sentence_count": total,
        "counts": counts,
        "pct": {key: round((counts[key] / total * 100), 1) if total else 0.0 for key in keys},
        "rows": rows,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--item", action="append", required=True, help="Label=script_path")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    report = {}
    for item in args.item:
        label, _, script_path = item.partition("=")
        if not label or not script_path:
            raise ValueError(f"Invalid --item value: {item}")
        report[label] = measure_script(script_path)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({label: {"pct": data["pct"], "sentence_count": data["sentence_count"]} for label, data in report.items()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
