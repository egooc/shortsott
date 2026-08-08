"""Cut-boundary refinement: snap window edges to word/sentence/silence boundaries.

Standalone research helper (P2 of docs/opensource-adoption-analysis-2026-08-08.md).
Adapted from ClippyMe's pipeline/cut_ops.py and pipeline/media_probe.py
(MIT License, github.com/fralapo/clippyme, Copyright (c) 2026 ClippyMe).
Not wired into any production path.

Changes from upstream (documented in the adoption analysis):
  1. Stage guards are per-stage, not per-clip: a window without transcript words
     still gets silence-edge refinement (our sources are mostly no-speech).
  2. Default max clip duration 24s (our longform highlight cap), not 60s.
  3. Adaptive silence floor for machine audio: --noise-db auto measures the
     source's mean volume (ffmpeg volumedetect) and sets floor = mean - 12 dB,
     clamped to [-50, -18]; upstream's fixed -30 dB finds nothing over a
     factory noise floor.
  4. Overlap-bug fix: upstream clamps every clip against RAW neighbor intervals,
     so two clips closer than ~4s could both move into the gap and overlap.
     Windows are processed in time order and each start is clamped against the
     PREVIOUS clip's already-adjusted end.
  5. Sentence-final characters extended with Japanese/Korean enders.

Pipeline per window: word snap -> sentence snap -> silence-edge snap, each stage
contractually never worse than the previous (falls back to its input on conflict).

Usage
  python scripts/refine_cut_points.py --video V --windows-json W.json
         [--transcript T.json] [--json OUT] [--max-duration 24]
         [--noise-db auto|-30] [--min-silence 0.08]

  windows-json: [{"start_sec": float, "end_sec": float, ...extra keys kept...}]
  transcript (optional): {"segments":[{"words":[{"word","start","end"}]}]}
                         or a flat [{"word","start","end"}] list.

Output JSON
  { "silences": [[s,e],...], "noise_db": float,
    "windows": [{...original..., "refined_start_sec", "refined_end_sec",
                 "snap_path": "word+silence_end" | "silence" | "none" | ...}] }
"""

import argparse
import json
import re
import subprocess
import sys

# --- tuning constants (ClippyMe defaults unless noted) ----------------------

PRE_PAD = 0.05           # lead before the first word's attack
POST_PAD = 0.08          # tail after the last word's release
MAX_SNAP = 0.6           # word-boundary snap budget
SENTENCE_BACK = 2.5      # start may travel backward to a sentence onset
SENTENCE_FWD = 1.5       # end may travel forward to a sentence end
DEFAULT_MAX_DURATION = 24.0   # ours: longform highlight cap (upstream: 60)
SILENCE_WINDOW = 0.35    # max edge travel to reach a silence trough
SILENCE_LEAD = 0.04      # start sits this far before sound resumes
SILENCE_TAIL = 0.06      # end sits this far after sound stops

# JP/KR enders added to upstream's ".!?…"
SENTENCE_FINAL_CHARS = ".!?…。！？"

ABBREVIATIONS = frozenset(
    "mr. mrs. ms. dr. prof. sr. jr. st. etc. e.g. i.e. vs. approx. dept. est. "
    "min. max. no. fig. vol. pp. cf. al. inc. ltd. co. corp. "
    "sig. dott. avv. ing. geom. rag. sra. srta. ud. uds. mme. mlle. "
    "p.m. a.m. u.s. u.k.".split()
)

_SILENCE_START_RE = re.compile(r"silence_start:\s*(-?\d+(?:\.\d+)?)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*(-?\d+(?:\.\d+)?)")
_MEAN_VOLUME_RE = re.compile(r"mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB")


# --- transcript handling -----------------------------------------------------

def flatten_words(transcript):
    """Accepts whisper-style {"segments":[{"words":[...]}]} or a flat word list.
    Returns time-sorted [{"start","end","word"}], dropping broken timings."""
    if not transcript:
        return []
    raw = transcript
    if isinstance(transcript, dict):
        raw = []
        for segment in transcript.get("segments") or []:
            raw.extend(segment.get("words") or [])
    words = []
    for item in raw:
        try:
            start = float(item["start"])
            end = float(item["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if end <= start:
            continue
        words.append({"start": start, "end": end, "word": str(item.get("word", ""))})
    return sorted(words, key=lambda w: w["start"])


# --- stage 1: word-boundary snap ---------------------------------------------

def _nearest_boundary(target, boundaries, budget):
    best = None
    best_dist = budget
    for boundary in boundaries:
        dist = abs(boundary - target)
        if dist <= best_dist:
            best_dist = dist
            best = boundary
    return best


def snap_clip_to_words(start, end, words, source_duration):
    if not words:
        return start, end, False
    starts = [w["start"] for w in words]
    ends = [w["end"] for w in words]
    snapped_start = _nearest_boundary(start, starts, MAX_SNAP)
    snapped_end = _nearest_boundary(end, ends, MAX_SNAP)
    new_start = max(0.0, (snapped_start if snapped_start is not None else start) - PRE_PAD)
    new_end = (snapped_end if snapped_end is not None else end) + POST_PAD
    if source_duration > 0:
        new_end = min(new_end, source_duration)
    if new_end <= new_start:
        return start, end, False
    moved = snapped_start is not None or snapped_end is not None
    return new_start, new_end, moved


# --- stage 2: sentence-boundary snap -----------------------------------------

def _is_sentence_final(word):
    token = str(word.get("word", "")).strip()
    if len(token) < 2:
        return False
    if token.startswith("(") or token.startswith("["):
        return False
    if token[-1] not in SENTENCE_FINAL_CHARS:
        return False
    lowered = token.lower()
    if lowered in ABBREVIATIONS:
        return False
    core = lowered.rstrip(SENTENCE_FINAL_CHARS)
    if len(core) == 1 and core.isalpha():
        return False           # single-letter initials: "U."
    if "." in core:
        return False           # dotted acronyms: "U.S.", "p.m."
    if core.replace(",", "").replace(".", "").isdigit():
        return False           # numerics: "3.", "1,000."
    return True


def sentence_boundaries(words):
    onsets = []
    ends = []
    prev_final = True
    for word in words:
        if prev_final:
            onsets.append(word["start"])
        prev_final = _is_sentence_final(word)
        if prev_final:
            ends.append(word["end"])
    # Unpunctuated transcript: the lone "onset" is just word[0]; snapping there
    # would be arbitrary, so suppress onsets entirely.
    if not ends:
        onsets = []
    return onsets, ends


def snap_clip_to_sentences(start, end, words, source_duration, max_duration,
                           floor_start=None, ceil_end=None):
    """Returns (start, end, path_label)."""
    if not words:
        return start, end, "none"
    onsets, finals = sentence_boundaries(words)

    onset = max((o for o in onsets if o <= start + 1e-9 and start - o <= SENTENCE_BACK),
                default=None)
    final = min((f for f in finals if f >= end - 1e-9 and f - end <= SENTENCE_FWD),
                default=None)

    sent_start = max(0.0, onset - PRE_PAD) if onset is not None else None
    if sent_start is not None and floor_start is not None:
        sent_start = max(sent_start, floor_start)
    sent_end = final + POST_PAD if final is not None else None
    if sent_end is not None:
        if source_duration > 0:
            sent_end = min(sent_end, source_duration)
        if ceil_end is not None:
            sent_end = min(sent_end, ceil_end)

    # Degradation ladder: the backward start move survives a duration conflict
    # before the forward end move does.
    for s, s_label in ((sent_start, "sentence_start"), (start, "")):
        if s is None:
            continue
        for e, e_label in ((sent_end, "sentence_end"), (end, "")):
            if e is None:
                continue
            if e > s and (e - s) <= max_duration:
                if s_label and e_label:
                    return s, e, "sentence"
                return s, e, s_label or e_label or "word"
    return start, end, "word"


# --- stage 3: waveform silence snap ------------------------------------------

def parse_silencedetect(stderr_text):
    starts = _SILENCE_START_RE.findall(stderr_text or "")
    ends = _SILENCE_END_RE.findall(stderr_text or "")
    silences = []
    for start, end in zip(starts, ends):
        s, e = float(start), float(end)
        if e > s:
            silences.append((s, e))
    return sorted(silences)


def detect_silences(media_path, noise_db=-30.0, min_dur=0.08, timeout=180):
    try:
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", media_path, "-vn",
             "-af", f"silencedetect=noise={noise_db}dB:d={min_dur}",
             "-f", "null", "-"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout
        )
        return parse_silencedetect(proc.stderr)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return []


def measure_mean_volume(media_path, timeout=180):
    try:
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", media_path, "-vn",
             "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout
        )
        match = _MEAN_VOLUME_RE.search(proc.stderr)
        return float(match.group(1)) if match else None
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None


def resolve_noise_db(video_path, requested):
    if requested != "auto":
        return float(requested)
    mean_volume = measure_mean_volume(video_path)
    if mean_volume is None:
        return -30.0
    # Machine audio: troughs sit just below the running level, not at -30 dB.
    return max(-50.0, min(-18.0, mean_volume - 12.0))


def refine_edges_to_silence(start, end, silences, source_duration,
                            floor_start=None, ceil_end=None):
    """Start edge -> END of nearest silence (open as sound begins);
    end edge -> START of nearest silence (close as sound stops)."""
    if not silences:
        return start, end, "none"
    new_start, new_end = start, end
    moved_start = moved_end = False

    best = None
    for s, e in silences:
        dist = abs(e - start)
        if dist <= SILENCE_WINDOW and (best is None or dist < best[0]):
            best = (dist, s, e)
    if best is not None:
        _, s, e = best
        candidate = min(max(e - SILENCE_LEAD, s), e)
        if abs(candidate - start) > 1e-6:
            new_start = candidate
            moved_start = True

    best = None
    for s, e in silences:
        dist = abs(s - end)
        if dist <= SILENCE_WINDOW and (best is None or dist < best[0]):
            best = (dist, s, e)
    if best is not None:
        _, s, e = best
        candidate = min(max(s + SILENCE_TAIL, s), e)
        if abs(candidate - end) > 1e-6:
            new_end = candidate
            moved_end = True

    new_start = max(0.0, new_start)
    if floor_start is not None:
        new_start = max(new_start, floor_start)
    if source_duration > 0:
        new_end = min(new_end, source_duration)
    if ceil_end is not None:
        new_end = min(new_end, ceil_end)

    if new_end <= new_start:
        return start, end, "none"
    if moved_start and moved_end:
        return new_start, new_end, "silence"
    if moved_start:
        return new_start, new_end, "silence_start"
    if moved_end:
        return new_start, new_end, "silence_end"
    return new_start, new_end, "none"


# --- orchestration -----------------------------------------------------------

def refine_windows(windows, words, silences, source_duration, max_duration):
    """Process windows in TIME order; each start is clamped against the previous
    window's already-adjusted end (upstream clamped against raw intervals, which
    let two windows closer than ~4s move into the gap and overlap)."""
    order = sorted(range(len(windows)), key=lambda i: float(windows[i]["start_sec"]))
    results = [None] * len(windows)
    prev_adjusted_end = None

    for pos, index in enumerate(order):
        window = windows[index]
        raw_start = float(window["start_sec"])
        raw_end = float(window["end_sec"])
        floor_start = prev_adjusted_end
        ceil_end = (float(windows[order[pos + 1]]["start_sec"])
                    if pos + 1 < len(order) else None)

        path_parts = []
        start, end = raw_start, raw_end

        if words:
            start, end, moved = snap_clip_to_words(start, end, words, source_duration)
            if moved:
                path_parts.append("word")
            start, end, sentence_path = snap_clip_to_sentences(
                start, end, words, source_duration, max_duration,
                floor_start=floor_start, ceil_end=ceil_end
            )
            if sentence_path not in ("none", "word"):
                path_parts = [sentence_path]

        start, end, silence_path = refine_edges_to_silence(
            start, end, silences, source_duration,
            floor_start=floor_start, ceil_end=ceil_end
        )
        if silence_path != "none":
            path_parts.append(silence_path)

        if floor_start is not None:
            start = max(start, floor_start)
        if end <= start:
            start, end = raw_start, raw_end
            path_parts = ["none"]

        prev_adjusted_end = end
        results[index] = {
            **window,
            "refined_start_sec": round(start, 3),
            "refined_end_sec": round(end, 3),
            "refined_duration_sec": round(end - start, 3),
            "snap_path": "+".join(path_parts) if path_parts else "none",
        }
    return results


def probe_duration(video_path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", video_path],
            capture_output=True, text=True, encoding="utf-8", errors="replace", check=True, timeout=60
        ).stdout.strip()
        return float(out)
    except (subprocess.SubprocessError, ValueError, OSError):
        return 0.0


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--video", required=True)
    parser.add_argument("--windows-json", required=True)
    parser.add_argument("--transcript", default="")
    parser.add_argument("--json", dest="json_out", default="")
    parser.add_argument("--max-duration", type=float, default=DEFAULT_MAX_DURATION)
    parser.add_argument("--noise-db", default="auto")
    parser.add_argument("--min-silence", type=float, default=0.08)
    args = parser.parse_args()

    with open(args.windows_json, encoding="utf-8") as fh:
        windows = json.load(fh)
    if not isinstance(windows, list):
        raise SystemExit("windows-json must be a list of {start_sec, end_sec}")

    words = []
    if args.transcript:
        with open(args.transcript, encoding="utf-8") as fh:
            words = flatten_words(json.load(fh))

    source_duration = probe_duration(args.video)
    noise_db = resolve_noise_db(args.video, args.noise_db)
    silences = detect_silences(args.video, noise_db=noise_db,
                               min_dur=args.min_silence)

    refined = refine_windows(windows, words, silences, source_duration,
                             args.max_duration)

    result = {
        "video": args.video,
        "source_duration_sec": round(source_duration, 3),
        "noise_db": round(noise_db, 2),
        "min_silence_sec": args.min_silence,
        "silence_count": len(silences),
        "silences": [[round(s, 3), round(e, 3)] for s, e in silences],
        "word_count": len(words),
        "windows": refined,
    }

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        print(f"wrote {args.json_out} ({len(refined)} windows, "
              f"{len(silences)} silences @ {noise_db:.1f}dB)")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
