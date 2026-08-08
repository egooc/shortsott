"""Post-export QA probe for a finished clip: black frames, silence, loudness, duration.

Standalone research helper (P3 of docs/opensource-adoption-analysis-2026-08-08.md).
Independently reimplemented from the behavioral specification documented in that
analysis (threshold set and single-decode design observed in AGPL projects; no
code was copied — this file derives only from the spec table in the doc).
Not wired into any production path.

One ffmpeg decode over the finished clip:
  -vf blackdetect=d=0.5:pix_th=0.10
  -af silencedetect=n=-50dB:d=2,ebur128=peak=true
plus one ffprobe for the real duration.

Checks (status is pass/warn only — QA informs, it never blocks, matching this
product's skip-not-fail policy):
  black span >= 0.5s | silence -50dB >= 2s | integrated loudness off -14 LUFS
  by more than 2 LU | true peak above -1 dBTP | duration off the expected value
  by more than 0.75s.

Usage
  python scripts/qa_probe_clip.py <clip.mp4> [--expected-duration S]
         [--target-lufs -14] [--json OUT]
  python scripts/qa_probe_clip.py --batch <dir> [--json OUT]   # every mp4 in dir

Output JSON (single): { "status": "pass"|"warn", "issues": [...],
  "duration_sec", "black_spans", "silence_spans",
  "loudness": {"integrated_lufs", "true_peak_db"} | null }
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

BLACK_MIN_SEC = 0.5
BLACK_PIX_TH = 0.10
SILENCE_NOISE_DB = -50
SILENCE_MIN_SEC = 2
TARGET_LUFS = -14.0
LOUDNESS_TOLERANCE_LU = 2.0
TRUE_PEAK_CEILING_DB = -1.0
DURATION_TOLERANCE_SEC = 0.75
STDERR_CAP_BYTES = 4 * 1024 * 1024

_BLACK_RE = re.compile(
    r"black_start:(-?\d+(?:\.\d+)?)\s+black_end:(-?\d+(?:\.\d+)?)"
)
_SILENCE_START_RE = re.compile(r"silence_start:\s*(-?\d+(?:\.\d+)?)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*(-?\d+(?:\.\d+)?)")
_LUFS_RE = re.compile(r"I:\s*(-?\d+(?:\.\d+)?)\s*LUFS")
_PEAK_RE = re.compile(r"Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS")


def probe_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", check=True, timeout=60
    ).stdout.strip()
    return float(out)


def scan_clip(path):
    """Single decode pass; returns the full (capped) stderr text."""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
         "-vf", f"blackdetect=d={BLACK_MIN_SEC}:pix_th={BLACK_PIX_TH}",
         "-af", f"silencedetect=n={SILENCE_NOISE_DB}dB:d={SILENCE_MIN_SEC},"
                "ebur128=peak=true",
         "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600
    )
    return (proc.stderr or "")[:STDERR_CAP_BYTES]


def parse_black_spans(stderr_text):
    spans = []
    for start, end in _BLACK_RE.findall(stderr_text):
        s, e = float(start), float(end)
        if e - s >= BLACK_MIN_SEC:
            spans.append((s, e))
    return spans


def parse_silence_spans(stderr_text, stream_end_sec):
    """Starts/ends appear on separate lines and pair in order; a trailing
    unclosed silence_start (silence to EOF) is closed with the stream end."""
    starts = [float(v) for v in _SILENCE_START_RE.findall(stderr_text)]
    ends = [float(v) for v in _SILENCE_END_RE.findall(stderr_text)]
    spans = []
    for i, s in enumerate(starts):
        if i < len(ends):
            e = ends[i]
        elif stream_end_sec and stream_end_sec > s:
            e = stream_end_sec
        else:
            continue
        if e > s:
            spans.append((s, e))
    return spans


def parse_loudness(stderr_text):
    """ebur128 prints running values throughout; the summary is the LAST match."""
    lufs_matches = _LUFS_RE.findall(stderr_text)
    peak_matches = _PEAK_RE.findall(stderr_text)
    if not lufs_matches:
        return None
    return {
        "integrated_lufs": float(lufs_matches[-1]),
        "true_peak_db": float(peak_matches[-1]) if peak_matches else None,
    }


def assess(path, duration, black_spans, silence_spans, loudness,
           expected_duration=None, target_lufs=TARGET_LUFS):
    """Pure verdict builder: measurements -> {status, issues}."""
    issues = []
    if black_spans:
        longest = max(e - s for s, e in black_spans)
        issues.append(
            f"black frames: {len(black_spans)} span(s), longest {longest:.2f}s"
        )
    if silence_spans:
        longest = max(e - s for s, e in silence_spans)
        issues.append(
            f"long silence: {len(silence_spans)} span(s) at {SILENCE_NOISE_DB}dB, "
            f"longest {longest:.2f}s"
        )
    if loudness:
        deviation = loudness["integrated_lufs"] - target_lufs
        if abs(deviation) > LOUDNESS_TOLERANCE_LU:
            issues.append(
                f"loudness {loudness['integrated_lufs']:.1f} LUFS is "
                f"{deviation:+.1f} LU off the {target_lufs:.0f} target"
            )
        peak = loudness.get("true_peak_db")
        if peak is not None and peak > TRUE_PEAK_CEILING_DB:
            issues.append(
                f"true peak {peak:.1f} dBTP above {TRUE_PEAK_CEILING_DB:.0f} "
                "(platform transcode clipping risk)"
            )
    if expected_duration is not None:
        delta = abs(duration - expected_duration)
        if delta > DURATION_TOLERANCE_SEC:
            issues.append(
                f"duration {duration:.2f}s is {delta:.2f}s off the expected "
                f"{expected_duration:.2f}s"
            )
    return {
        "file": str(path),
        "status": "warn" if issues else "pass",
        "issues": issues,
        "duration_sec": round(duration, 3),
        "expected_duration_sec": expected_duration,
        "black_spans": [[round(s, 2), round(e, 2)] for s, e in black_spans],
        "silence_spans": [[round(s, 2), round(e, 2)] for s, e in silence_spans],
        "loudness": (
            {
                "integrated_lufs": round(loudness["integrated_lufs"], 1),
                "true_peak_db": (
                    round(loudness["true_peak_db"], 1)
                    if loudness.get("true_peak_db") is not None else None
                ),
            }
            if loudness else None
        ),
    }


def probe_one(path, expected_duration=None, target_lufs=TARGET_LUFS):
    duration = probe_duration(path)
    stderr_text = scan_clip(path)
    return assess(
        path,
        duration,
        parse_black_spans(stderr_text),
        parse_silence_spans(stderr_text, duration),
        parse_loudness(stderr_text),
        expected_duration=expected_duration,
        target_lufs=target_lufs,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("clip", nargs="?", default="")
    parser.add_argument("--batch", default="")
    parser.add_argument("--expected-duration", type=float, default=None)
    parser.add_argument("--target-lufs", type=float, default=TARGET_LUFS)
    parser.add_argument("--json", dest="json_out", default="")
    args = parser.parse_args()

    if args.batch:
        clips = sorted(Path(args.batch).glob("*.mp4"))
        if not clips:
            raise SystemExit(f"no mp4 files in {args.batch}")
        reports = []
        for clip in clips:
            try:
                reports.append(probe_one(clip, target_lufs=args.target_lufs))
            except Exception as error:  # a broken file must not kill the batch
                reports.append({
                    "file": str(clip), "status": "warn",
                    "issues": [f"probe failed: {type(error).__name__}: {error}"],
                })
        result = {
            "batch": args.batch,
            "total": len(reports),
            "warn": sum(1 for r in reports if r["status"] == "warn"),
            "clips": reports,
        }
    elif args.clip:
        result = probe_one(args.clip, expected_duration=args.expected_duration,
                           target_lufs=args.target_lufs)
    else:
        parser.error("give a clip path or --batch <dir>")
        return 2

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        print(f"wrote {args.json_out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
