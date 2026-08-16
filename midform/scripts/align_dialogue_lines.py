"""Forced-align each planned dialogue line to the source audio.

We already KNOW what every line says - the plan carries the text. What we do not know is when it is
spoken, and that is the one thing every timing bug in this pipeline has come down to. Asking an ASR
(YouTube's or whisper's) to tell us WHERE a line is means trusting it to hear the line correctly
first, and both have been caught mishearing it ("kill the trees" vs "revise it") or missing it
outright. Forced alignment answers only the timing question: given this audio and this exact
sentence, when is each word spoken - plus a confidence score for the answer itself, so a line that
is NOT in the searched window scores low instead of being force-fitted somewhere plausible.

Output feeds verify_dialogue_clips.js: per-word times let it prove a clip contains its own line,
catch a boundary that lands inside a word, and catch two clips replaying the same words.

    python midform/scripts/align_dialogue_lines.py --audio source.mp4 --plan edit_plan.json \
           --out alignment.json [--model MMS_FA|WAV2VEC2]

Exits 3 with a clear message when torch/torchaudio are missing, so callers can degrade instead of
failing the run.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

SAMPLE_RATE = 16000
# How far around the planned coordinate to search. A line the plan has badly misplaced still needs
# to be findable, but a window wide enough to contain a repeat of the same words invites the aligner
# to pick the wrong one.
SEARCH_BEFORE_SEC = 12.0
SEARCH_AFTER_SEC = 12.0
# The plan is presumed right until a distant match beats it by more than this margin.
NEAR_WINDOW_SEC = 3.0
FAR_OVERRIDE_MARGIN = 0.08


def log(message):
    print(message, file=sys.stderr, flush=True)


def extract_audio(source_path):
    """16k mono wav - what the alignment models expect."""
    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    cmd = [
        os.environ.get("FFMPEG_PATH", "ffmpeg"), "-v", "error", "-y",
        "-i", source_path, "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), wav_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not os.path.exists(wav_path):
        raise RuntimeError(f"ffmpeg could not extract audio: {result.stderr[:300]}")
    return wav_path


def read_wav(path, torch):
    """torchaudio.load now needs TorchCodec, which is not installed - read the PCM ourselves."""
    import wave

    import numpy as np

    with wave.open(path, "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
    if width != 2:
        raise RuntimeError(f"expected 16-bit PCM, got {width * 8}-bit")
    samples = np.frombuffer(frames, dtype="<i2").astype("float32") / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return torch.from_numpy(samples.copy()).unsqueeze(0), rate


ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
        "nineteen"]
TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]


def number_to_words(value):
    """Digits are dropped by the letter-only vocabulary, and dropping them can leave a line with two
    generic tokens that then match a later repeat ("30 million, Sonny." aligned onto the "30
    million." three seconds後). Spell them so the number carries its own weight."""
    if value < 20:
        return ONES[value]
    if value < 100:
        rest = value % 10
        return TENS[value // 10] + ("" if not rest else " " + ONES[rest])
    if value < 1000:
        rest = value % 100
        return ONES[value // 100] + " hundred" + ("" if not rest else " " + number_to_words(rest))
    for scale, name in ((1000000000, "billion"), (1000000, "million"), (1000, "thousand")):
        if value >= scale:
            rest = value % scale
            return number_to_words(value // scale) + " " + name + ("" if not rest else " " + number_to_words(rest))
    return ""


def normalize_tokens(text):
    """The alignment vocabulary is plain lowercase letters and the apostrophe."""
    cleaned = re.sub(r"&[a-z]+;", " ", str(text or "").lower())
    cleaned = re.sub(r"(\d),(\d{3})", r"\1\2", cleaned)
    cleaned = re.sub(r"\d+", lambda m: " " + number_to_words(int(m.group(0))) + " ", cleaned)
    cleaned = re.sub(r"[^a-z' ]+", " ", cleaned)
    return [t for t in cleaned.split() if t.strip("'")]


def collect_lines(plan):
    """Every rendered dialogue line, with the coordinate the plan currently believes."""
    out = []
    for item in plan.get("timeline") or []:
        for index, win in enumerate(item.get("dialogue_line_windows") or []):
            if not isinstance(win, dict):
                continue
            text = str(win.get("line") or "")
            tokens = normalize_tokens(text)
            if not tokens:
                continue
            hint_start = win.get("raw_start_sec")
            if hint_start is None:
                hint_start = win.get("start_sec")
            hint_end = win.get("raw_end_sec")
            if hint_end is None:
                hint_end = win.get("end_sec")
            out.append({
                "slot_id": item.get("slot_id"),
                "line_index": index + 1,
                "utt_id": f"{item.get('slot_id')}_L{index + 1:02d}",
                "line": text,
                "tokens": tokens,
                "matched": win.get("matched"),
                "hint_start_sec": float(hint_start) if isinstance(hint_start, (int, float)) else None,
                "hint_end_sec": float(hint_end) if isinstance(hint_end, (int, float)) else None,
            })
    return out


def load_aligner(model_name):
    import torch
    import torchaudio

    if model_name == "MMS_FA" and hasattr(torchaudio.pipelines, "MMS_FA"):
        bundle = torchaudio.pipelines.MMS_FA
        model = bundle.get_model()
        model.eval()
        # Use the bundle's own dictionary. Hand-mapping characters onto the label set produced spans
        # that silently drifted to the front of the search window - alignment always returns
        # SOMETHING, so a wrong vocabulary looks like a confident answer.
        dictionary = bundle.get_dict(star="*")
        return {"kind": "mms", "model": model, "dictionary": dictionary,
                "star_id": dictionary.get("*"), "torch": torch, "torchaudio": torchaudio,
                "sample_rate": bundle.sample_rate}

    bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    model = bundle.get_model()
    model.eval()
    labels = bundle.get_labels()
    dictionary = {c.lower(): i for i, c in enumerate(labels)}
    return {"kind": "w2v", "model": model, "dictionary": dictionary, "torch": torch,
            "torchaudio": torchaudio, "sample_rate": bundle.sample_rate}


def align_window(aligner, waveform, tokens):
    """Force-align `tokens` inside `waveform`; returns per-word spans in frames plus scores."""
    torch = aligner["torch"]
    torchaudio = aligner["torchaudio"]

    if aligner["kind"] == "mms":
        dictionary = aligner["dictionary"]
        star_id = aligner["star_id"]
        ids = []
        spans = []
        for word_index, token in enumerate(tokens):
            start = len(ids)
            for ch in token:
                if ch in dictionary:
                    ids.append(dictionary[ch])
            if len(ids) > start:
                spans.append((word_index, start, len(ids)))
        if not ids:
            return None

        with torch.inference_mode():
            emission, _ = aligner["model"](waveform)
            emission = torch.log_softmax(emission, dim=-1)
            # A <star> at each end absorbs audio that belongs to no token. Without it CTC has to
            # consume every token somewhere inside the window, so the opening words get scattered
            # backwards over whatever was said before the line ("we're"@441.2 for a line spoken at
            # 446.4) and the result still looks confident.
            if star_id is not None:
                star_dim = torch.zeros((emission.size(0), emission.size(1), 1), dtype=emission.dtype)
                emission = torch.cat((emission, star_dim), 2) if emission.size(2) <= star_id else emission
                targets = torch.tensor([[star_id] + ids + [star_id]], dtype=torch.int32)
                offset = 1
            else:
                targets = torch.tensor([ids], dtype=torch.int32)
                offset = 0
            aligned, scores = torchaudio.functional.forced_align(emission, targets, blank=0)

        token_spans = torchaudio.functional.merge_tokens(aligned[0], scores[0].exp())
        # merge_tokens drops blanks but keeps the stars; index by position in `targets`.
        real = [span for span in token_spans if span.token != star_id]
        if len(real) != len(ids):
            return None
        frames = emission.size(1)
        ratio = waveform.size(1) / frames
        words = []
        for word_index, id_start, id_end in spans:
            chunk = real[id_start:id_end]
            if not chunk:
                continue
            words.append({
                "start_frame": chunk[0].start,
                "end_frame": chunk[-1].end,
                "score": float(sum(t.score for t in chunk) / len(chunk)),
                "word_index": word_index,
            })
        del offset
        return {"words": words, "ratio": ratio} if words else None

    dictionary = aligner["dictionary"]

    ids = []
    spans = []  # (token_index, id_start, id_end) so we can fold characters back into words
    for token in tokens:
        start = len(ids)
        for ch in token:
            if ch in dictionary:
                ids.append(dictionary[ch])
        if len(ids) == start:  # nothing in-vocabulary
            continue
        spans.append((len(spans), start, len(ids)))
    if not ids:
        return None

    with torch.inference_mode():
        emission, _ = aligner["model"](waveform)
        emission = torch.log_softmax(emission, dim=-1)
        targets = torch.tensor([ids], dtype=torch.int32)
        aligned, scores = torchaudio.functional.forced_align(emission, targets, blank=0)

    aligned = aligned[0]
    scores = scores[0].exp()
    token_spans = torchaudio.functional.merge_tokens(aligned, scores)
    if len(token_spans) != len(ids):
        return None

    frames = emission.size(1)
    ratio = waveform.size(1) / frames
    words = []
    for word_index, id_start, id_end in spans:
        chunk = token_spans[id_start:id_end]
        if not chunk:
            continue
        words.append({
            "start_frame": chunk[0].start,
            "end_frame": chunk[-1].end,
            "score": float(sum(t.score for t in chunk) / len(chunk)),
            "word_index": word_index,
        })
    return {"words": words, "ratio": ratio}


def main():
    parser = argparse.ArgumentParser(description="Forced-align planned dialogue lines to the audio.")
    parser.add_argument("--audio", required=True, help="source video or wav")
    parser.add_argument("--plan", required=True, help="edit_plan.json")
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="MMS_FA", choices=["MMS_FA", "WAV2VEC2"])
    args = parser.parse_args()

    try:
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
    except ImportError:
        print("torch/torchaudio are not installed (pip install torch torchaudio)", file=sys.stderr)
        sys.exit(3)

    import torchaudio

    with open(args.plan, encoding="utf-8") as handle:
        plan = json.load(handle)
    lines = collect_lines(plan)
    if not lines:
        print("plan has no dialogue lines to align", file=sys.stderr)
        sys.exit(3)

    wav_path = args.audio
    temp_wav = None
    if not args.audio.lower().endswith(".wav"):
        temp_wav = extract_audio(args.audio)
        wav_path = temp_wav

    try:
        aligner = load_aligner(args.model)
        waveform, sample_rate = read_wav(wav_path, aligner["torch"])
        if sample_rate != aligner["sample_rate"]:
            waveform = torchaudio.functional.resample(waveform, sample_rate, aligner["sample_rate"])
            sample_rate = aligner["sample_rate"]
        if waveform.size(0) > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        total_sec = waveform.size(1) / sample_rate

        results = []
        for entry in lines:
            hint = entry["hint_start_sec"]
            if hint is None:
                results.append({**{k: entry[k] for k in ("slot_id", "line_index", "utt_id", "line")},
                                "status": "no_hint"})
                continue
            span = max((entry["hint_end_sec"] or hint) - hint, 0.0)

            def attempt(before, after):
                lo = max(0.0, hint - before)
                hi = min(total_sec, hint + span + after)
                chunk = waveform[:, int(lo * sample_rate):int(hi * sample_rate)]
                if chunk.size(1) < sample_rate // 2:
                    return None
                aligned = align_window(aligner, chunk, entry["tokens"])
                if not aligned or not aligned["words"]:
                    return None
                ratio = aligned["ratio"] / sample_rate
                built = [{
                    "w": entry["tokens"][word["word_index"]],
                    "s": round(lo + word["start_frame"] * ratio, 3),
                    "e": round(lo + word["end_frame"] * ratio, 3),
                    "score": round(word["score"], 3),
                } for word in aligned["words"]]
                ranked = sorted(w["score"] for w in built)
                return {"words": built, "median": ranked[len(ranked) // 2]}

            # Search close to the plan first. A repeated phrase ("30 million.") a few seconds later
            # can out-score the real utterance in a wide window, and then the tool accuses a plan
            # that was right. The plan only loses to a distant match that scores clearly better.
            near = attempt(NEAR_WINDOW_SEC, NEAR_WINDOW_SEC)
            far = attempt(SEARCH_BEFORE_SEC, SEARCH_AFTER_SEC)
            chosen = near
            if far and (not near or far["median"] > near["median"] + FAR_OVERRIDE_MARGIN):
                chosen = far
            # Two windows landing in different places means the audio holds more than one plausible
            # spot for these words (a repeated phrase, a stock line). We can report where we think it
            # is, but we must not let a verifier accuse the plan on evidence this soft.
            ambiguous = bool(near and far and abs(near["words"][0]["s"] - far["words"][0]["s"]) > 1.0)
            if not chosen:
                results.append({**{k: entry[k] for k in ("slot_id", "line_index", "utt_id", "line")},
                                "status": "unaligned"})
                continue
            words = chosen["words"]
            searched = "near" if chosen is near else "far"
            scores = sorted(w["score"] for w in words)
            median = scores[len(scores) // 2]
            # With <star> absorbing the unmatched audio the raw scores sit lower than a textbook
            # alignment; what separates a real placement from a forced one is how MANY words carry
            # weight, not the absolute mean. Measured on known-correct lines: strong >= 0.15.
            confident = sum(1 for s in scores if s >= 0.15) / len(scores)
            results.append({
                **{k: entry[k] for k in ("slot_id", "line_index", "utt_id", "line")},
                "status": "aligned",
                "hint_start_sec": hint,
                "start_sec": words[0]["s"],
                "end_sec": words[-1]["e"],
                "score": round(sum(scores) / len(scores), 3),
                "median_word_score": round(median, 3),
                "confident_word_ratio": round(confident, 3),
                # Two generic words can match a later repeat of the same phrase as easily as the
                # real one, so callers must not accuse the plan on this line alone.
                "weak_tokens": len(entry["tokens"]) < 3,
                "ambiguous": ambiguous,
                "searched": searched,
                "min_word_score": round(min(scores), 3),
                "shift_sec": round(words[0]["s"] - hint, 3),
                "words": words,
            })
            log(f"  {entry['utt_id']} {results[-1].get('status')} "
                f"{results[-1].get('start_sec')} score={results[-1].get('score')}")

        payload = {
            "audio": os.path.basename(args.audio),
            "model": args.model,
            "search_before_sec": SEARCH_BEFORE_SEC,
            "search_after_sec": SEARCH_AFTER_SEC,
            "lines": results,
        }
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=1)
        aligned_count = sum(1 for r in results if r.get("status") == "aligned")
        log(f"aligned {aligned_count}/{len(results)} lines -> {args.out}")
    finally:
        if temp_wav and os.path.exists(temp_wav):
            os.remove(temp_wav)


if __name__ == "__main__":
    main()
