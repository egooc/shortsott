#!/usr/bin/env python3
"""Repair a regenerated midform GPT script and build a draft input.

This utility is intentionally scoped to the midform retry workflow. It fixes
source-duration drift, snaps dialogue segments to STT utterances, assigns valid
monotonic story anchors inside the source duration, and creates matching
edge-tts audio files for recap caption units.

Security note: edge-tts uses Microsoft's online Edge TTS service, so narration
text is sent over the network when this script synthesizes audio.
"""

import argparse
import asyncio
import json
import re
import subprocess
from pathlib import Path

import edge_tts


SOURCE_DURATION_SEC = 174.985578
VOICE = "ko-KR-SunHiNeural"
TTS_PROVIDER = "Microsoft Edge online TTS via edge-tts"
SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9_.-]+")

ANCHOR_REPAIR = {
    "seg_011": ([156.0, 160.0], ["scene_009"]),
    "seg_012": ([160.0, 164.0], ["scene_009"]),
    "seg_013": ([164.0, 168.0], ["scene_009"]),
    "seg_014": ([168.0, 171.0], ["scene_010"]),
    "seg_015": ([171.0, SOURCE_DURATION_SEC], ["scene_010"]),
}


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def seconds_to_timecode(value):
    value = max(0.0, float(value))
    hours = int(value // 3600)
    value -= hours * 3600
    minutes = int(value // 60)
    seconds = value - minutes * 60
    return f"{hours:02d}:{minutes:02d}:{seconds:06.3f}"


def normalize_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def safe_filename_stem(value, fallback="caption"):
    stem = SAFE_FILENAME_RE.sub("_", str(value or "").strip()).strip("._")
    return stem or fallback


def contained_output_path(output_dir, filename):
    base_dir = Path(output_dir).resolve()
    output_path = (base_dir / filename).resolve()
    if output_path.parent != base_dir:
        raise ValueError(f"Unsafe TTS output path escaped --tts-dir: {filename}")
    return output_path


def split_caption_text(text, hard_limit=38):
    text = normalize_text(text)
    if not text:
        return []
    pieces = []
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        sentence = sentence.strip()
        if not sentence:
            continue
        while len(sentence) > hard_limit:
            cut = sentence.rfind(" ", 0, hard_limit + 1)
            if cut < 12:
                cut = hard_limit
            pieces.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        if sentence:
            pieces.append(sentence)
    return pieces or [text]


def build_caption_units(segments):
    units = []
    for index, segment in enumerate(segments, start=1):
        segment_id = segment.get("segment_id") or f"seg_{index:03d}"
        segment_type = segment.get("segment_type") or "recap"
        tts_enabled = segment_type not in {"dialogue_quote", "dialogue"} and segment.get("tts_enabled") is not False
        text = segment.get("translated_caption_ko") or segment.get("caption_text") if segment_type in {"dialogue_quote", "dialogue"} else segment.get("narration") or segment.get("caption_text")
        text = normalize_text(text)
        if not text:
            continue
        for order, piece in enumerate(split_caption_text(text), start=1):
            safe_segment_id = safe_filename_stem(segment_id, f"seg_{index:03d}")
            caption_id = f"{safe_segment_id}_cap_{order:03d}"
            units.append(
                {
                    "caption_id": caption_id,
                    "segment_id": segment_id,
                    "segment_type": segment_type,
                    "tts_enabled": tts_enabled,
                    "order": order,
                    "text": piece,
                    "source_segment_order": index,
                }
            )
    return units


def ffprobe_duration(path):
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


async def synthesize_unit(unit, output_dir):
    caption_id = safe_filename_stem(unit.get("caption_id"), "caption")
    output_path = contained_output_path(output_dir, f"{caption_id}.mp3")
    await edge_tts.Communicate(unit["text"], VOICE).save(str(output_path))
    return {
        "caption_id": caption_id,
        "segment_id": unit["segment_id"],
        "filename": output_path.name,
        "filepath": str(output_path.resolve()),
        "duration_sec": round(ffprobe_duration(output_path), 3),
        "text": unit["text"],
        "success": True,
    }


async def synthesize_tts(caption_units, output_dir):
    Path(output_dir).resolve().mkdir(parents=True, exist_ok=True)
    files = []
    for unit in caption_units:
        if unit.get("tts_enabled") is False:
            continue
        files.append(await synthesize_unit(unit, output_dir))
    return files


def repair_script(script, transcript):
    utterances = {item["utt_id"]: item for item in transcript.get("utterances", []) if item.get("utt_id")}
    script.setdefault("source_reference", {})["duration_sec"] = SOURCE_DURATION_SEC
    script["story_anchor_retry_repaired"] = True
    script["story_anchor_retry_repair_notes"] = [
        "source_reference.duration_sec set from ffprobe source duration",
        "dialogue_quote source ranges snapped to transcript utterance timings",
        "late story anchors clamped/reallocated into the source duration",
    ]

    for segment in script.get("segments", []):
        segment_id = str(segment.get("segment_id") or "")
        segment_type = str(segment.get("segment_type") or "")
        if segment_id in ANCHOR_REPAIR:
            anchor_range, scene_refs = ANCHOR_REPAIR[segment_id]
            segment["story_anchor"] = {"source_range_hint": anchor_range, "scene_refs": scene_refs}
            segment["source_scenes"] = [
                {
                    "clip_id": f"{segment_id}_anchor_repaired",
                    "scene_id": scene_refs[0],
                    "start": seconds_to_timecode(anchor_range[0]),
                    "end": seconds_to_timecode(anchor_range[1]),
                    "speed_multiplier": 1,
                    "source": "story_anchor_retry_repair",
                }
            ]

        if segment_type in {"dialogue_quote", "dialogue"}:
            utt_id = str(segment.get("utt_id") or "").strip()
            utterance = utterances.get(utt_id)
            if not utterance:
                raise ValueError(f"Unknown dialogue utt_id: {utt_id}")
            start = float(utterance["start"])
            end = float(utterance["end"])
            segment["dialogue_original"] = utterance.get("text", "")
            segment["tts_enabled"] = False
            segment["story_anchor"] = {
                "source_range_hint": [start, end],
                "scene_refs": (segment.get("story_anchor") or {}).get("scene_refs") or ["transcript_dialogue"],
            }
            clip = {
                "clip_id": f"transcript_{utt_id}",
                "scene_id": segment["story_anchor"]["scene_refs"][0],
                "utt_id": utt_id,
                "start": seconds_to_timecode(start),
                "end": seconds_to_timecode(end),
                "speed_multiplier": 1,
                "source": "transcript_utterance",
            }
            segment["source_scenes"] = [clip]
            segment["source_clips"] = [clip]

    return script


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", required=True)
    parser.add_argument("--transcript", required=True)
    parser.add_argument("--source-video", required=True)
    parser.add_argument("--output-script", required=True)
    parser.add_argument("--output-draft-input", required=True)
    parser.add_argument("--tts-dir", required=True)
    args = parser.parse_args()

    script = repair_script(load_json(args.script), load_json(args.transcript))
    segments = script.get("segments", [])
    caption_units = build_caption_units(segments)
    tts_files = await synthesize_tts(caption_units, args.tts_dir)

    draft_input = {
        "segments": segments,
        "ttsFiles": tts_files,
        "captionUnits": caption_units,
        "captionWarnings": [],
        "claudeScript": script,
        "gptScript": script,
        "source_video_path": str(Path(args.source_video).resolve()),
        "source_transcript_path": str(Path(args.transcript).resolve()),
        "sourceDurationSec": SOURCE_DURATION_SEC,
        "videoPlacementMode": "source_clips",
        "audioPathMode": "absolute",
        "useCapcutTemplate": True,
        "resolution": {"width": 1080, "height": 1920},
        "fps": 30,
        "repairMetadata": {
            "source": "repair_story_anchor_retry.py",
            "voice": VOICE,
            "tts_model_id": f"edge-tts:{VOICE}",
            "tts_provider": TTS_PROVIDER,
            "tts_network_disclosure": "Narration text is sent to Microsoft's online Edge TTS service during synthesis.",
        },
    }

    write_json(args.output_script, script)
    write_json(args.output_draft_input, draft_input)
    manifest_path = contained_output_path(args.tts_dir, "gpt_midform_tts_manifest.json")
    write_json(
        manifest_path,
        {
            "model_id": f"edge-tts:{VOICE}",
            "tts_provider": TTS_PROVIDER,
            "tts_network_disclosure": "Narration text is sent to Microsoft's online Edge TTS service during synthesis.",
            "caption_units": caption_units,
            "files": tts_files,
        },
    )
    print(json.dumps({"segments": len(segments), "captionUnits": len(caption_units), "ttsFiles": len(tts_files)}, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
