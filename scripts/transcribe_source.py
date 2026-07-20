#!/usr/bin/env python3
"""Local transcript-first STT for midform sources.

Input: source mp4 path
Output: <source>_transcript.json with utterances and word timestamps.
"""

import argparse
import importlib
import json
import shutil
import subprocess
import sys
from pathlib import Path


def ffprobe_duration(path: Path) -> float:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        return float((proc.stdout or "0").strip() or 0)
    except ValueError:
        return 0.0


def extract_audio(source: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        ["ffmpeg", "-y", "-i", str(source), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(output)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout)[-2000:])


def most_common_language(words: list[dict], fallback: str) -> str:
    counts: dict[str, int] = {}
    for word in words:
        lang = str(word.get("lang") or fallback or "").strip()
        if not lang:
            continue
        counts[lang] = counts.get(lang, 0) + 1
    if not counts:
        return str(fallback or "").strip()
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))[0][0]


def words_to_utterances(words: list[dict], gap_sec: float, detected_language: str = "") -> list[dict]:
    utterances = []
    current = []
    for word in words:
        if not current:
            current = [word]
            continue
        gap = float(word["start"]) - float(current[-1]["end"])
        if gap >= gap_sec:
            utterances.append(current)
            current = [word]
        else:
            current.append(word)
    if current:
        utterances.append(current)

    rows = []
    for index, group in enumerate(utterances, 1):
        text = "".join(item["word"] for item in group).strip()
        text = " ".join(text.split())
        rows.append(
            {
                "utt_id": f"utt_{index:03d}",
                "start": round(float(group[0]["start"]), 3),
                "end": round(float(group[-1]["end"]), 3),
                "text": text,
                "lang": most_common_language(group, detected_language),
                "words": group,
            }
        )
    return rows


def transcribe_faster_whisper(audio: Path, model_name: str, gap_sec: float) -> dict:
    try:
        faster_whisper = importlib.import_module("faster_whisper")
    except ImportError as exc:
        raise RuntimeError("faster-whisper is not installed. Install with: python -m pip install faster-whisper") from exc

    WhisperModel = getattr(faster_whisper, "WhisperModel")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(str(audio), word_timestamps=True, beam_size=5)
    detected_language = str(getattr(info, "language", "") or "")
    words = []
    for segment in segments:
        segment_language = str(getattr(segment, "language", "") or detected_language)
        for word in segment.words or []:
            token = str(word.word or "")
            if not token.strip():
                continue
            words.append({"word": token, "start": round(float(word.start), 3), "end": round(float(word.end), 3), "lang": segment_language})
    return {
        "tool": "faster-whisper",
        "model": model_name,
        "language": detected_language,
        "language_probability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 4),
        "utterances": words_to_utterances(words, gap_sec, detected_language),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe source video with local faster-whisper.")
    parser.add_argument("source", help="Source mp4 path")
    parser.add_argument("--model", default="medium", help="faster-whisper model name: medium or large-v3")
    parser.add_argument("--gap-sec", type=float, default=0.6, help="Utterance boundary gap in seconds")
    parser.add_argument("--output", default="", help="Output transcript JSON path")
    args = parser.parse_args()

    source = Path(args.source).resolve()
    if not source.exists():
        raise SystemExit(f"source not found: {source}")
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise SystemExit("ffmpeg/ffprobe are required on PATH")

    output = Path(args.output).resolve() if args.output else source.with_name(f"{source.stem}_transcript.json")
    audio = output.with_suffix(".wav")
    extract_audio(source, audio)
    result = transcribe_faster_whisper(audio, args.model, args.gap_sec)
    result["source_path"] = str(source)
    result["source_duration"] = round(ffprobe_duration(source), 6)
    result["utterance_count"] = len(result["utterances"])
    result["total_utterance_duration"] = round(sum(max(0.0, row["end"] - row["start"]) for row in result["utterances"]), 3)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
