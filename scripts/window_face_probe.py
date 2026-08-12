"""Per-window talking-scene probe for full-draft candidate windows.

The source-level eligibility gate passes process documentaries whose OVERALL
speech/face ratios are low, but individual candidate windows can still be
interview shots. Face detection alone is not enough: the shipped
pressure-cooker interview cut (2026-08-12) had a MASKED face that YuNet
scores 0 detections on. Speech is the reliable signal - an interview window
is someone talking - so each window is probed two ways:

  - speech_ratio: Silero VAD over the window's audio (extracted via ffmpeg)
  - dominant_ratio: share of sampled frames whose largest YuNet face exceeds
    the dominant threshold (catches silent close-up faces)

Usage:
  python scripts/window_face_probe.py --video <path> --windows '[{"start_sec":1,"end_sec":9}, ...]'

Output (stdout JSON, last line): {"windows": [{"start_sec":..., "end_sec":...,
"dominant_ratio":0.0-1.0|null, "speech_ratio":0.0-1.0|null}, ...]}
Fail-open: per-signal errors yield null for that signal.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import wave

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import cv2
import numpy as np

YUNET_MODEL = os.path.join(os.path.dirname(__file__), "..", "tools", "models", "face_detection_yunet_2023mar.onnx")
FACE_DOMINANT_AREA = 0.08  # largest face covering >=8% of the frame reads as a talking-head shot
FRAMES_PER_WINDOW = 8


def grab_frame_ffmpeg(video_path, t):
    try:
        out = subprocess.run(
            ["ffmpeg", "-ss", f"{t:.2f}", "-i", video_path, "-frames:v", "1",
             "-f", "image2pipe", "-vcodec", "png", "-loglevel", "error", "-"],
            capture_output=True, timeout=30,
        )
        if not out.stdout:
            return None
        return cv2.imdecode(np.frombuffer(out.stdout, np.uint8), cv2.IMREAD_COLOR)
    except Exception:
        return None


def probe_faces(detector, video_path, start_sec, end_sec):
    span = max(0.2, end_sec - start_sec)
    times = [start_sec + span * (i + 1) / (FRAMES_PER_WINDOW + 1) for i in range(FRAMES_PER_WINDOW)]
    checked, dominant = 0, 0
    for t in times:
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
        if max_area >= FACE_DOMINANT_AREA:
            dominant += 1
    if not checked:
        return None
    return round(dominant / checked, 4)


def probe_motion(video_path, start_sec, end_sec):
    """Mean |frame delta| at three points in the window. Interview shots are
    near-static (a person standing talking, ~9 on the shipped example);
    machine process shots run 20-40 even with narration over them."""
    span = max(0.6, end_sec - start_sec)
    energies = []
    for fraction in (0.25, 0.5, 0.75):
        t = start_sec + span * fraction
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{t:.2f}", "-t", "0.5",
             "-i", video_path, "-vf", "fps=6,scale=256:-2,format=gray",
             "-f", "rawvideo", "-pix_fmt", "gray", "-"],
            capture_output=True, timeout=60,
        )
        if not out.stdout:
            continue
        if probe_motion.frame_shape is None:
            frame = grab_frame_ffmpeg(video_path, t)
            if frame is None:
                continue
            height = int(round(256 * frame.shape[0] / frame.shape[1] / 2) * 2)
            probe_motion.frame_shape = (height, 256)
        height, width = probe_motion.frame_shape
        frame_bytes = height * width
        count = len(out.stdout) // frame_bytes
        if count < 2:
            continue
        frames = np.frombuffer(out.stdout[:count * frame_bytes], dtype=np.uint8).reshape(count, height, width).astype(np.float32)
        energies.append(float(np.abs(frames[-1] - frames[0]).mean()))
    if not energies:
        return None
    return round(float(np.mean(energies)), 3)


probe_motion.frame_shape = None


def probe_speech(vad_model, get_speech_timestamps, torch, video_path, start_sec, end_sec):
    span = max(0.2, end_sec - start_sec)
    with tempfile.TemporaryDirectory() as tmp_dir:
        wav_path = os.path.join(tmp_dir, "window.wav")
        extract = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error",
             "-ss", f"{start_sec:.3f}", "-t", f"{span:.3f}", "-i", video_path,
             "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav_path],
            capture_output=True, timeout=120,
        )
        if extract.returncode != 0 or not os.path.exists(wav_path):
            return None
        with wave.open(wav_path, "rb") as wav:
            raw = wav.readframes(wav.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if not len(audio):
        return None
    segments = get_speech_timestamps(torch.from_numpy(audio), vad_model, sampling_rate=16000, return_seconds=True)
    speech_sec = sum(seg["end"] - seg["start"] for seg in segments)
    return round(speech_sec / span, 4)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--windows", required=True, help="JSON array of {start_sec, end_sec}")
    args = parser.parse_args()
    windows = json.loads(args.windows)

    detector = None
    try:
        detector = cv2.FaceDetectorYN.create(os.path.abspath(YUNET_MODEL), "", (320, 320))
    except Exception:
        pass
    vad = None
    try:
        import torch
        from silero_vad import load_silero_vad, get_speech_timestamps
        vad = (load_silero_vad(onnx=True), get_speech_timestamps, torch)
    except Exception:
        pass

    results = []
    for window in windows:
        start_sec = float(window.get("start_sec") or 0)
        end_sec = float(window.get("end_sec") or 0)
        face_ratio = None
        speech = None
        if detector is not None:
            try:
                face_ratio = probe_faces(detector, args.video, start_sec, end_sec)
            except Exception:
                face_ratio = None
        if vad is not None:
            try:
                speech = probe_speech(vad[0], vad[1], vad[2], args.video, start_sec, end_sec)
            except Exception:
                speech = None
        try:
            motion = probe_motion(args.video, start_sec, end_sec)
        except Exception:
            motion = None
        results.append({
            "start_sec": start_sec,
            "end_sec": end_sec,
            "dominant_ratio": face_ratio,
            "speech_ratio": speech,
            "motion_mean": motion,
        })
    print(json.dumps({"windows": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
