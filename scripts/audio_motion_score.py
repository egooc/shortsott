"""Per-second audio/motion excitement profile for a video, ffmpeg + numpy only.

Standalone research helper (P1 of docs/opensource-adoption-analysis-2026-08-08.md).
Reimplemented from the AutoShorts algorithm spec (MIT, divyaprakash0426/autoshorts)
without its torch/decord/CUDA stack; the sliding-window argmax follows the same
cumsum approach as its `_best_window_single`. Not wired into any production path.

Signals
  audio  : 0.4 * RMS + 0.6 * half-wave-rectified spectral flux (z-scored, box-smoothed).
           Flux-forward on purpose: process/manufacturing sources signal events by
           spectral change (impacts, tool changes, servo pitch), not loudness.
  motion : mean absolute inter-frame difference of 6 fps / 256px grayscale frames.
  excitement : 0.6 * audio + 0.4 * motion, resampled to 1 Hz.

Usage
  python scripts/audio_motion_score.py <video> [--json OUT] [--windows N]
         [--window-sec S] [--w-rms 0.4] [--w-flux 0.6] [--w-audio 0.6] [--w-motion 0.4]

Output JSON
  { "duration_sec": float, "fps": 1,
    "audio": [...], "motion": [...], "excitement": [...],   # one value per second
    "top_windows": [{"start_sec", "end_sec", "score"}] }
"""

import argparse
import json
import subprocess
import sys

import numpy as np

AUDIO_SR = 16000
FRAME = 2048
HOP = 512
AUDIO_SMOOTH_SEC = 0.22
MOTION_FPS = 6
MOTION_WIDTH = 256
MOTION_SMOOTH_SEC = 1.0


def run_ffprobe(video_path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height:format=duration",
         "-of", "json", video_path],
        capture_output=True, text=True, encoding="utf-8", errors="replace", check=True, timeout=60
    ).stdout
    info = json.loads(out)
    stream = (info.get("streams") or [{}])[0]
    duration = float(info.get("format", {}).get("duration") or 0.0)
    return int(stream.get("width") or 0), int(stream.get("height") or 0), duration


def decode_audio(video_path):
    """Mono 16 kHz float32 in [-1, 1]. Empty array when the source has no audio."""
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-i", video_path, "-vn",
         "-ac", "1", "-ar", str(AUDIO_SR), "-f", "s16le", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=900
    )
    if not proc.stdout:
        return np.zeros(0, dtype=np.float32)
    return np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def decode_motion_frames(video_path, src_w, src_h):
    """6 fps grayscale frames at 256px wide. Returns (frames[N,h,w], fps)."""
    height = int(round(MOTION_WIDTH * src_h / max(1, src_w) / 2)) * 2 or 144
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-i", video_path,
         "-vf", f"fps={MOTION_FPS},scale={MOTION_WIDTH}:{height}",
         "-pix_fmt", "gray", "-f", "rawvideo", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=900
    )
    frame_bytes = MOTION_WIDTH * height
    n = len(proc.stdout) // frame_bytes
    if n == 0:
        return np.zeros((0, height, MOTION_WIDTH), dtype=np.uint8)
    return np.frombuffer(proc.stdout[: n * frame_bytes], dtype=np.uint8).reshape(
        n, height, MOTION_WIDTH
    )


def frame_view(samples, frame, hop):
    n = 1 + (len(samples) - frame) // hop if len(samples) >= frame else 0
    if n <= 0:
        return np.zeros((0, frame), dtype=np.float32)
    strided = np.lib.stride_tricks.sliding_window_view(samples, frame)[::hop]
    return strided[:n]


def zscore(x):
    if x.size == 0:
        return x
    return (x - x.mean()) / (x.std() + 1e-8)


def box_smooth(x, win):
    win = max(1, int(win))
    if win % 2 == 0:
        win += 1
    if x.size == 0 or win == 1:
        return x
    kernel = np.ones(win, dtype=np.float64) / win
    return np.convolve(x, kernel, mode="same")


def audio_profile(samples, w_rms, w_flux):
    """Returns (times, score) at the analysis frame rate (~31.25 Hz)."""
    frames = frame_view(samples, FRAME, HOP)
    if frames.shape[0] < 2:
        return np.zeros(0), np.zeros(0)
    window = np.hanning(FRAME).astype(np.float32)

    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))

    spectra = np.abs(np.fft.rfft(frames * window, axis=1))
    diff = np.diff(spectra, axis=0)
    # Half-wave rectified: onsets only, so the flux is an onset-strength signal
    # instead of a symmetric change detector.
    flux = np.sqrt(np.sum(np.maximum(diff, 0.0) ** 2, axis=1))
    flux = np.concatenate([[0.0], flux])

    frame_rate = AUDIO_SR / HOP
    smooth_win = AUDIO_SMOOTH_SEC * frame_rate
    score = w_rms * box_smooth(zscore(rms), smooth_win) + w_flux * box_smooth(
        zscore(flux), smooth_win
    )
    times = np.arange(len(score)) * HOP / AUDIO_SR
    return times, score


def motion_profile(frames):
    """Returns (times, score) at MOTION_FPS."""
    if frames.shape[0] < 2:
        return np.zeros(0), np.zeros(0)
    diffs = np.abs(np.diff(frames.astype(np.int16), axis=0)).mean(axis=(1, 2))
    diffs = np.concatenate([[0.0], diffs])
    score = box_smooth(zscore(diffs), MOTION_SMOOTH_SEC * MOTION_FPS)
    times = np.arange(len(score)) / MOTION_FPS
    return times, score


def resample_1hz(times, score, duration):
    seconds = np.arange(0, max(1, int(np.ceil(duration))))
    if times.size == 0:
        return np.zeros(len(seconds))
    # Mean per 1s bin; empty bins fall back to interpolation.
    bins = np.floor(times).astype(int)
    out = np.full(len(seconds), np.nan)
    for sec in np.unique(bins):
        if 0 <= sec < len(seconds):
            out[sec] = score[bins == sec].mean()
    missing = np.isnan(out)
    if missing.any():
        out[missing] = np.interp(seconds[missing], times, score)
    return out


def top_windows(excitement, window_sec, count):
    """Cumsum sliding-window argmax, greedily suppressing overlaps."""
    n = len(excitement)
    window = max(1, min(int(window_sec), n))
    cumsum = np.concatenate([[0.0], np.cumsum(excitement)])
    sums = cumsum[window:] - cumsum[:-window]
    taken = np.zeros(n, dtype=bool)
    results = []
    order = np.argsort(sums)[::-1]
    for start in order:
        if len(results) >= count:
            break
        if taken[start : start + window].any():
            continue
        taken[start : start + window] = True
        results.append(
            {
                "start_sec": int(start),
                "end_sec": int(start + window),
                "score": round(float(sums[start] / window), 4),
            }
        )
    return sorted(results, key=lambda w: w["start_sec"])


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("video")
    parser.add_argument("--json", dest="json_out", default="")
    parser.add_argument("--windows", type=int, default=5)
    parser.add_argument("--window-sec", type=float, default=10.0)
    parser.add_argument("--w-rms", type=float, default=0.4)
    parser.add_argument("--w-flux", type=float, default=0.6)
    parser.add_argument("--w-audio", type=float, default=0.6)
    parser.add_argument("--w-motion", type=float, default=0.4)
    args = parser.parse_args()

    src_w, src_h, duration = run_ffprobe(args.video)

    audio_times, audio_score = audio_profile(
        decode_audio(args.video), args.w_rms, args.w_flux
    )
    motion_times, motion_score = motion_profile(
        decode_motion_frames(args.video, src_w, src_h)
    )
    if duration <= 0:
        duration = max(
            audio_times[-1] if audio_times.size else 0.0,
            motion_times[-1] if motion_times.size else 0.0,
        )

    audio_1hz = resample_1hz(audio_times, audio_score, duration)
    motion_1hz = resample_1hz(motion_times, motion_score, duration)

    has_audio = audio_times.size > 0
    has_motion = motion_times.size > 0
    if has_audio and has_motion:
        excitement = args.w_audio * audio_1hz + args.w_motion * motion_1hz
    else:
        # A missing signal is absent, not zero: don't drag the other one down.
        excitement = audio_1hz if has_audio else motion_1hz

    result = {
        "video": args.video,
        "duration_sec": round(float(duration), 3),
        "fps": 1,
        "has_audio": bool(has_audio),
        "has_motion": bool(has_motion),
        "weights": {
            "rms": args.w_rms,
            "flux": args.w_flux,
            "audio": args.w_audio,
            "motion": args.w_motion,
        },
        "audio": [round(float(v), 4) for v in audio_1hz],
        "motion": [round(float(v), 4) for v in motion_1hz],
        "excitement": [round(float(v), 4) for v in excitement],
        "top_windows": top_windows(excitement, args.window_sec, args.windows),
    }

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
