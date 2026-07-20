#!/usr/bin/env python3
"""Validate a slot-map based midform draft manifest."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def parse_time(value) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value or "").strip()
    if not text:
        raise ValueError("empty timecode")
    parts = text.split(":")
    if len(parts) == 2:
        minutes, seconds = parts
        return int(minutes) * 60 + float(seconds)
    if len(parts) == 3:
        hours, minutes, seconds = parts
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    return float(text)


def ranges_overlap(a_start: float, a_end: float, b_start: float, b_end: float, eps: float = 0.001) -> bool:
    return max(a_start, b_start) < min(a_end, b_end) - eps


def normalize_text(value) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def excluded_range_values(excluded):
    if isinstance(excluded, dict):
        values = excluded.get("range") or excluded.get("source_range") or [excluded.get("start"), excluded.get("end")]
    else:
        values = excluded
    if not isinstance(values, (list, tuple)) or len(values) < 2:
        return None
    if values[0] is None or values[1] is None:
        return None
    return float(values[0]), float(values[1])


def excluded_range_reason(excluded) -> str:
    if isinstance(excluded, dict):
        return normalize_text(excluded.get("reason") or excluded.get("label"))
    if isinstance(excluded, (list, tuple)) and len(excluded) >= 3:
        return normalize_text(excluded[2])
    return ""


def is_allowed_dialogue_heavy_background_overlap(slot, excluded) -> bool:
    return slot.get("narration_background") is True and excluded_range_reason(excluded) == "unselected_dialogue_as_narration_background"


def dialogue_text_matches_slot(slot_text, transcript_text) -> bool:
    slot_normalized = normalize_text(slot_text).lower()
    transcript_normalized = normalize_text(transcript_text).lower()
    if not slot_normalized:
        return True
    if slot_normalized == transcript_normalized:
        return True
    return slot_normalized in transcript_normalized or transcript_normalized in slot_normalized


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--slot-map", required=True, type=Path)
    parser.add_argument("--transcript", required=True, type=Path)
    args = parser.parse_args()

    manifest = load_json(args.manifest)
    slot_map = load_json(args.slot_map)
    transcript = load_json(args.transcript)

    slots = slot_map.get("slots") or []
    slot_by_id = {str(slot.get("slot_id")): slot for slot in slots}
    expected_order = [str(slot.get("slot_id")) for slot in slots]
    manifest_order = [str(item) for item in (manifest.get("slot_order") or [])]
    caption_units = manifest.get("caption_units") or []
    manifest_segments = manifest.get("segments") or []
    seen_order = []
    for unit in caption_units:
        combined_segment_ids = unit.get("combined_segment_ids") if isinstance(unit.get("combined_segment_ids"), list) else []
        unit_slot_ids = combined_segment_ids if combined_segment_ids else [unit.get("segment_id")]
        for raw_slot_id in unit_slot_ids:
            slot_id = str(raw_slot_id or "")
            if slot_id and (not seen_order or seen_order[-1] != slot_id):
                seen_order.append(slot_id)

    errors = []
    if manifest.get("slot_map_mode") is not True:
        errors.append("manifest slot_map_mode is not true")
    if manifest_order != expected_order:
        errors.append("manifest slot_order does not match slot_map order")
    if seen_order != expected_order:
        errors.append("caption timeline segment order does not match slot_map order")
    if manifest.get("warnings"):
        errors.append(f"manifest warnings present: {len(manifest.get('warnings') or [])}")
    if manifest.get("dialogue_reserved_range_violations"):
        errors.append("dialogue reserved range violations present")
    if manifest.get("split_warnings"):
        errors.append(f"subtitle split warnings present: {len(manifest.get('split_warnings') or [])}")

    excluded_ranges = slot_map.get("excluded_ranges") or []
    excluded_hits = []
    speed_violations = []
    dialogue_range_violations = []
    dialogue_text_violations = []
    transcript_by_id = {
        str(item.get("id") or item.get("utt_id") or item.get("utterance_id")): item
        for item in (transcript.get("utterances") or transcript.get("segments") or [])
        if isinstance(item, dict)
    }

    for unit in manifest_segments:
        slot_id = str(unit.get("segment_id") or "")
        slot = slot_by_id.get(slot_id)
        if not slot:
            errors.append(f"unknown manifest segment slot: {slot_id}")
            continue
        slot_type = str(slot.get("type") or "")
        for clip in unit.get("source_clips") or []:
            start = parse_time(clip.get("start"))
            end = parse_time(clip.get("end"))
            for excluded in excluded_ranges:
                excluded_values = excluded_range_values(excluded)
                if excluded_values is None:
                    continue
                ex_start, ex_end = excluded_values
                if ranges_overlap(start, end, float(ex_start), float(ex_end)) and not is_allowed_dialogue_heavy_background_overlap(slot, excluded):
                    excluded_hits.append({"slot_id": slot_id, "clip": [start, end], "excluded": [ex_start, ex_end]})
            if slot_type != "dialogue":
                speed = float(clip.get("speed_multiplier") or 1.0)
                if speed < 0.7 or speed > 1.5:
                    speed_violations.append({"slot_id": slot_id, "speed": speed})

        if slot_type == "dialogue":
            utt_id = str(slot.get("utt_id") or "")
            utterance = transcript_by_id.get(utt_id)
            if not utterance:
                dialogue_range_violations.append({"slot_id": slot_id, "reason": f"missing transcript {utt_id}"})
                continue
            source_range = slot.get("source_range") or []
            slot_start, slot_end = [float(value) for value in source_range]
            utterance_start = utterance.get("start")
            utterance_end = utterance.get("end")
            if utterance_start is None or utterance_end is None:
                dialogue_range_violations.append({"slot_id": slot_id, "reason": f"transcript {utt_id} has missing range"})
                continue
            transcript_start = float(utterance_start)
            transcript_end = float(utterance_end)
            if slot_start < transcript_start - 0.001 or slot_end > transcript_end + 0.001 or slot_end <= slot_start:
                dialogue_range_violations.append({"slot_id": slot_id, "slot": [slot_start, slot_end], "transcript": [utterance.get("start"), utterance.get("end")], "reason": "slot range is not contained within transcript utterance"})
            if not dialogue_text_matches_slot(slot.get("caption_source_text"), utterance.get("text")):
                dialogue_text_violations.append({"slot_id": slot_id, "slot": slot.get("caption_source_text"), "transcript": utterance.get("text")})

    if excluded_hits:
        errors.append(f"excluded range used by source clips: {len(excluded_hits)}")
    if speed_violations:
        errors.append(f"non-dialogue speed outside 0.7~1.5x: {len(speed_violations)}")
    if dialogue_range_violations:
        errors.append(f"dialogue source_range mismatch: {len(dialogue_range_violations)}")
    if dialogue_text_violations:
        errors.append(f"dialogue STT text mismatch: {len(dialogue_text_violations)}")

    report = {
        "status": "failed" if errors else "passed",
        "errors": errors,
        "slot_map_mode": manifest.get("slot_map_mode"),
        "slots": len(slots),
        "caption_units": len(caption_units),
        "warnings": len(manifest.get("warnings") or []),
        "split_warnings": len(manifest.get("split_warnings") or []),
        "excluded_range_hits": len(excluded_hits),
        "speed_violations": len(speed_violations),
        "dialogue_range_violations": len(dialogue_range_violations),
        "dialogue_text_violations": len(dialogue_text_violations),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
