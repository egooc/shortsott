# Add the BGM bed to a CapCut draft that was built before BGM was wired in.
#
#   python scripts/add_bgm_to_draft.py --draft-name <folder> [--drafts-dir <dir>] [--dry-run]
#
# New drafts get the bed from capcut_draft.py directly. This is the retrofit for drafts already
# installed: it loads the saved draft, appends a "bgm" audio track, loops the bed to the
# timeline length and fades the LAST segment out so the music ends with the video instead of
# being chopped mid-note.
#
# Re-running is safe: an existing bgm track is removed first, so the bed never stacks.
import argparse
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

try:
    import pyCapCut as cc  # type: ignore
except Exception:  # pragma: no cover - name differs by install
    import pycapcut as cc  # type: ignore

from capcut_draft import (  # noqa: E402  - path set above
    BGM_FADE_IN_US,
    BGM_FADE_OUT_US,
    BGM_VOLUME,
    find_bgm_file_from_preset,
)

DEFAULT_DRAFTS_DIR = os.path.join(
    os.path.expanduser("~"), "Desktop", "캡컷아웃풋", "CapCut Drafts"
)


def timeline_duration_us(draft_dir):
    """Longest end across the draft's tracks (excluding bgm), in microseconds.

    This is the MAX, not the source_video track. Tying the bed to source_video looks right and
    is wrong: in several drafts the video track stops before the timeline does (2.0s short on
    master_morgana, 4.3s on newmoon_breakup) while subtitle and template-overlay segments carry
    on, and CapCut exports to the longest track. Measured: master_morgana source_video ends at
    130.33s and the exported file runs 132.38s. Shortening the bed to the video track left the
    tail in dead silence - the very gap the bed exists to fill.
    """
    with open(os.path.join(draft_dir, "draft_content.json"), encoding="utf-8") as handle:
        content = json.load(handle)
    end_us = 0
    for track in content.get("tracks") or []:
        if str(track.get("name") or "") == "bgm":
            continue
        for segment in track.get("segments") or []:
            target = segment.get("target_timerange") or {}
            end_us = max(end_us, int(target.get("start") or 0) + int(target.get("duration") or 0))
    return end_us


def drop_existing_bgm(draft_dir):
    """Remove a previously injected bed so a re-run replaces rather than stacks."""
    path = os.path.join(draft_dir, "draft_content.json")
    with open(path, encoding="utf-8") as handle:
        content = json.load(handle)
    before = len(content.get("tracks") or [])
    content["tracks"] = [t for t in (content.get("tracks") or []) if str(t.get("name") or "") != "bgm"]
    if len(content["tracks"]) != before:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(content, handle, ensure_ascii=False)
        return True
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--draft-name", required=True)
    parser.add_argument("--drafts-dir", default=DEFAULT_DRAFTS_DIR)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    draft_dir = os.path.join(args.drafts_dir, args.draft_name)
    if not os.path.isdir(draft_dir):
        raise SystemExit(json.dumps({"status": "error", "error": f"draft not found: {draft_dir}"}))

    bgm_path = find_bgm_file_from_preset({})
    if not bgm_path:
        raise SystemExit(json.dumps({"status": "error", "error": "no bgm under assets/bgm/process"}))

    total_us = timeline_duration_us(draft_dir)
    if total_us <= 0:
        raise SystemExit(json.dumps({"status": "error", "error": "timeline duration is zero"}))

    if args.dry_run:
        print(json.dumps({
            "status": "dry-run", "draft": args.draft_name,
            "timeline_sec": round(total_us / 1_000_000, 3),
            "bgm": os.path.basename(bgm_path)
        }, ensure_ascii=False))
        return

    replaced = drop_existing_bgm(draft_dir)

    folder = cc.DraftFolder(args.drafts_dir)
    script = folder.load_template(args.draft_name)
    script.add_track(cc.TrackType.audio, "bgm", relative_index=1)

    audio_dir = os.path.join(draft_dir, "audio")
    os.makedirs(audio_dir, exist_ok=True)
    local_bgm = os.path.join(audio_dir, os.path.basename(bgm_path))
    if not os.path.exists(local_bgm):
        shutil.copy2(bgm_path, local_bgm)

    material = cc.AudioMaterial(local_bgm)
    material_us = int(material.duration or 0)
    if material_us <= 0:
        raise SystemExit(json.dumps({"status": "error", "error": "bgm material duration invalid"}))
    script.add_material(material)

    spans = []
    cursor = 0
    while cursor < total_us:
        span = min(material_us, total_us - cursor)
        spans.append((cursor, span))
        cursor += span

    for index, (start_us, span_us) in enumerate(spans):
        segment = cc.AudioSegment(
            material=material,
            source_timerange=cc.Timerange(start=0, duration=span_us),
            target_timerange=cc.Timerange(start=start_us, duration=span_us),
            volume=BGM_VOLUME,
        )
        fade_in = BGM_FADE_IN_US if index == 0 else 0
        fade_out = min(BGM_FADE_OUT_US, span_us) if index == len(spans) - 1 else 0
        if fade_in or fade_out:
            segment.add_fade(fade_in, fade_out)
        script.add_segment(segment, track_name="bgm")

    script.save()
    print(json.dumps({
        "status": "ok",
        "draft": args.draft_name,
        "timeline_sec": round(total_us / 1_000_000, 3),
        "segments": len(spans),
        "replaced_existing": replaced,
        "volume": BGM_VOLUME,
        "fade_out_sec": round(min(BGM_FADE_OUT_US, spans[-1][1]) / 1_000_000, 2),
        "bgm": os.path.basename(bgm_path)
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
