"""Neural shot-boundary detection (TransNetV2) as a standalone JSON CLI.

Standalone research helper (P1 of docs/opensource-adoption-analysis-2026-08-08.md).
Adapted from openshorts scene_detection.py (MIT License, github.com/mutonby/openshorts,
Copyright (c) mutonby) — the TransNetV2 decode/predict/merge flow and its two
correctness details (inclusive->exclusive scene ends, short-scene merge) are kept;
the reframe-pipeline coupling (cv2 probing, PySceneDetect FrameTimecode output,
threading lock) is replaced with ffprobe + plain JSON so the script runs on its own.
Not wired into any production path.

Why TransNetV2 for this product: threshold detectors (ContentDetector-style) miss
cuts in evenly lit, slowly moving process/manufacturing footage; a learned detector
on 48x27 frames is faster than realtime on CPU and catches gradual transitions.

Usage
  python scripts/scene_detect_transnet.py <video> [--json OUT]
         [--threshold 0.5] [--min-scene-sec 0.4] [--device auto|cpu|cuda]

Output JSON
  { "engine": "transnetv2", "fps": float, "frame_count": int,
    "scenes": [{"start_frame", "end_frame", "start_sec", "end_sec", "duration_sec"}] }

Dependencies: pip install torch transnetv2-pytorch  (CPU build is enough).
The transnetv2-pytorch package carries the model weights under its own license —
verified separately from this repo (see the adoption analysis doc).
"""

import argparse
import json
import subprocess
import sys

import numpy as np

# TransNetV2 input size (width x height), fixed by the trained model.
TN2_W, TN2_H = 48, 27

_tn2_model = None


def get_model(device):
    global _tn2_model
    if _tn2_model is None:
        from transnetv2_pytorch import TransNetV2

        model = TransNetV2(device=device)
        model.eval()
        _tn2_model = model
    return _tn2_model


def probe_fps(video_path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=avg_frame_rate",
         "-of", "default=noprint_wrappers=1:nokey=1", video_path],
        capture_output=True, text=True, encoding="utf-8", errors="replace", check=True, timeout=60
    ).stdout.strip()
    try:
        num, den = out.split("/")
        fps = float(num) / float(den or 1)
    except ValueError:
        fps = float(out or 0)
    return fps if fps > 0 else 30.0


def extract_frames_small(video_path):
    """Decode the whole clip as 48x27 RGB frames via ffmpeg (~4KB/frame)."""
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-i", video_path,
         "-vf", f"scale={TN2_W}:{TN2_H}",
         "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True, timeout=900
    )
    frame_bytes = TN2_H * TN2_W * 3
    n = len(proc.stdout) // frame_bytes
    if n == 0:
        raise RuntimeError("ffmpeg produced no frames")
    return np.frombuffer(
        proc.stdout[: n * frame_bytes], dtype=np.uint8
    ).reshape(n, TN2_H, TN2_W, 3)


def merge_short_scenes(bounds, fps, min_sec):
    """Absorb scenes shorter than min_sec into a neighbor. Ultra-short scenes
    cause camera-snap bursts downstream and starve per-scene sampling."""
    if len(bounds) <= 1 or min_sec <= 0:
        return bounds
    min_frames = max(1, int(round(min_sec * float(fps))))

    merged = []
    for s, e in bounds:
        if merged and (e - s) < min_frames:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    # The first scene can still be short — fold it into the one after it.
    if len(merged) > 1 and (merged[0][1] - merged[0][0]) < min_frames:
        merged[1] = (merged[0][0], merged[1][1])
        merged.pop(0)
    return merged


def detect(video_path, threshold, min_scene_sec, device):
    import torch

    fps = probe_fps(video_path)
    frames = extract_frames_small(video_path)
    model = get_model(device)

    with torch.no_grad():
        tensor = torch.from_numpy(np.ascontiguousarray(frames)).to(model.device)
        single_frame_pred, _ = model.predict_frames(tensor, quiet=True)

    # predictions_to_scenes returns [[start, end], ...] with INCLUSIVE ends;
    # convert to exclusive ends so ranges tile the video without overlap.
    raw = model.predictions_to_scenes(single_frame_pred.numpy(), threshold=threshold)
    bounds = [(int(s), int(e) + 1) for s, e in raw]
    if bounds and len(frames) > bounds[-1][1]:
        bounds[-1] = (bounds[-1][0], len(frames))

    bounds = merge_short_scenes(bounds, fps, min_scene_sec)
    return bounds, fps, len(frames)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("video")
    parser.add_argument("--json", dest="json_out", default="")
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--min-scene-sec", type=float, default=0.4)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    try:
        bounds, fps, frame_count = detect(
            args.video, args.threshold, args.min_scene_sec, args.device
        )
    except ImportError as error:
        print(json.dumps({
            "error": "missing_dependency",
            "message": f"{error}. Install with: pip install torch transnetv2-pytorch",
        }, ensure_ascii=False))
        return 2

    result = {
        "video": args.video,
        "engine": "transnetv2",
        "threshold": args.threshold,
        "min_scene_sec": args.min_scene_sec,
        "fps": round(float(fps), 4),
        "frame_count": frame_count,
        "scenes": [
            {
                "start_frame": s,
                "end_frame": e,
                "start_sec": round(s / fps, 3),
                "end_sec": round(e / fps, 3),
                "duration_sec": round((e - s) / fps, 3),
            }
            for s, e in bounds
        ],
    }

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        print(f"wrote {args.json_out} ({len(result['scenes'])} scenes)")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
