"""Local source-eligibility signals for one video: speech, faces, motion.

Research helper for docs/source-eligibility-spec-2026-08-10.md (Stage A).
Standalone, JSON in/out, never wired into production paths. Every neural
inference touches only sampled frames/chunks, so cost is bounded regardless
of source length (the TransNetV2 lesson).

Signals
  speech_ratio   : Silero VAD (MIT, ONNX) over the full 16kHz mono track -
                   speech seconds / duration. Talking-head sources score high;
                   machine-noise process sources score near zero.
  face_any_ratio : YuNet (MIT) on N sampled frames - share of frames with any
                   face covering >=1%% of the frame.
  face_dom_ratio : share of frames with a dominant face (>=6%% of the frame).
  motion_energy  : mean abs gray frame diff (0.33s apart) at N sample points,
                   on 256px frames; static_ratio = share of points below
                   STATIC_THRESHOLD.

Usage
  python scripts/source_eligibility_probe.py <video> [--json OUT]
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import wave

import cv2
import numpy as np
import torch
from silero_vad import get_speech_timestamps, load_silero_vad

SAMPLE_FRAMES = 30
MOTION_POINTS = 12
MOTION_GAP_SEC = 0.33
STATIC_THRESHOLD = 1.5     # mean abs gray diff on 0..255 scale, 256px frames
FACE_ANY_AREA = 0.01
FACE_DOMINANT_AREA = 0.06
YUNET_MODEL = os.path.join(os.path.dirname(__file__), "..", "tools", "models",
                           "face_detection_yunet_2023mar.onnx")


def probe_duration(video_path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", video_path],
        capture_output=True, text=True, check=True, timeout=60).stdout
    return float(out.strip())


def speech_ratio(video_path, duration):
    # onnx=True loads in ~2s vs ~18s for the torch JIT model.
    model = load_silero_vad(onnx=True)
    with tempfile.TemporaryDirectory() as tmp_dir:
        wav_path = os.path.join(tmp_dir, "audio.wav")
        extract = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", video_path,
             "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav_path],
            capture_output=True, timeout=600)
        if extract.returncode != 0 or not os.path.exists(wav_path):
            return None  # no audio track
        with wave.open(wav_path, "rb") as wav:
            raw = wav.readframes(wav.getnframes())
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    segments = get_speech_timestamps(
        torch.from_numpy(audio), model, sampling_rate=16000, return_seconds=True)
    speech_sec = sum(seg["end"] - seg["start"] for seg in segments)
    return round(speech_sec / max(duration, 0.1), 4)


def sample_times(duration, count, margin=0.02):
    lo, hi = duration * margin, duration * (1 - margin)
    return [lo + (hi - lo) * i / max(count - 1, 1) for i in range(count)]


# cv2.VideoCapture seeking decodes from a keyframe in software and took 6-22s
# PER SEEK on these high-bitrate sources; ffmpeg -ss input seeking is ~0.3s.
def grab_frame_ffmpeg(video_path, t_sec, width=640):
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{t_sec:.3f}",
         "-i", video_path, "-frames:v", "1", "-vf", f"scale={width}:-2",
         "-f", "image2pipe", "-vcodec", "bmp", "-"],
        capture_output=True, timeout=60)
    if out.returncode != 0 or not out.stdout:
        return None
    frame = cv2.imdecode(np.frombuffer(out.stdout, dtype=np.uint8), cv2.IMREAD_COLOR)
    return frame


def grab_gray_burst(video_path, t_sec, span_sec=0.5, fps=6, width=256):
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{t_sec:.3f}",
         "-t", f"{span_sec:.3f}", "-i", video_path,
         "-vf", f"fps={fps},scale={width}:-2,format=gray",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True, timeout=60)
    if out.returncode != 0 or not out.stdout:
        return None
    probe = grab_frame_ffmpeg.frame_shape.get(video_path)
    if probe is None:
        first = grab_frame_ffmpeg(video_path, t_sec, width=width)
        if first is None:
            return None
        probe = (first.shape[0], first.shape[1])
        grab_frame_ffmpeg.frame_shape[video_path] = probe
    height, width_px = probe
    frame_bytes = height * width_px
    count = len(out.stdout) // frame_bytes
    if count < 2:
        return None
    frames = np.frombuffer(out.stdout[:count * frame_bytes], dtype=np.uint8)
    return frames.reshape(count, height, width_px).astype(np.float32)


grab_frame_ffmpeg.frame_shape = {}


def face_ratios(video_path, duration):
    detector = cv2.FaceDetectorYN.create(os.path.abspath(YUNET_MODEL), "", (320, 320))
    any_hits, dom_hits, checked = 0, 0, 0
    for t in sample_times(duration, SAMPLE_FRAMES):
        frame = grab_frame_ffmpeg(video_path, t)
        if frame is None:
            continue
        height, width = frame.shape[:2]
        detector.setInputSize((width, height))
        _, faces = detector.detect(frame)
        checked += 1
        if faces is None or not len(faces):
            continue
        max_area = max((f[2] * f[3]) / float(width * height) for f in faces)
        if max_area >= FACE_ANY_AREA:
            any_hits += 1
        if max_area >= FACE_DOMINANT_AREA:
            dom_hits += 1
    if not checked:
        return None, None
    return round(any_hits / checked, 4), round(dom_hits / checked, 4)


def motion_profile(video_path, duration):
    energies = []
    for t in sample_times(duration, MOTION_POINTS):
        burst = grab_gray_burst(video_path, t)
        if burst is None:
            continue
        energies.append(float(np.abs(burst[-1] - burst[0]).mean()))
    if not energies:
        return None
    return {
        "motion_mean": round(float(np.mean(energies)), 3),
        "motion_median": round(float(np.median(energies)), 3),
        "static_ratio": round(sum(1 for e in energies if e < STATIC_THRESHOLD) / len(energies), 4),
        "samples": [round(e, 2) for e in energies],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video")
    parser.add_argument("--json", dest="json_out")
    args = parser.parse_args()

    duration = probe_duration(args.video)
    result = {"video": args.video, "duration_sec": round(duration, 2)}
    result["speech_ratio"] = speech_ratio(args.video, duration)
    face_any, face_dom = face_ratios(args.video, duration)
    result["face_any_ratio"] = face_any
    result["face_dominant_ratio"] = face_dom
    motion = motion_profile(args.video, duration)
    result.update(motion or {"motion_mean": None, "static_ratio": None})
    result.pop("samples", None) if args.json_out is None else None

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
