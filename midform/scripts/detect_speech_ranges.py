"""Speech ranges from a real VAD, and how far the pipeline's energy detector disagrees.

The trim that decides where a dialogue clip may start and stop runs on ffmpeg `silencedetect` - an
energy threshold. On a movie mix that is a proxy, not a speech detector: a music bed reads as
"speech" and a quiet delivery reads as silence, and the clip boundary moves accordingly. silero-vad
answers the actual question (is someone speaking here), so this script produces its ranges and, with
--compare, measures where the two disagree so the gap is visible instead of assumed.

    python midform/scripts/detect_speech_ranges.py --audio source.mp4 --out speech_ranges.json \
           [--compare] [--noise-floor -26]

Exits 3 when silero-vad is missing so callers can keep the existing behaviour.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

SAMPLE_RATE = 16000


def log(message):
    print(message, file=sys.stderr, flush=True)


def read_wav_mono(path):
    import wave

    import numpy as np
    import torch

    with wave.open(path, "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        frames = handle.readframes(handle.getnframes())
    if width != 2:
        raise RuntimeError(f"expected 16-bit PCM, got {width * 8}-bit")
    samples = np.frombuffer(frames, dtype="<i2").astype("float32") / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return torch.from_numpy(samples.copy())


def extract_audio(source_path):
    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    cmd = [os.environ.get("FFMPEG_PATH", "ffmpeg"), "-v", "error", "-y",
           "-i", source_path, "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), wav_path]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not os.path.exists(wav_path):
        raise RuntimeError(f"ffmpeg could not extract audio: {result.stderr[:300]}")
    return wav_path


def silencedetect_speech(source_path, noise_floor_db):
    """Reproduce what the pipeline does today: silence below a relative floor, speech elsewhere."""
    ffmpeg = os.environ.get("FFMPEG_PATH", "ffmpeg")
    probe = subprocess.run(
        [ffmpeg, "-hide_banner", "-nostats", "-y", "-i", source_path, "-vn", "-af", "volumedetect",
         "-f", "null", "-"], capture_output=True, text=True)
    mean = re.search(r"mean_volume:\s*(-?[\d.]+) dB", probe.stderr or "")
    floor = noise_floor_db
    if mean and noise_floor_db is None:
        floor = max(-40.0, min(-22.0, float(mean.group(1)) - 12.0))
    elif noise_floor_db is None:
        floor = -26.0

    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-nostats", "-y", "-i", source_path, "-vn",
         "-af", f"silencedetect=noise={floor}dB:d=0.20", "-f", "null", "-"],
        capture_output=True, text=True)
    silences = []
    start = None
    for line in (result.stderr or "").splitlines():
        begin = re.search(r"silence_start:\s*(-?[\d.]+)", line)
        end = re.search(r"silence_end:\s*(-?[\d.]+)", line)
        if begin:
            start = float(begin.group(1))
        elif end and start is not None:
            silences.append((start, float(end.group(1))))
            start = None
    return silences, floor


def invert(spans, total):
    """Silence spans -> speech spans."""
    speech = []
    cursor = 0.0
    for begin, end in sorted(spans):
        if begin > cursor:
            speech.append((round(cursor, 3), round(begin, 3)))
        cursor = max(cursor, end)
    if cursor < total:
        speech.append((round(cursor, 3), round(total, 3)))
    return speech


def coverage(spans, begin, end):
    total = 0.0
    for start, stop in spans:
        if stop <= begin:
            continue
        if start >= end:
            break
        total += min(end, stop) - max(begin, start)
    return total


def main():
    parser = argparse.ArgumentParser(description="silero-vad speech ranges (+ energy-detector delta)")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--compare", action="store_true", help="also report the energy detector's delta")
    parser.add_argument("--noise-floor", type=float, default=None)
    args = parser.parse_args()

    try:
        from silero_vad import get_speech_timestamps, load_silero_vad
    except ImportError:
        print("silero-vad is not installed (pip install silero-vad)", file=sys.stderr)
        sys.exit(3)

    wav_path = args.audio
    temp_wav = None
    if not args.audio.lower().endswith(".wav"):
        temp_wav = extract_audio(args.audio)
        wav_path = temp_wav

    try:
        model = load_silero_vad()
        # silero's own read_audio goes through torchaudio, which now demands TorchCodec; the wav is
        # already 16k mono at this point, so read the PCM directly.
        wav = read_wav_mono(wav_path)
        stamps = get_speech_timestamps(wav, model, sampling_rate=SAMPLE_RATE, return_seconds=True)
        vad = [(round(float(s["start"]), 3), round(float(s["end"]), 3)) for s in stamps]
        total = len(wav) / SAMPLE_RATE
        payload = {
            "audio": os.path.basename(args.audio),
            "detector": "silero-vad",
            "duration_sec": round(total, 3),
            "speech_sec": round(sum(e - s for s, e in vad), 3),
            "ranges": vad,
        }

        if args.compare:
            silences, floor = silencedetect_speech(args.audio, args.noise_floor)
            energy = invert(silences, total)
            # Where each detector hears speech the other does not. The energy detector calling music
            # "speech" is what lets a clip boundary sit on a score instead of a voice.
            energy_only = sum(max(0.0, (stop - start) - coverage(vad, start, stop)) for start, stop in energy)
            vad_only = sum(max(0.0, (stop - start) - coverage(energy, start, stop)) for start, stop in vad)
            payload["energy_detector"] = {
                "noise_floor_db": floor,
                "speech_sec": round(sum(e - s for s, e in energy), 3),
                "energy_only_sec": round(energy_only, 3),
                "vad_only_sec": round(vad_only, 3),
                "ranges": energy,
            }
            log(f"silero speech {payload['speech_sec']}s vs energy {payload['energy_detector']['speech_sec']}s "
                f"(energy-only {round(energy_only, 1)}s, vad-only {round(vad_only, 1)}s)")

        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=1)
        log(f"{len(vad)} speech ranges -> {args.out}")
    finally:
        if temp_wav and os.path.exists(temp_wav):
            os.remove(temp_wav)


if __name__ == "__main__":
    main()
