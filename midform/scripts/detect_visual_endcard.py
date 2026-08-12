#!/usr/bin/env python3
"""Detect a channel end-card overlaid on the film (Clip Empire style: big yellow
"WATCH MORE / SUBSCRIBE" boxes on the right side, channel logo bottom-left).

Subtitle-based promo detection misses these because the film's own audio/dialogue
keeps playing under the overlay. This scans the last window of frames for the yellow
box signature and returns the second where it first appears, so usable_end can cut
before the recommendation cards.

Usage: python detect_visual_endcard.py <video_path> <duration_sec> [scan_window_sec]
Output (stdout, JSON): {"endcard_start_sec": <float or null>, "scanned": <int>}
"""
import json
import os
import subprocess
import sys
import tempfile

try:
    from PIL import Image
except Exception:
    print(json.dumps({"endcard_start_sec": None, "scanned": 0, "error": "PIL missing"}))
    sys.exit(0)

FFMPEG = os.environ.get("FFMPEG_PATH") or "ffmpeg"


def yellow_ratio(image):
    """Fraction of the RIGHT THIRD of the frame that is bright card-yellow.
    The Clip Empire cards are a saturated gold (~#D9A200): high R, high-ish G, low B."""
    w, h = image.size
    crop = image.crop((int(w * 0.62), int(h * 0.08), w, int(h * 0.92))).convert("RGB")
    crop = crop.resize((max(1, crop.width // 4), max(1, crop.height // 4)))
    px = crop.load()
    total = crop.width * crop.height
    if not total:
        return 0.0
    hits = 0
    for y in range(crop.height):
        for x in range(crop.width):
            r, g, b = px[x, y]
            if r > 140 and 80 < g < 225 and b < 100 and (r - b) > 70:
                hits += 1
    return hits / total


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"endcard_start_sec": None, "scanned": 0}))
        return
    video = sys.argv[1]
    duration = float(sys.argv[2])
    window = float(sys.argv[3]) if len(sys.argv) > 3 else 35.0
    if not os.path.exists(video) or duration <= 0:
        print(json.dumps({"endcard_start_sec": None, "scanned": 0}))
        return
    start = max(0.0, duration - window)
    step = 1.5
    scanned = 0
    samples = []  # (t, is_yellow)
    with tempfile.TemporaryDirectory() as tmp:
        t = start
        while t < duration - 0.2:
            out = os.path.join(tmp, "f.png")
            probe = subprocess.run(
                [FFMPEG, "-y", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", video,
                 "-frames:v", "1", "-vf", "scale=480:-1", out],
                capture_output=True, timeout=60)
            scanned += 1
            ratio = 0.0
            if probe.returncode == 0 and os.path.exists(out):
                try:
                    ratio = yellow_ratio(Image.open(out))
                except Exception:
                    ratio = 0.0
            samples.append((round(t, 2), ratio >= 0.04))
            t += step
    # An end card, once it appears, STAYS to the end of the clip - a yellow prop in the film
    # (John Wick's lamps, a taxi) is momentary. Find the earliest sample from which the rest of
    # the clip is yellow at least 70% of the time AND at least 3 samples remain to confirm it.
    endcard_start = None
    n = len(samples)
    for i in range(n):
        if not samples[i][1]:
            continue
        rest = samples[i:]
        if len(rest) < 3:
            break
        yellow_frac = sum(1 for _, y in rest if y) / len(rest)
        if yellow_frac >= 0.7:
            endcard_start = samples[i][0]
            break
    print(json.dumps({"endcard_start_sec": endcard_start, "scanned": scanned}))


if __name__ == "__main__":
    main()
