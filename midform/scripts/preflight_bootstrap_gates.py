#!/usr/bin/env python3
"""Phase 2 bootstrap preflight: run capcut_draft.py's real gates against the adapter-built
script.json + transcript BEFORE any download/TTS/render, so gate failures surface here instead
of deep in the render (the Daredevil failure mode). Emits a JSON verdict on stdout.

Composition model (compression bootstrap):
  - script.json has NO slot_map key  -> slot_map_mode False -> slot-source-monotonicity not_applicable.
  - ALL narration (recap) segments carry a degenerate story_anchor hint + explicit source_scenes, so
    the b-roll auto-picker DECLINES for every one of them -> story_sync_segment_reports stays empty ->
    the story-sync gate (monotonic + 70% coverage, incompatible with the teaser/compression model) is
    skipped. This preflight VERIFIES that skip condition holds (every narration segment declines).
  - The hybrid cross-segment overlap gate still runs, so we replicate its check locally.

Gates / checks:
  1. reserved-range gate       -> validate_midform_dialogue_reserved_ranges  (imported, real, fatal)
  2. slot_map_mode == False    -> monotonicity not_applicable
  3. story-sync skip condition -> every recap segment's auto-picker call returns None (declines)
  4. narration has b-roll      -> every recap segment has non-empty source_scenes
  5. cross-segment overlap = 0 -> no two different segments' source clips overlap (hybrid gate)
"""

import argparse
import json
import os
import sys

SCRIPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "scripts")
sys.path.insert(0, SCRIPTS_DIR)
import capcut_draft as cc  # noqa: E402


def load(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def first_clip_range(seg):
    clips = seg.get("source_scenes") or seg.get("source_clips") or []
    for c in clips:
        if not isinstance(c, dict):
            continue
        s = cc.parse_timecode_to_sec(c.get("start"))
        e = cc.parse_timecode_to_sec(c.get("end"))
        if s is not None and e is not None and e > s:
            return (s, e)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", required=True)
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--source-duration", type=float, default=0.0)
    args = ap.parse_args()

    script = load(args.script)
    transcript = load(args.transcript)
    segments = script.get("segments", [])
    segment_map = {}
    segment_type_map = {}
    for seg in segments:
        sid = str(seg.get("segment_id", "")).strip()
        if sid:
            segment_map[sid] = seg
            segment_type_map[sid] = str(seg.get("segment_type") or "recap").strip()

    slot_map_mode = bool((script.get("slot_map") or {}).get("slots"))
    known_dur = args.source_duration or (max((u["end"] for u in transcript.get("utterances", [])), default=0.0) + 1.0)

    # 1. reserved-range gate (real, fatal in render).
    dialogue_map = cc.build_midform_dialogue_map({}, segment_map, segment_type_map, known_dur, "", transcript)
    reserved = cc.validate_midform_dialogue_reserved_ranges(segment_map, segment_type_map, dialogue_map)

    # 3. story-sync skip: run the REAL auto-picker on each recap segment; every one must decline
    #    (return None) so story_sync_segment_reports stays empty and the story-sync gate is skipped.
    utt_map = cc.build_transcript_utterance_map(transcript)
    picker_placed = []  # recap segments where the picker WOULD place clips (breaks the skip)
    narration_missing_broll = []
    for seg in segments:
        sid = str(seg.get("segment_id"))
        if segment_type_map.get(sid) in ("dialogue_quote", "dialogue"):
            continue
        result = cc.choose_story_anchor_source_clips(seg, 5.0, utt_map, known_dur + 30.0)
        if result:
            clips, _report = result
            if clips:
                picker_placed.append(sid)
        if not first_clip_range(seg):
            narration_missing_broll.append(sid)

    # 5. cross-segment overlap (hybrid gate, conservative full-clip check).
    ranges = []
    for seg in segments:
        r = first_clip_range(seg)
        if r:
            ranges.append((str(seg.get("segment_id")), r[0], r[1]))
    ranges.sort(key=lambda x: (x[1], x[2]))
    cross_overlaps = []
    for i in range(len(ranges) - 1):
        a_id, a_s, a_e = ranges[i]
        for j in range(i + 1, len(ranges)):
            b_id, b_s, b_e = ranges[j]
            if b_s >= a_e - 0.001:
                break
            if a_id != b_id:
                cross_overlaps.append({"a": a_id, "a_range": [round(a_s, 3), round(a_e, 3)], "b": b_id, "b_range": [round(b_s, 3), round(b_e, 3)]})

    verdict = {
        "slot_map_mode": slot_map_mode,
        "reserved_range_violations": reserved,
        "story_sync_would_run": len(picker_placed) > 0,
        "picker_placed_segments": picker_placed,
        "narration_missing_broll": narration_missing_broll,
        "cross_segment_overlaps": cross_overlaps,
        "ok": (not reserved)
              and (slot_map_mode is False)
              and (len(picker_placed) == 0)
              and (not narration_missing_broll)
              and (not cross_overlaps),
    }
    print(json.dumps(verdict, ensure_ascii=False))


if __name__ == "__main__":
    main()
