# -*- coding: utf-8 -*-
"""Shared ASR backend: Groq whisper-large-v3 when GROQ_API_KEY is present, local
faster-whisper otherwise.

Why Groq first: the local CPU path costs 8-13 minutes per source and the word grid was
being built with the *base* model; Groq runs large-v3 in tens of seconds for ~$0.04/hr
of audio (owner decision 2026-08-26 - Groq only, no Speechmatics key, to avoid the
expensive-provider-first billing trap). The fallback must be LOUD (casebook 31): every
result carries a "backend" field and the fallback prints to stderr.

The key is read from the environment, then from D:\\midform\\.env - these scripts often
run standalone where dotenv never loaded.
"""
import io
import json
import os
import subprocess
import sys
import tempfile
import urllib.request

GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_MODEL = "whisper-large-v3"
_FFMPEG = None


def _ffmpeg():
    global _FFMPEG
    if _FFMPEG:
        return _FFMPEG
    for cand in [
        os.environ.get("FFMPEG_PATH", ""),
        r"C:\Users\urban\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\ffmpeg.exe",
        "ffmpeg",
    ]:
        if cand and (os.path.sep not in cand or os.path.exists(cand)):
            _FFMPEG = cand
            return cand
    return "ffmpeg"


def groq_api_key():
    key = os.environ.get("GROQ_API_KEY", "").strip()
    if key:
        return key
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".env")
    try:
        for line in io.open(env_path, encoding="utf-8"):
            line = line.strip()
            if line.startswith("GROQ_API_KEY="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


def _compress_audio(audio_path, start=None, end=None):
    """Opus mono keeps a 30-minute source near 3MB - far under Groq's 25MB cap."""
    tmp = tempfile.NamedTemporaryFile(suffix=".ogg", delete=False)
    tmp.close()
    cmd = [_ffmpeg(), "-y", "-v", "error"]
    if start is not None:
        cmd += ["-ss", str(start)]
    if end is not None:
        cmd += ["-to", str(end)]
    cmd += ["-i", audio_path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "16k", tmp.name]
    subprocess.run(cmd, check=True)
    return tmp.name


def _multipart(fields, file_field, file_name, file_bytes):
    boundary = "----midformasr7f3a"
    out = io.BytesIO()
    for name, value in fields.items():
        out.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
    out.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"{file_name}\"\r\nContent-Type: audio/ogg\r\n\r\n".encode())
    out.write(file_bytes)
    out.write(f"\r\n--{boundary}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


def transcribe_groq(audio_path, language="en", start=None, end=None):
    """Returns {"backend": "groq", "language", "words": [...], "segments": [...]} or raises."""
    key = groq_api_key()
    if not key:
        raise RuntimeError("no GROQ_API_KEY")
    ogg = _compress_audio(audio_path, start=start, end=end)
    try:
        body, ctype = _multipart(
            {
                "model": GROQ_MODEL,
                "response_format": "verbose_json",
                "timestamp_granularities[]": "word",
                **({"language": language} if language else {}),
            },
            "file", "audio.ogg", open(ogg, "rb").read(),
        )
        req = urllib.request.Request(GROQ_URL, data=body, method="POST")
        req.add_header("Authorization", f"Bearer {key}")
        req.add_header("Content-Type", ctype)
        # Cloudflare fronts the API and 403s urllib's default Python-urllib UA.
        req.add_header("User-Agent", "midform-asr/1.0")
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    finally:
        try:
            os.unlink(ogg)
        except OSError:
            pass
    offset = float(start or 0.0)
    words = [
        {"word": str(w.get("word", "")).strip(), "start": round(float(w["start"]) + offset, 3),
         "end": round(float(w["end"]) + offset, 3), "probability": 1.0}
        for w in data.get("words") or []
    ]
    segments = [
        {"start": round(float(s["start"]) + offset, 3), "end": round(float(s["end"]) + offset, 3),
         "text": str(s.get("text", "")).strip(),
         "no_speech_prob": s.get("no_speech_prob"), "avg_logprob": s.get("avg_logprob")}
        for s in data.get("segments") or []
    ]
    return {"backend": "groq", "language": data.get("language") or language, "words": words, "segments": segments}


def transcribe_local(audio_path, language="en", model_size="medium", vad_filter=True, start=None, end=None):
    from faster_whisper import WhisperModel  # ImportError propagates: caller decides
    src = audio_path
    tmp = None
    if start is not None or end is not None:
        tmp = _compress_audio(audio_path, start=start, end=end)
        src = tmp
    try:
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments, info = model.transcribe(src, language=language or None, word_timestamps=True, vad_filter=vad_filter)
        offset = float(start or 0.0) if tmp else 0.0
        words, segs = [], []
        for seg in segments:
            segs.append({"start": round(seg.start + offset, 3), "end": round(seg.end + offset, 3),
                         "text": (seg.text or "").strip(),
                         "no_speech_prob": seg.no_speech_prob, "avg_logprob": seg.avg_logprob})
            for w in seg.words or []:
                words.append({"word": w.word.strip(), "start": round(w.start + offset, 3),
                              "end": round(w.end + offset, 3), "probability": round(w.probability, 3)})
        return {"backend": f"local-{model_size}", "language": info.language, "words": words, "segments": segs}
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass


def transcribe(audio_path, language="en", model_size="medium", start=None, end=None):
    """Groq when a key exists, local otherwise - and say which one ran."""
    if groq_api_key():
        try:
            return transcribe_groq(audio_path, language=language, start=start, end=end)
        except Exception as error:  # noqa: BLE001 - fall back, loudly
            print(f"[asr] groq failed ({error}); falling back to local faster-whisper", file=sys.stderr)
    else:
        print("[asr] no GROQ_API_KEY - using local faster-whisper (slower, smaller model)", file=sys.stderr)
    return transcribe_local(audio_path, language=language, model_size=model_size)
