#!/usr/bin/env python3
"""STT fallback transcript for sources with no subtitle track (faster-whisper).

Scope decision 2026-08-09 (user-approved): a subtitle-less upload used to hard-block the
pipeline. Now, when yt-dlp finds no VTT, this produces cue-level segments in the same shape
as transcript_timed.json. Built for SPARSE-dialogue sources (action scenes); the filters
kill the failure modes whisper shows on music-heavy footage:

- music hallucination loops ("uh," x10): consecutive near-identical texts capped at 2
- pure interjections (uh/oh/mm/huh...) dropped - they caption nothing
- low-confidence segments dropped (no_speech_prob > 0.5 or avg_logprob < -1.0)

Exit 3 when faster-whisper is missing so the caller can fall back to the old hard block.
"""
import argparse
import json
import re
import sys

INTERJECTION_RE = re.compile(r"^(?:(?:uh|oh|mm|hmm|huh|ow|ah|agh|argh|ugh|hey|whoa|wow|mm-hmm)[,.!?\s-]*)+$", re.IGNORECASE)


def normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", text.lower()).strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="medium")
    parser.add_argument("--language", default="en")
    parser.add_argument("--max-no-speech-prob", type=float, default=0.5)
    parser.add_argument("--min-avg-logprob", type=float, default=-1.0)
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError:
        print("faster-whisper is not installed (pip install faster-whisper)", file=sys.stderr)
        return 3

    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    # vad_filter stays OFF: on the Shelter scout the default VAD swallowed 7 of 8 real lines
    # under the action mix. The confidence/loop filters below do the cleanup instead.
    segments, info = model.transcribe(
        args.audio,
        language=args.language or None,
        vad_filter=False,
        condition_on_previous_text=False,
        beam_size=5,
        word_timestamps=True,
    )

    cues = []
    run_key = None
    run_count = 0
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        if seg.no_speech_prob is not None and seg.no_speech_prob > args.max_no_speech_prob:
            continue
        if seg.avg_logprob is not None and seg.avg_logprob < args.min_avg_logprob:
            continue
        if INTERJECTION_RE.match(text):
            continue
        key = normalize(text)
        if key == run_key:
            run_count += 1
            if run_count > 2:  # hallucination loop cap; two real repeated shouts still survive
                continue
        else:
            run_key = key
            run_count = 1
        start = float(seg.start)
        end = float(seg.end)
        # word timestamps give tighter bounds than segment padding when available
        words = list(seg.words or [])
        if words:
            start = float(words[0].start)
            end = float(words[-1].end)
        if end - start < 0.25:
            continue
        cues.append({
            "start_sec": round(start, 3),
            "end_sec": round(end, 3),
            "text": text,
            "stt": True,
        })

    payload = {
        "source": "faster-whisper",
        "model": args.model,
        "language": getattr(info, "language", args.language),
        "cues": cues,
    }
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
    print(f"wrote {len(cues)} cues -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
