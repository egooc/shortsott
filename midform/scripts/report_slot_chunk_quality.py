#!/usr/bin/env python3
"""Write a human-readable report for chunked Gemini midform slot quality."""

from __future__ import annotations

import argparse
import json
import re
from difflib import SequenceMatcher
from pathlib import Path


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def similar(a: str, b: str) -> float:
    return SequenceMatcher(None, normalize(a), normalize(b)).ratio()


def duplicate_groups(slots, threshold: float = 0.9):
    groups = []
    used = set()
    for index, slot in enumerate(slots):
        if index in used:
            continue
        group = [index]
        for other_index in range(index + 1, len(slots)):
            if similar(slot.get("scene_summary", ""), slots[other_index].get("scene_summary", "")) >= threshold:
                group.append(other_index)
        if len(group) >= 3:
            used.update(group)
            groups.append(group)
    return groups


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gemini", required=True, type=Path)
    parser.add_argument("--slot-map", required=True, type=Path)
    parser.add_argument("--draft", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    gemini = load_json(args.gemini)
    slot_map = load_json(args.slot_map)
    slots = slot_map.get("slots") or []
    groups = duplicate_groups(slots)
    late_slots = [slot for slot in slots if float((slot.get("source_range") or [0, 0])[0]) >= 87]

    lines = [
        "# Midform Chunked Gemini Slot Quality Report",
        "",
        f"- Draft: `{args.draft}`",
        f"- Gemini scenes: {len(gemini.get('scenes') or [])}",
        f"- Slots: {len(slots)}",
        f"- Duplicate scene_summary groups at 90%+ similarity with 3+ slots: {len(groups)}",
        "",
        "## Chunk Plan / Scene Counts",
        "",
        "| chunk | range_sec | scenes | summary sample |",
        "|---:|---|---:|---|",
    ]
    for chunk in (gemini.get("chunk_analysis") or {}).get("chunks") or []:
        sample = " / ".join(chunk.get("summary_sample") or [])
        lines.append(f"| {chunk.get('index')} | {chunk.get('start_sec')}~{chunk.get('end_sec')} | {chunk.get('scenes_count')} | {sample} |")

    lines.extend([
        "",
        "## Late Slots After 87s",
        "",
        "| slot_id | type | range_sec | scene_summary |",
        "|---|---|---|---|",
    ])
    for slot in late_slots:
        start, end = slot.get("source_range") or ["", ""]
        lines.append(f"| {slot.get('slot_id')} | {slot.get('type')} | {start}~{end} | {slot.get('scene_summary')} |")

    lines.extend([
        "",
        "## Full Slot Map",
        "",
        "| slot_id | type | range_sec | scene_summary |",
        "|---|---|---|---|",
    ])
    for slot in slots:
        start, end = slot.get("source_range") or ["", ""]
        lines.append(f"| {slot.get('slot_id')} | {slot.get('type')} | {start}~{end} | {slot.get('scene_summary')} |")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "duplicate_groups": len(groups), "late_slots": len(late_slots)}, ensure_ascii=False))
    return 1 if groups else 0


if __name__ == "__main__":
    raise SystemExit(main())
