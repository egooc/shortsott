# -*- coding: utf-8 -*-
"""A1 transcript cleaning: never trust VTT cue timestamps directly.

Owner spec (2026-09-07, scene-evidence-architecture.md #1): auto-caption cues smear tens of
seconds past the speech (tokyo: 17/128 cues over 8s, a 21s "[Music]" cue; shaolin: a cue at
90-108.5s whose words are actually spoken at 100.7-101.7 - the root of a subtitle showing
10 seconds early). Every downstream coordinate - beats, plan windows, dialogue clips - is
built on these numbers, so they get re-timed against word-level STT before anything reads them.

  python midform/scripts/clean_transcript.py <compress_run_dir> [--dry-run]

- Writes transcript_timed.raw.json ONCE (원시 증거, immutable - never overwritten).
- Rewrites transcript_timed.json with word-aligned times; each adjusted cue carries
  {"retimed": true, "raw_start_sec": ..., "raw_end_sec": ...}.
- A cue that cannot be matched confidently keeps its original numbers (marked "unmatched") -
  a wrong "fix" is worse than a known smear.
"""
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from asr_backend import transcribe  # Groq whisper-large-v3, absolute timestamps

MAX_SHIFT_SEC = 30.0        # a match further than this from the cue is a different line
MIN_ADJUST_SEC = 0.6        # smaller deltas are noise - leave the cue alone
MIN_TOKENS = 2              # one-word cues can't be matched safely


def norm_token(text):
    return re.sub(r"[^a-z0-9']", "", str(text).lower())


def cue_tokens(text):
    return [t for t in (norm_token(w) for w in str(text).split()) if len(t) >= 2]


def align(cues, words):
    """Sequential fuzzy alignment: for each cue, find its first/last tokens in the word
    stream near the cue's claimed time, moving a cursor forward so lines cannot swap."""
    word_norms = [norm_token(w["word"]) for w in words]
    cursor = 0
    results = []
    for cue in cues:
        tokens = cue_tokens(cue.get("text", ""))
        raw_start = float(cue.get("start_sec", cue.get("start", 0)) or 0)
        raw_end = float(cue.get("end_sec", cue.get("end", 0)) or 0)
        if len(tokens) < MIN_TOKENS:
            results.append((cue, None, "too_short"))
            continue
        head = tokens[:3]
        # 후보를 전부 모아 '주장 시각에서 가장 덜 움직이는' 것을 고른다 - 같은 대사가 두 번
        # 나오는 소스에서 첫 후보를 잡으면 10초 밖 다른 인스턴스에 붙는다 (실측: "Can he drive?").
        candidates = []
        for i in range(cursor, len(words)):
            if words[i]["start"] > raw_start + MAX_SHIFT_SEC:
                break
            if words[i]["start"] < raw_start - MAX_SHIFT_SEC:
                continue
            hits = sum(1 for k, tok in enumerate(head)
                       if i + k * 2 < len(word_norms)
                       and any(tok == word_norms[j] for j in range(i + max(0, k * 2 - 1), min(len(word_norms), i + k * 2 + 2))))
            if hits >= max(2, len(head) - 1):
                candidates.append(i)
        if not candidates:
            results.append((cue, None, "unmatched"))
            continue
        best = min(candidates, key=lambda i: abs(words[i]["start"] - raw_start))
        shift = abs(words[best]["start"] - raw_start)
        if shift > 6.0 and len(tokens) < 4:
            # 짧은 줄이 6초 넘게 움직이는 건 중복 대사 오귀속일 확률이 높다 - 손대지 않는다.
            results.append((cue, None, "weak"))
            continue
        # 꼬리: 연속 발화(단어 간격 <=1.0s)만 소비 - 흔한 단어를 뒤에서 주워 담으면
        # 3단어 큐가 8초로 과신장된다 (실측).
        ti = 0
        last = best
        prev_end = words[best]["start"]
        for j in range(best, min(len(words), best + len(tokens) * 3)):
            if words[j]["start"] - prev_end > 1.0:
                break
            if ti < len(tokens) and word_norms[j] == tokens[ti]:
                ti += 1
                last = j
            elif 0 < ti < len(tokens) and word_norms[j] == tokens[min(ti + 1, len(tokens) - 1)]:
                ti = min(ti + 2, len(tokens))
                last = j
            prev_end = words[j]["end"]
            if ti >= len(tokens):
                break
        matched_ratio = ti / len(tokens)
        start = float(words[best]["start"])
        end = float(words[last]["end"])
        max_plausible = len(tokens) * 0.9 + 2.5
        if end - start > max_plausible:
            end = start + max_plausible
        if matched_ratio < 0.5 or not (end > start):
            results.append((cue, None, "weak"))
            continue
        cursor = max(cursor, best)
        results.append((cue, (start, end), f"ok:{matched_ratio:.2f}"))
    return results


def main():
    run_dir = sys.argv[1] if len(sys.argv) > 1 else ""
    dry = "--dry-run" in sys.argv
    t_path = os.path.join(run_dir, "transcript_timed.json")
    raw_path = os.path.join(run_dir, "transcript_timed.raw.json")
    src_path = os.path.join(run_dir, "source.mp4")
    if not (os.path.exists(t_path) and os.path.exists(src_path)):
        print(json.dumps({"error": "transcript_timed.json or source.mp4 missing", "run_dir": run_dir}))
        return 2

    with io.open(t_path, encoding="utf-8-sig") as fh:
        transcript = json.load(fh)
    cues = transcript if isinstance(transcript, list) else transcript.get("cues", [])

    asr = transcribe(src_path, language="en")
    words = [w for w in asr.get("words", []) if norm_token(w.get("word", ""))]
    if len(words) < 10:
        print(json.dumps({"error": "too few STT words", "backend": asr.get("backend"), "words": len(words)}))
        return 2

    adjusted = 0
    unmatched = 0
    for cue, span, why in align(cues, words):
        raw_start = float(cue.get("start_sec", cue.get("start", 0)) or 0)
        raw_end = float(cue.get("end_sec", cue.get("end", 0)) or 0)
        if span is None:
            if why in ("unmatched", "weak"):
                unmatched += 1
                cue["retime_status"] = why
            continue
        start, end = span
        if abs(start - raw_start) < MIN_ADJUST_SEC and abs(end - raw_end) < MIN_ADJUST_SEC:
            cue["retime_status"] = "kept"
            continue
        cue["raw_start_sec"] = raw_start
        cue["raw_end_sec"] = raw_end
        if "start_sec" in cue:
            cue["start_sec"] = round(start, 3)
            cue["end_sec"] = round(end, 3)
        else:
            cue["start"] = round(start, 3)
            cue["end"] = round(end, 3)
        cue["retimed"] = True
        cue["retime_status"] = why
        adjusted += 1

    summary = {"backend": asr.get("backend"), "cues": len(cues), "adjusted": adjusted,
               "unmatched": unmatched, "dry_run": dry}
    if not dry:
        if not os.path.exists(raw_path):
            os.replace(t_path, raw_path)
        else:
            os.remove(t_path)
        with io.open(t_path, "w", encoding="utf-8") as fh:
            json.dump(transcript, fh, ensure_ascii=False, indent=2)
        summary["raw_preserved"] = raw_path
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
