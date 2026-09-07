"""Decide which seconds of a source a vision pass should look at.

Fixed-period sampling was chosen for this pipeline on 2026-08-24 because ffmpeg scene detection
alone was too coarse - threshold 0.30 found 16 shots in a 534s source, one of them 152 seconds
long, so whole stretches of story went unseen. That reasoning is right about scene detection
ALONE and wrong about the choice: a 7s grid lands wherever it lands, so a two-second reaction
that carries the beat is skipped while three frames of one static wide are spent.

Union of the two is what the owner asked for (2026-09-06): a representative frame per cut, plus
a filler frame wherever a cut has not happened for a few seconds. Cuts give the beats, the
filler guarantees no long shot goes unseen, and neither is trusted alone.

    python midform/scripts/plan_scene_samples.py --duration 534 [--boundaries shots.json]
                                                 [--fill-sec 4] [--min-gap 1.5] [--max-frames 400]

Boundaries come from <source>.shot_boundaries.json, already cached beside every source for
b-roll snapping - the CPU for it is spent whether or not this uses it.

Prints {"samples":[{"start_sec","end_sec","at_sec","reason"}...]} in chronological order.
"""

import argparse
import json
import os
import re
import subprocess
import sys

# Past the dissolve: a frame taken exactly on a cut can catch the blend of two shots.
POST_CUT_OFFSET_SEC = 0.4
# Same threshold and micro-shot merge the b-roll snapper uses, so one cache serves both and a
# boundary means the same thing in each.
SCENE_THRESHOLD = 0.3
MIN_SHOT_SEC = 0.4


def detect_boundaries(video_path, cache_path):
    """Run ffmpeg scene detection and write the shared cache.

    The vision pass runs BEFORE b-roll snapping, so on a new source the cache does not exist yet
    and the cut half of the sampling silently disappears - the first contact-sheet run scored
    cut_samples 0 for exactly this reason. Detecting here does not add the cost, it moves it:
    the snapper reads this same file later and skips its own detection.
    """
    if not video_path or not os.path.exists(video_path):
        return []
    ffmpeg = os.environ.get("FFMPEG_PATH") or "ffmpeg"
    try:
        proc = subprocess.run(
            [ffmpeg, "-i", video_path, "-vf", f"select='gt(scene,{SCENE_THRESHOLD})',showinfo",
             "-an", "-f", "null", "-"],
            capture_output=True, text=True, errors="replace", check=False, timeout=1800,
        )
    except Exception:
        return []
    raw = sorted(float(m) for m in re.findall(r"pts_time:([0-9]+(?:\.[0-9]+)?)", proc.stderr or "")
                 if float(m) > 0)
    boundaries = [v for i, v in enumerate(raw) if i == 0 or v - raw[i - 1] >= MIN_SHOT_SEC]
    if cache_path:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(cache_path)) or ".", exist_ok=True)
            with open(cache_path, "w", encoding="utf-8") as handle:
                json.dump({"threshold": SCENE_THRESHOLD, "boundaries": boundaries}, handle)
        except Exception:
            pass
    return boundaries


def load_boundaries(path):
    if not path or not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            data = json.load(handle)
    except Exception:
        return []
    values = data.get("boundaries") if isinstance(data, dict) else data
    return sorted(float(v) for v in (values or []) if isinstance(v, (int, float)) and v >= 0)


def load_energy_peaks(path):
    """상위 에너지 피크 구간 - 행동 샷은 한 장으로 대표하면 안 된다(소유주 스펙 2026-09-07):
    총을 뽑고 쏘는 2초는 0.3~0.5s 간격 스트립이어야 사건의 전/중/후가 지도에 남는다."""
    if not path or not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            data = json.load(handle)
    except Exception:
        return []
    peaks = data.get("peaks") if isinstance(data, dict) else []
    out = []
    for peak in (peaks or [])[:8]:
        start = float(peak.get("start_sec", -1))
        end = float(peak.get("end_sec", -1))
        if end > start >= 0:
            out.append((start, end))
    return out


def plan(duration_sec, boundaries, fill_sec, min_gap, max_frames, energy_peaks=None):
    picks = []

    def add(at_sec, reason):
        at_sec = max(0.0, min(float(at_sec), max(0.0, duration_sec - 0.1)))
        gap = 0.3 if reason == "peak_strip" else min_gap
        for existing in picks:
            if abs(existing["at_sec"] - at_sec) < gap:
                return
        picks.append({"at_sec": round(at_sec, 3), "reason": reason})

    for boundary in boundaries:
        if boundary < duration_sec:
            add(boundary + POST_CUT_OFFSET_SEC, "cut")

    # 피크 스트립: 행동 구간은 0.4s 간격으로 사건의 단계(전/시작/최고점/결과)가 프레임에 남게.
    for (peak_start, peak_end) in (energy_peaks or []):
        t = max(0.0, peak_start - 0.4)
        stop = min(duration_sec, peak_end + 0.8)
        strip_count = 0
        while t < stop and strip_count < 8:  # 스트립당 5~8장 (스펙)
            add(t, "peak_strip")
            strip_count += 1
            t += 0.4

    # Filler runs on the same clock for every source, so a rebuild samples the same seconds and
    # the scene map stays comparable across runs.
    t = 0.0
    while t < duration_sec:
        add(t + fill_sec / 2.0, "fill")
        t += fill_sec

    picks.sort(key=lambda row: row["at_sec"])

    # Too many frames is its own failure: the sheets stop fitting a context window and the model
    # starts skipping cells. Thin the FILL picks first - the cuts are the ones carrying beats.
    if max_frames and len(picks) > max_frames:
        cuts = [p for p in picks if p["reason"] in ("cut", "peak_strip")]
        fills = [p for p in picks if p["reason"] not in ("cut", "peak_strip")]
        room = max(0, max_frames - len(cuts))
        if room and fills:
            step = len(fills) / room
            fills = [fills[int(i * step)] for i in range(room)]
        elif not room:
            fills = []
        picks = sorted(cuts + fills, key=lambda row: row["at_sec"])[:max_frames]

    samples = []
    for index, pick in enumerate(picks):
        start = pick["at_sec"] if index == 0 else (picks[index - 1]["at_sec"] + pick["at_sec"]) / 2
        end = duration_sec if index == len(picks) - 1 else (pick["at_sec"] + picks[index + 1]["at_sec"]) / 2
        samples.append({
            "at_sec": pick["at_sec"],
            "start_sec": round(max(0.0, start), 3),
            "end_sec": round(min(duration_sec, end), 3),
            "reason": pick["reason"],
        })
    return samples


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--boundaries", default="")
    parser.add_argument("--video", default="", help="detect boundaries from this file when the cache is missing")
    parser.add_argument("--fill-sec", type=float, default=4.0)
    parser.add_argument("--min-gap", type=float, default=1.5)
    parser.add_argument("--max-frames", type=int, default=400)
    parser.add_argument("--energy", default="", help="energy_profile.json - 피크 구간은 0.4s 스트립으로 밀집 샘플")
    args = parser.parse_args()

    boundaries = load_boundaries(args.boundaries)
    if not boundaries and args.video:
        boundaries = detect_boundaries(args.video, args.boundaries)
    peaks = load_energy_peaks(args.energy)
    samples = plan(args.duration, boundaries, args.fill_sec, args.min_gap, args.max_frames, peaks)
    print(json.dumps({
        "duration_sec": args.duration,
        "boundaries_used": len(boundaries),
        "samples": samples,
        "cut_samples": sum(1 for s in samples if s["reason"] == "cut"),
        "fill_samples": sum(1 for s in samples if s["reason"] != "cut"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
