#!/usr/bin/env python3
"""Word-level timestamps for a source video via faster-whisper.

Auto-caption cues are the pipeline's coordinate system, but a cue is a 2-9s block:
cut edges land on cue boundaries, not word boundaries. This produces the word grid
that lets dialogue windows snap to the actual first/last word of a line.

Optional dependency: pip install faster-whisper. Exits 3 with a clear message when
the package is missing so the Node side can degrade gracefully (cue-boundary cuts,
exactly the behaviour before this script existed).
"""
import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True, help="source video/audio path")
    parser.add_argument("--out", required=True, help="output json path")
    parser.add_argument("--model", default="base", help="faster-whisper model size (default: base)")
    parser.add_argument("--language", default="en")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError:
        print("faster-whisper is not installed (pip install faster-whisper)", file=sys.stderr)
        return 3

    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        args.audio,
        language=args.language or None,
        word_timestamps=True,
        vad_filter=True,
    )
    words = []
    for segment in segments:
        for word in segment.words or []:
            text = (word.word or "").strip()
            if not text:
                continue
            words.append({
                "w": text,
                "start_sec": round(float(word.start), 3),
                "end_sec": round(float(word.end), 3),
            })
    payload = {
        "language": getattr(info, "language", args.language),
        "model": args.model,
        "word_count": len(words),
        "words": words,
    }
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    print(f"wrote {len(words)} words -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
