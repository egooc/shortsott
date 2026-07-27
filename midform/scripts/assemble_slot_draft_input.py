#!/usr/bin/env python3
"""Assemble a CapCut draft input from a slot-filled midform script."""

import argparse
import asyncio
import hashlib
import itertools
import json
import math
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import edge_tts

try:
    reconfigure_stdout = getattr(sys.stdout, "reconfigure", None)
    if callable(reconfigure_stdout):
        reconfigure_stdout(encoding="utf-8", errors="replace")
except Exception:
    pass


PROJECT_ROOT = Path(__file__).resolve().parents[2]
TTS_CONFIG_PATH = PROJECT_ROOT / "midform" / "config" / "tts.json"
PROJECT_ENV_PATH = PROJECT_ROOT / ".env"
DEFAULT_TTS_CONFIG = {
    "provider": "edge",
    "voice": "ko-KR-SunHiNeural",
    "rate": "+0%",
    "volume": "+0%",
    "pitch": "+0Hz",
    "boundary": "",
    "base_chars_per_sec": 4.8,
    "voice_id": "",
    "model_id": "eleven_multilingual_v2",
    "voice_settings": {
        "stability": 0.5,
        "similarity_boost": 0.75,
        "style": 0.0,
        "use_speaker_boost": True,
        "speed": 1.0,
    },
    "output_format": "mp3_44100_128",
    "api_base": "https://api.elevenlabs.io",
}
ACTIVE_TTS_CONFIG = dict(DEFAULT_TTS_CONFIG)


CAPTION_MAX_CHARS = 11
CAPTION_EXTENDED_CHARS = 14
CAPTION_MIN_CHARS = 4
CAPTION_MIN_DURATION_SEC = 0.9
SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9_.-]+")
CONNECTIVE_END_RE = re.compile(r"(자|고|는데|는데도|지만|면서|며|수록|했는데|였는데|됐는데|되자|하자|오고|가자|자마자)[,，]?$")
PUNCT_END_RE = re.compile(r"[.!?。！？]$")
PARTICLE_END_RE = re.compile(r"(은|는|이|가|을|를|에|로|으로|에서|에게|의|도|만|까지)$")
PREDICATE_RE = re.compile(r"(습니다|했습니다|됐습니다|됩니다|였습니다|였죠|했죠|이죠|죠|버렸습니다|막았습니다|흔들렸습니다|돌렸습니다|가까웠죠|반박했습니다)$")
ADVERB_WORDS = {"잠깐", "바로", "다시", "이미", "즉시", "천천히", "결국", "정반대로"}
CONNECTOR_WORDS = {"그런데", "하지만", "그래서", "결국", "그러니까"}
BOUND_NOUN_WORDS = {"거야", "겁니다", "것", "거", "수", "뿐", "때", "채", "줄"}
AUXILIARY_START_WORDS = {"않자", "않고", "않아", "않았죠", "않았습니다", "않는데", "버렸죠", "버렸습니다", "버렸는데", "있었죠", "있었습니다", "있었는데"}
DEPENDENT_NOUN_STARTS = {"쪽으로", "때문에", "뿐만"}
PROTECTED_NAME_PAIRS = set()


def deep_merge(base, override):
    merged = dict(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_tts_config():
    config = dict(DEFAULT_TTS_CONFIG)
    if TTS_CONFIG_PATH.exists():
        raw = json.loads(TTS_CONFIG_PATH.read_text(encoding="utf-8-sig"))
        if isinstance(raw, dict):
            config = deep_merge(config, raw)
    provider = normalize_text(config.get("provider") or "edge").lower()
    config["provider"] = provider if provider in {"edge", "elevenlabs"} else "edge"
    return config


def read_env_file_value(key):
    if not PROJECT_ENV_PATH.exists():
        return ""
    prefix = f"{key}="
    for line in PROJECT_ENV_PATH.read_text(encoding="utf-8-sig").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or not stripped.startswith(prefix):
            continue
        return stripped[len(prefix):].strip().strip('"').strip("'")
    return ""


def set_active_tts_config(config):
    global ACTIVE_TTS_CONFIG
    ACTIVE_TTS_CONFIG = config


def tts_config():
    return ACTIVE_TTS_CONFIG


def edge_voice():
    return normalize_text(tts_config().get("voice") or DEFAULT_TTS_CONFIG["voice"])


def edge_rate():
    return normalize_text(tts_config().get("rate") or DEFAULT_TTS_CONFIG["rate"])


def edge_volume():
    return normalize_text(tts_config().get("volume") or DEFAULT_TTS_CONFIG["volume"])


def edge_pitch():
    return normalize_text(tts_config().get("pitch") or DEFAULT_TTS_CONFIG["pitch"])


def edge_boundary():
    return normalize_text(tts_config().get("boundary") or DEFAULT_TTS_CONFIG["boundary"])


def tts_speed():
    settings = tts_config().get("voice_settings")
    if not isinstance(settings, dict):
        return 1.0
    try:
        return float(settings.get("speed") or 1.0)
    except (TypeError, ValueError):
        return 1.0


def chars_per_second():
    effective = tts_config().get("effective_chars_per_sec")
    try:
        effective_value = float(effective or 0)
        if effective_value > 0:
            return effective_value
    except (TypeError, ValueError):
        pass
    try:
        base = float(tts_config().get("base_chars_per_sec") or 4.8)
    except (TypeError, ValueError):
        base = 4.8
    return max(0.1, base * max(0.1, tts_speed()))


def tts_provider_label():
    if tts_config().get("provider") == "elevenlabs":
        return "ElevenLabs API"
    return "Microsoft Edge online TTS via edge-tts"


def tts_model_id_label():
    if tts_config().get("provider") == "elevenlabs":
        return str(tts_config().get("model_id") or DEFAULT_TTS_CONFIG["model_id"])
    return f"edge-tts:{edge_voice()}"


def estimated_narration_seconds(text):
    char_count = len(re.sub(r"\s+", "", normalize_text(text)))
    if char_count <= 0:
        return 0.0
    return round(char_count / chars_per_second(), 3)


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalize_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def sanitize_display_caption_text(value):
    text = normalize_text(value)
    text = re.sub(r"\s*(?:—|–|ㅡ)\s*", " ", text)
    text = re.sub(r"(?:^|\s)>>\s*", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def split_display_caption_sources(value, segment_type=""):
    text = sanitize_display_caption_text(value)
    if not text:
        return []
    if str(segment_type or "") in {"dialogue_quote", "dialogue"}:
        parts = [sanitize_display_caption_text(part) for part in re.split(r"\s*/\s*", text)]
        return [part for part in parts if part]
    return [text]


def tts_param_payload():
    config = tts_config()
    if config.get("provider") == "elevenlabs":
        return {
            "provider": tts_provider_label(),
            "voice_id": str(config.get("voice_id") or "").strip(),
            "model_id": str(config.get("model_id") or DEFAULT_TTS_CONFIG["model_id"]).strip(),
            "voice_settings": config.get("voice_settings") if isinstance(config.get("voice_settings"), dict) else {},
            "output_format": str(config.get("output_format") or DEFAULT_TTS_CONFIG["output_format"]).strip(),
            "api_base": str(config.get("api_base") or DEFAULT_TTS_CONFIG["api_base"]).strip(),
        }
    return {
        "voice": edge_voice(),
        "rate": edge_rate(),
        "volume": edge_volume(),
        "pitch": edge_pitch(),
        "boundary": edge_boundary(),
        "provider": tts_provider_label(),
    }


def compute_text_hash(text):
    payload = {
        "text": normalize_text(text),
        **tts_param_payload(),
    }
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def protected_name_variants(value):
    text = normalize_text(value)
    if not text:
        return []
    variants = [text]
    if "/" in text:
        variants.extend(normalize_text(part) for part in text.split("/") if normalize_text(part))
    return variants


def configure_protected_name_pairs(movie_research=None, gemini_analysis=None):
    PROTECTED_NAME_PAIRS.clear()
    sources = []
    knowledge_characters = movie_research.get("movie_knowledge", {}).get("characters", []) if isinstance(movie_research, dict) else []
    gemini_characters = gemini_analysis.get("characters", []) if isinstance(gemini_analysis, dict) else []
    for character in knowledge_characters if isinstance(knowledge_characters, list) else []:
        if not isinstance(character, dict):
            continue
        sources.extend(protected_name_variants(character.get("screen_name")))
        sources.extend(protected_name_variants(character.get("role")))
    for character in gemini_characters if isinstance(gemini_characters, list) else []:
        if not isinstance(character, dict):
            continue
        for key in ["safe_display_name", "name", "original_name", "canonical_name", "character_name"]:
            sources.extend(protected_name_variants(character.get(key)))
    for phrase in set(sources):
        words = [word_core(word) for word in phrase.split(" ") if word_core(word)]
        if len(words) < 2:
            continue
        for index in range(1, len(words)):
            PROTECTED_NAME_PAIRS.add((words[index - 1], words[index]))


def safe_filename_stem(value, fallback="caption"):
    stem = SAFE_FILENAME_RE.sub("_", str(value or "").strip()).strip("._")
    return stem or fallback


def shorten_display_text(value, max_chars, min_chars=1):
    text = normalize_text(value)
    if len(text) <= max_chars:
        return text
    words = text.split(" ")
    selected = ""
    for word in words:
        candidate = normalize_text(f"{selected} {word}") if selected else word
        if len(candidate) > max_chars:
            break
        selected = candidate
    if len(selected) >= min_chars:
        return selected
    return text[:max_chars].strip()


def derive_title_block(segments):
    first_narration = ""
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        first_narration = normalize_text(segment.get("narration") or segment.get("caption_text"))
        if first_narration:
            break
    pieces = split_caption_text(first_narration, max_chars=11, min_eojeol=1)
    top_title = shorten_display_text(pieces[0] if pieces else first_narration, 11, 4)
    subtitle_source = pieces[1] if len(pieces) > 1 else first_narration.replace(top_title, "", 1).strip()
    top_subtitle = shorten_display_text(subtitle_source or first_narration, 14, 4)
    return {"top_title": top_title, "top_subtitle": top_subtitle}


def movie_identity_from_research(movie_research):
    if not isinstance(movie_research, dict):
        return {}
    raw_identity = movie_research.get("movie_identity")
    raw_knowledge = movie_research.get("movie_knowledge")
    identity = raw_identity if isinstance(raw_identity, dict) else {}
    knowledge = raw_knowledge if isinstance(raw_knowledge, dict) else {}
    title_kr = normalize_text(identity.get("title_kr") or knowledge.get("title_kr"))
    title_en = normalize_text(identity.get("title_en") or knowledge.get("title_en"))
    season = identity.get("season") or knowledge.get("season")
    episode = identity.get("episode") or knowledge.get("episode")
    display_title = title_kr or title_en
    if display_title and season and episode:
        display_title = f"{display_title} S{season}E{episode}"
    return {"title_kr": title_kr, "title_en": title_en, "display_title": display_title}


def enrich_segments_from_slot_map(segments, slot_map):
    slots = slot_map.get("slots", []) if isinstance(slot_map, dict) else []
    slot_by_id = {str(slot.get("slot_id") or "").strip(): slot for slot in slots if isinstance(slot, dict)}
    enriched = []
    for segment in segments if isinstance(segments, list) else []:
        if not isinstance(segment, dict):
            enriched.append(segment)
            continue
        slot_id = str(segment.get("slot_id") or segment.get("segment_id") or "").strip()
        slot = slot_by_id.get(slot_id) or {}
        item = dict(segment)
        for key in ["narration_background", "source_audio_ducking", "lip_sync_risk", "dialogue_heavy_role", "quote_selection"]:
            if key in slot and key not in item:
                item[key] = slot[key]
        enriched.append(item)
    return enriched


def contained_output_path(output_dir, filename):
    base_dir = Path(output_dir).resolve()
    output_path = (base_dir / filename).resolve()
    if output_path.parent != base_dir:
        raise ValueError(f"Unsafe TTS output path escaped --tts-dir: {filename}")
    return output_path


def split_by_sentence_boundaries(text):
    text = normalize_text(text)
    if not text:
        return []
    ellipsis_placeholder = "<ELLIPSIS>"
    protected_text = text.replace("...", ellipsis_placeholder)
    protected = re.sub(r"([.!?。！？])\s+", r"\1\n", protected_text)
    parts = []
    for piece in protected.splitlines():
        piece = piece.replace(ellipsis_placeholder, "...").strip()
        if not piece:
            continue
        cursor = 0
        pattern = re.compile(r"(.+?(?:습니다|했습니다|됩니다|였죠|했죠|이죠|죠|는데|했는데|버렸습니다|다)[.!?。！？]?)($|\s)")
        for match in pattern.finditer(piece):
            chunk = piece[cursor:match.end(1)].strip()
            if chunk:
                parts.append(chunk)
            cursor = match.end()
        remain = piece[cursor:].strip()
        if remain:
            parts.append(remain)
    return parts or [text]


def count_eojeol(text):
    return len([word for word in normalize_text(text).split(" ") if word])


def visible_len(text):
    return len(re.sub(r"\s+", "", normalize_text(text)))


def segment_duration_sec(segment):
    clips = segment.get("source_clips") or segment.get("source_scenes") or []
    total = 0.0
    for clip in clips:
        start = parse_timecode_to_sec(clip.get("start"))
        end = parse_timecode_to_sec(clip.get("end"))
        if start is not None and end is not None and end > start:
            total += end - start
    return total


def parse_timecode_to_sec(value):
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value or "").strip()
    if not text:
        return None
    parts = text.split(":")
    try:
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        return float(text)
    except ValueError:
        return None


def build_transcript_utterance_map(transcript):
    utterances = transcript.get("utterances", []) if isinstance(transcript, dict) else []
    result = {}
    for utterance in utterances:
        if not isinstance(utterance, dict):
            continue
        utt_id = str(utterance.get("utt_id") or utterance.get("id") or "").strip()
        if not utt_id:
            continue
        start = utterance.get("start")
        end = utterance.get("end")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or end <= start:
            continue
        result[utt_id] = {"start": float(start), "end": float(end), "text": normalize_text(utterance.get("text"))}
    return result


def validate_dialogue_utterance_references(segments, transcript):
    utterance_map = build_transcript_utterance_map(transcript)
    if not utterance_map:
        raise ValueError("TRANSCRIPT_UTTERANCES_REQUIRED: --transcript must contain utterances for dialogue slot validation")
    errors = []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        segment_type = str(segment.get("segment_type") or "").strip()
        if segment_type not in {"dialogue_quote", "dialogue"}:
            continue
        segment_id = str(segment.get("segment_id") or segment.get("slot_id") or "unknown_segment").strip()
        utt_id = str(segment.get("utt_id") or "").strip()
        if not utt_id:
            errors.append(f"{segment_id}: dialogue segment is missing utt_id")
            continue
        utterance = utterance_map.get(utt_id)
        if utterance is None:
            errors.append(f"{segment_id}: utt_id {utt_id} not found in transcript")
            continue
        clips = segment.get("source_clips") or segment.get("source_scenes") or []
        if not clips:
            continue
        clip = clips[0] if isinstance(clips, list) else None
        if not isinstance(clip, dict):
            continue
        start = parse_timecode_to_sec(clip.get("start"))
        end = parse_timecode_to_sec(clip.get("end"))
        if start is None or end is None:
            continue
        within_utterance = start >= utterance["start"] - 0.05 and end <= utterance["end"] + 0.05 and end > start
        exact_utterance = abs(start - utterance["start"]) <= 0.05 and abs(end - utterance["end"]) <= 0.05
        if not (exact_utterance or within_utterance):
            errors.append(
                f"{segment_id}: source clip {start:.3f}-{end:.3f} does not match {utt_id} "
                f"{utterance['start']:.3f}-{utterance['end']:.3f}"
            )
    if errors:
        raise ValueError("DIALOGUE_UTTERANCE_REFERENCE_FAILED: " + "; ".join(errors))


def word_core(value):
    return re.sub(r"[,，.!?。！？]+$", "", str(value or "").strip())


def is_protected_boundary(left_word, right_word):
    left_core = word_core(left_word)
    right_core = word_core(right_word)
    if (left_core, right_core) in PROTECTED_NAME_PAIRS:
        return True
    if left_core == "수" and right_core.startswith(("있", "없")):
        return True
    if right_core == "수밖에" or any(right_core.startswith(token) for token in DEPENDENT_NOUN_STARTS):
        return True
    protected_left = left_core.endswith(("지", "할", "한", "하는", "하던", "될", "된", "되는", "있던", "있었", "버티고", "무너지지"))
    if right_core in BOUND_NOUN_WORDS:
        return True
    return protected_left and right_core in AUXILIARY_START_WORDS


def is_forbidden_boundary(left_word, right_word):
    left = str(left_word or "").strip()
    right = str(right_word or "").strip()
    if not left or not right:
        return True
    if is_protected_boundary(left, right):
        return True
    if left.endswith("의"):
        return True
    if left in ADVERB_WORDS and PREDICATE_RE.search(right):
        return True
    if left.endswith(("가", "이")) and PREDICATE_RE.search(right):
        return True
    if left.endswith("가로채") and right.startswith("막"):
        return True
    return False


def boundary_score(left_word, right_word):
    left = str(left_word or "").strip()
    right = str(right_word or "").strip()
    if is_forbidden_boundary(left, right):
        return -100
    if PUNCT_END_RE.search(left):
        return 80
    if CONNECTIVE_END_RE.search(left):
        return 80
    if right in CONNECTOR_WORDS:
        return 60
    if left.endswith((",", "，")):
        return 60
    if word_core(left).endswith(("다는", "라는", "이라는", "였다는", "이었다는")):
        return 40
    if word_core(left) in {"오히려", "이미", "결국", "끝까지"}:
        return 40
    if PARTICLE_END_RE.search(left):
        return 40
    return 20


def chunk_has_protected_pair(words):
    return any(is_protected_boundary(words[index - 1], words[index]) for index in range(1, len(words)))


def chunk_allowed(words, max_chars=CAPTION_MAX_CHARS, protected_chars=CAPTION_EXTENDED_CHARS, min_chars=CAPTION_MIN_CHARS):
    length = visible_len(" ".join(words))
    if length < min_chars:
        return False
    if length <= max_chars:
        return True
    return length <= protected_chars and chunk_has_protected_pair(words)


def partition_score(words, boundaries, ideal_positions):
    starts = [0] + list(boundaries)
    ends = list(boundaries) + [len(words)]
    lengths = [visible_len(" ".join(words[start:end])) for start, end in zip(starts, ends)]
    imbalance = max(lengths) - min(lengths)
    ratio = (max(lengths) / max(1, min(lengths))) if lengths else 999
    boundary_points = [sum(visible_len(word) for word in words[:boundary]) for boundary in boundaries]
    distance = sum(abs(point - ideal_positions[index]) for index, point in enumerate(boundary_points))
    boundary_quality = sum(boundary_score(words[boundary - 1], words[boundary]) for boundary in boundaries)
    return (imbalance * 1000) + (ratio * 100) + (distance * 10) - boundary_quality


def balanced_partition_words(words, max_chars=CAPTION_MAX_CHARS, protected_chars=CAPTION_EXTENDED_CHARS, min_chars=CAPTION_MIN_CHARS):
    total_len = sum(visible_len(word) for word in words)
    if total_len <= max_chars:
        return [" ".join(words)]
    min_parts = max(2, math.ceil(total_len / max_chars))
    for part_count in range(min_parts, len(words) + 1):
        ideal_positions = [total_len * (index / part_count) for index in range(1, part_count)]
        candidate_boundaries = []
        for ideal in ideal_positions:
            local = []
            for boundary in range(1, len(words)):
                if is_forbidden_boundary(words[boundary - 1], words[boundary]):
                    continue
                point = sum(visible_len(word) for word in words[:boundary])
                if abs(point - ideal) <= 5 and boundary_score(words[boundary - 1], words[boundary]) >= 40:
                    local.append((boundary_score(words[boundary - 1], words[boundary]), -abs(point - ideal), boundary))
            if not local:
                candidate_boundaries = []
                break
            local.sort(reverse=True)
            candidate_boundaries.append([item[2] for item in local[:6]])
        if not candidate_boundaries or len(candidate_boundaries) != part_count - 1:
            continue
        best = None
        for raw_boundaries in itertools.product(*candidate_boundaries):
            boundaries = tuple(sorted(set(raw_boundaries)))
            if len(boundaries) != part_count - 1:
                continue
            starts = [0] + list(boundaries)
            ends = list(boundaries) + [len(words)]
            chunks = [words[start:end] for start, end in zip(starts, ends)]
            if not all(chunk_allowed(chunk, max_chars=max_chars, protected_chars=protected_chars, min_chars=min_chars) for chunk in chunks):
                continue
            score = partition_score(words, boundaries, ideal_positions)
            if best is None or score < best[0]:
                best = (score, chunks)
        if best is not None:
            return [" ".join(chunk) for chunk in best[1]]
    return [" ".join(words)]


def split_long_caption_by_eojeol(text, max_chars=CAPTION_MAX_CHARS, min_eojeol=1, extended_chars=CAPTION_EXTENDED_CHARS):
    text = normalize_text(text)
    if not text:
        return []
    if visible_len(text) <= max_chars:
        return [text]
    words = text.split(" ")
    if len(words) <= 1:
        return [text]
    return [chunk for chunk in balanced_partition_words(words, max_chars=max_chars, protected_chars=extended_chars, min_chars=CAPTION_MIN_CHARS) if chunk]


def split_caption_text(text, max_chars=CAPTION_MAX_CHARS, min_eojeol=1):
    text = normalize_text(text)
    if not text:
        return []
    units = []
    for sentence in split_by_sentence_boundaries(text):
        sentence = sentence.strip()
        if not sentence:
            continue
        if visible_len(sentence) <= max_chars:
            units.append(sentence)
            continue
        comma_parts = [part.strip() for part in re.split(r"(?<=[,，])\s+", sentence) if part.strip()]
        if len(comma_parts) > 1:
            for part in comma_parts:
                units.extend(split_long_caption_by_eojeol(part, max_chars=max_chars, min_eojeol=min_eojeol, extended_chars=CAPTION_EXTENDED_CHARS))
        else:
            units.extend(split_long_caption_by_eojeol(sentence, max_chars=max_chars, min_eojeol=min_eojeol, extended_chars=CAPTION_EXTENDED_CHARS))
    return units or [text]


def merge_short_units(units, segment=None, max_chars=CAPTION_MAX_CHARS, extended_chars=CAPTION_EXTENDED_CHARS, min_chars=CAPTION_MIN_CHARS, min_duration_sec=CAPTION_MIN_DURATION_SEC):
    units = [normalize_text(unit) for unit in units if normalize_text(unit)]
    if len(units) <= 1:
        return units
    duration = segment_duration_sec(segment or {})
    changed = True
    while changed and len(units) > 1:
        changed = False
        estimated = duration / len(units) if duration > 0 else 2.0
        merged = []
        index = 0
        while index < len(units):
            current = units[index]
            too_short = visible_len(current) < min_chars or estimated < min_duration_sec
            if too_short and index + 1 < len(units):
                candidate = normalize_text(f"{current} {units[index + 1]}")
                if chunk_allowed(candidate.split(" "), max_chars=max_chars, protected_chars=extended_chars, min_chars=min_chars):
                    merged.append(candidate)
                    index += 2
                    changed = True
                    continue
            if too_short and merged:
                candidate = normalize_text(f"{merged[-1]} {current}")
                if chunk_allowed(candidate.split(" "), max_chars=max_chars, protected_chars=extended_chars, min_chars=min_chars):
                    merged[-1] = candidate
                    index += 1
                    changed = True
                    continue
            merged.append(current)
            index += 1
        units = merged
    return units


def merge_short_dialogue_units_across_slots(units, segments_by_id, extended_chars=CAPTION_EXTENDED_CHARS, min_chars=CAPTION_MIN_CHARS, min_duration_sec=CAPTION_MIN_DURATION_SEC):
    merged = []
    index = 0
    while index < len(units):
        unit = dict(units[index])
        segment = segments_by_id.get(unit.get("segment_id"), {})
        segment_type = str(segment.get("segment_type") or unit.get("segment_type") or "").strip()
        if segment_type in {"dialogue_quote", "dialogue"}:
            merged.append(unit)
            index += 1
            continue
        if unit.get("tts_enabled") is not False:
            merged.append(unit)
            index += 1
            continue
        combined_ids = [unit.get("segment_id")]
        combined_text = normalize_text(unit.get("text"))
        combined_duration = segment_duration_sec(segments_by_id.get(unit.get("segment_id"), {}))
        lookahead = index + 1
        while lookahead < len(units):
            next_unit = units[lookahead]
            if next_unit.get("tts_enabled") is not False:
                break
            next_text = normalize_text(next_unit.get("text"))
            candidate = normalize_text(f"{combined_text} {next_text}")
            next_duration = segment_duration_sec(segments_by_id.get(next_unit.get("segment_id"), {}))
            should_merge = combined_duration < min_duration_sec or visible_len(combined_text) < min_chars or next_duration < min_duration_sec or visible_len(next_text) < min_chars
            if not should_merge or not chunk_allowed(candidate.split(" "), protected_chars=extended_chars, min_chars=min_chars):
                break
            combined_text = candidate
            combined_duration += next_duration
            combined_ids.append(next_unit.get("segment_id"))
            lookahead += 1
        unit["text"] = combined_text
        if len(combined_ids) > 1:
            unit["combined_segment_ids"] = [str(item) for item in combined_ids if item]
            unit["duration_override_sec"] = round(combined_duration, 6)
        merged.append(unit)
        index = lookahead
    return merged


def split_tts_sentences(text):
    sentences = split_by_sentence_boundaries(text)
    merged = []
    for sentence in sentences:
        sentence = normalize_text(sentence)
        if not sentence:
            continue
        if merged and len(merged[-1]) < 15 and len(f"{merged[-1]} {sentence}") <= 40:
            merged[-1] = normalize_text(f"{merged[-1]} {sentence}")
        elif len(sentence) > 48:
            merged.extend(split_long_caption_by_eojeol(sentence, max_chars=40, min_eojeol=2, extended_chars=40))
        else:
            merged.append(sentence)
    return merged or [normalize_text(text)]


def build_timeline_units(segments):
    caption_units = []
    tts_units = []
    segments_by_id = {str(segment.get("segment_id") or ""): segment for segment in segments if isinstance(segment, dict)}
    for segment_index, segment in enumerate(segments, start=1):
        segment_id = str(segment.get("segment_id") or f"s{segment_index:02d}")
        segment_type = str(segment.get("segment_type") or "recap")
        tts_enabled = segment.get("tts_enabled") is not False and segment_type not in {"dialogue_quote", "dialogue"}
        text = segment.get("translated_caption_ko") or segment.get("caption_text") if not tts_enabled else segment.get("narration") or segment.get("caption_text")
        if tts_enabled:
            for sentence_order, sentence in enumerate(split_tts_sentences(text), start=1):
                sentence_id = f"{safe_filename_stem(segment_id, f's{segment_index:02d}')}_sent_{sentence_order:03d}"
                tts_units.append(
                    {
                        "caption_id": sentence_id,
                        "sentence_id": sentence_id,
                        "segment_id": segment_id,
                        "segment_type": segment_type,
                        "tts_enabled": True,
                        "order": sentence_order,
                        "text": sentence,
                        "speaker": normalize_text(segment.get("speaker")),
                        "source_segment_order": segment_index,
                    }
                )
                display_sentence = sanitize_display_caption_text(sentence)
                chunks = merge_short_units(split_caption_text(display_sentence), segment=segment)
                for display_order, chunk in enumerate(chunks, start=1):
                    caption_units.append(
                        {
                            "caption_id": f"{sentence_id}_cap_{display_order:03d}",
                            "sentence_id": sentence_id,
                            "tts_caption_id": sentence_id,
                            "segment_id": segment_id,
                            "segment_type": segment_type,
                            "tts_enabled": True,
                            "order": display_order,
                            "text": sanitize_display_caption_text(chunk),
                            "speaker": normalize_text(segment.get("speaker")),
                            "source_segment_order": segment_index,
                        }
                    )
        else:
            chunks = []
            for display_source in split_display_caption_sources(text, segment_type):
                chunks.extend(merge_short_units(split_caption_text(display_source), segment=segment))
            for order, chunk in enumerate(chunks, start=1):
                caption_id = f"{safe_filename_stem(segment_id, f's{segment_index:02d}')}_cap_{order:03d}"
                caption_units.append(
                    {
                        "caption_id": caption_id,
                        "segment_id": segment_id,
                        "segment_type": segment_type,
                        "tts_enabled": False,
                        "order": order,
                        "text": sanitize_display_caption_text(chunk),
                        "speaker": normalize_text(segment.get("speaker")),
                        "source_segment_order": segment_index,
                    }
                )
    return merge_short_dialogue_units_across_slots(caption_units, segments_by_id), tts_units


def ffprobe_duration(path):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


async def synthesize_unit(unit, output_dir):
    if tts_config().get("provider") == "elevenlabs":
        return await synthesize_unit_elevenlabs(unit, output_dir)
    return await synthesize_unit_edge(unit, output_dir)


async def synthesize_unit_edge(unit, output_dir):
    caption_id = safe_filename_stem(unit.get("caption_id"), "caption")
    output_path = contained_output_path(output_dir, f"{caption_id}.mp3")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    text_hash = unit.get("text_hash") or compute_text_hash(unit.get("text"))
    await edge_tts.Communicate(unit["text"], edge_voice(), rate=edge_rate(), volume=edge_volume(), pitch=edge_pitch()).save(str(output_path))
    return {
        "caption_id": caption_id,
        "segment_id": unit["segment_id"],
        "filename": output_path.name,
        "filepath": str(output_path),
        "duration_sec": round(ffprobe_duration(output_path), 3),
        "text": unit["text"],
        "text_hash": text_hash,
        "tts_params": tts_param_payload(),
        "reused": False,
        "success": True,
    }


async def synthesize_unit_elevenlabs(unit, output_dir):
    config = tts_config()
    api_key = normalize_text(os.environ.get("ELEVENLABS_API_KEY") or read_env_file_value("ELEVENLABS_API_KEY"))
    if not api_key:
        raise RuntimeError("ELEVENLABS_API_KEY is not set")
    voice_id = normalize_text(config.get("voice_id"))
    if not voice_id:
        raise RuntimeError("ElevenLabs voice_id is not configured")
    model_id = normalize_text(config.get("model_id") or DEFAULT_TTS_CONFIG["model_id"])
    output_format = normalize_text(config.get("output_format") or DEFAULT_TTS_CONFIG["output_format"])
    api_base = normalize_text(config.get("api_base") or DEFAULT_TTS_CONFIG["api_base"]).rstrip("/")
    voice_settings = config.get("voice_settings") if isinstance(config.get("voice_settings"), dict) else {}
    payload = {
        "text": unit["text"],
        "model_id": model_id,
        "voice_settings": voice_settings,
    }
    url = f"{api_base}/v1/text-to-speech/{urllib.parse.quote(voice_id)}?output_format={urllib.parse.quote(output_format)}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            audio_bytes = response.read()
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"ElevenLabs HTTP {error.code}: {body}") from error
    caption_id = safe_filename_stem(unit.get("caption_id"), "caption")
    output_path = contained_output_path(output_dir, f"{caption_id}.mp3")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(audio_bytes)
    duration_sec = round(ffprobe_duration(output_path), 3)
    text_hash = unit.get("text_hash") or compute_text_hash(unit.get("text"))
    return {
        "caption_id": caption_id,
        "segment_id": unit["segment_id"],
        "filename": output_path.name,
        "filepath": str(output_path),
        "duration_sec": duration_sec,
        "text": unit["text"],
        "text_hash": text_hash,
        "tts_params": tts_param_payload(),
        "reused": False,
        "success": True,
    }


def build_reusable_tts_index(manifest_path):
    manifest = load_json(manifest_path)
    files = manifest.get("files", []) if isinstance(manifest, dict) else []
    tts_units = manifest.get("tts_units", []) if isinstance(manifest, dict) else []
    unit_by_caption_id = {
        str(unit.get("caption_id") or ""): unit
        for unit in tts_units
        if isinstance(unit, dict)
    }
    reusable_by_hash = {}
    for item in files if isinstance(files, list) else []:
        if not isinstance(item, dict):
            continue
        filepath = Path(str(item.get("filepath") or ""))
        if not filepath.is_absolute():
            filepath = (Path(manifest_path).parent / filepath).resolve()
        if not filepath.exists():
            continue
        caption_id = str(item.get("caption_id") or item.get("captionId") or "")
        unit = unit_by_caption_id.get(caption_id) or {}
        text_value = item.get("text") or unit.get("text") or ""
        text_hash = str(item.get("text_hash") or unit.get("text_hash") or compute_text_hash(text_value)).strip()
        if not text_hash:
            continue
        reusable_by_hash.setdefault(text_hash, []).append(
            {
                "caption_id": caption_id,
                "segment_id": str(item.get("segment_id") or item.get("segmentId") or ""),
                "filename": item.get("filename") or filepath.name,
                "filepath": str(filepath),
                "duration_sec": item.get("duration_sec"),
                "text": text_value,
                "text_hash": text_hash,
                "tts_params": item.get("tts_params") or unit.get("tts_params") or {},
            }
        )
    return reusable_by_hash


def reuse_file_for_unit(unit, reusable_item, output_dir):
    caption_id = safe_filename_stem(unit.get("caption_id"), "caption")
    output_path = contained_output_path(output_dir, f"{caption_id}.mp3")
    source_path = Path(str(reusable_item.get("filepath") or "")).resolve()
    if not source_path.exists():
        raise FileNotFoundError(f"Reusable TTS file missing: {source_path}")
    if source_path != output_path:
        shutil.copy2(source_path, output_path)
    duration_sec = reusable_item.get("duration_sec")
    try:
        duration_sec = round(float(duration_sec), 3)
    except (TypeError, ValueError):
        duration_sec = round(ffprobe_duration(output_path), 3)
    return {
        "caption_id": caption_id,
        "segment_id": unit["segment_id"],
        "filename": output_path.name,
        "filepath": str(output_path),
        "duration_sec": duration_sec,
        "text": unit["text"],
        "text_hash": unit.get("text_hash") or reusable_item.get("text_hash") or compute_text_hash(unit.get("text")),
        "tts_params": reusable_item.get("tts_params") or tts_param_payload(),
        "reused": True,
        "reused_from_path": str(source_path),
        "success": True,
    }


async def synthesize_tts(tts_units, output_dir, reusable_manifest_path=None):
    Path(output_dir).resolve().mkdir(parents=True, exist_ok=True)
    files = []
    reusable_by_hash = build_reusable_tts_index(reusable_manifest_path) if reusable_manifest_path else {}
    reused_units = []
    regenerated_units = []
    for unit in tts_units:
        if unit.get("tts_enabled") is False:
            continue
        text_hash = unit.get("text_hash") or compute_text_hash(unit.get("text"))
        unit["text_hash"] = text_hash
        reusable_candidates = reusable_by_hash.get(text_hash) or []
        if reusable_candidates:
            reusable_item = reusable_candidates.pop(0)
            files.append(reuse_file_for_unit(unit, reusable_item, output_dir))
            reused_units.append({
                "caption_id": unit.get("caption_id"),
                "segment_id": unit.get("segment_id"),
                "text_hash": text_hash,
            })
            continue
        files.append(await synthesize_unit(unit, output_dir))
        regenerated_units.append({
            "caption_id": unit.get("caption_id"),
            "segment_id": unit.get("segment_id"),
            "text_hash": text_hash,
        })
    changed_segment_ids = sorted({str(item.get("segment_id") or "") for item in regenerated_units if str(item.get("segment_id") or "")})
    return files, {
        "reused_count": len(reused_units),
        "regenerated_count": len(regenerated_units),
        "reused": reused_units,
        "regenerated": regenerated_units,
        "changed_segment_ids": changed_segment_ids,
        "reuse_manifest_path": str(Path(reusable_manifest_path).resolve()) if reusable_manifest_path else "",
    }


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", required=True)
    parser.add_argument("--source-video", required=True)
    parser.add_argument("--transcript", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--tts-dir", required=True)
    parser.add_argument("--movie-research")
    parser.add_argument("--gemini-analysis")
    parser.add_argument("--reuse-tts-manifest")
    parser.add_argument("--preview-only", action="store_true")
    parser.add_argument("--sample-segment-id")
    parser.add_argument("--sample-output")
    args = parser.parse_args()

    set_active_tts_config(load_tts_config())
    script = load_json(args.script)
    transcript = load_json(args.transcript)
    movie_research = load_json(args.movie_research) if args.movie_research else {}
    gemini_analysis = load_json(args.gemini_analysis) if args.gemini_analysis else {}
    configure_protected_name_pairs(movie_research, gemini_analysis)
    segments = enrich_segments_from_slot_map(script.get("segments", []), script.get("slot_map", {}))
    validate_dialogue_utterance_references(segments, transcript)
    caption_units, tts_units = build_timeline_units(segments)
    for unit in tts_units:
        unit["text_hash"] = compute_text_hash(unit.get("text"))
    title_block = script.get("title_block") if isinstance(script.get("title_block"), dict) else derive_title_block(segments)
    movie_identity = movie_identity_from_research(movie_research)
    script["title_block"] = title_block
    if movie_identity:
        script["movie_identity"] = movie_identity
    if args.preview_only:
        preview_payload = {
            "segments": segments,
            "ttsUnits": tts_units,
            "captionUnits": caption_units,
            "slotMap": script.get("slot_map", {}),
            "titleBlock": title_block,
            "movieResearch": movie_research,
            "movieIdentity": movie_identity,
            "geminiAnalysis": gemini_analysis,
            "ttsProvider": tts_provider_label(),
            "ttsParams": tts_param_payload(),
        }
        write_json(args.output, preview_payload)
        print(json.dumps({"captionUnits": len(caption_units), "ttsUnits": len(tts_units), "previewOnly": True}, ensure_ascii=False))
        return
    if args.sample_segment_id:
        sample_segment_id = normalize_text(args.sample_segment_id)
        sample_output = str(Path(args.sample_output or (Path(args.tts_dir) / f"{safe_filename_stem(sample_segment_id, 'sample')}_sample.mp3")).resolve())
        segment = next((segment for segment in segments if normalize_text(segment.get("segment_id")) == sample_segment_id), None)
        if not segment:
            raise ValueError(f"sample segment not found: {sample_segment_id}")
        sample_text = normalize_text(segment.get("narration") or segment.get("caption_text"))
        sample_unit = {
            "caption_id": f"{safe_filename_stem(sample_segment_id, 'sample')}_sample",
            "segment_id": sample_segment_id,
            "text": sample_text,
            "text_hash": compute_text_hash(sample_text),
        }
        sample_file = await synthesize_unit(sample_unit, str(Path(sample_output).resolve().parent))
        actual_path = str(Path(sample_file["filepath"]).resolve())
        target_path = str(Path(sample_output).resolve())
        if actual_path != target_path:
            shutil.move(actual_path, target_path)
            sample_file["filepath"] = target_path
            sample_file["filename"] = Path(target_path).name
        print(json.dumps({
            "segment_id": sample_segment_id,
            "provider": tts_provider_label(),
            "model_id": tts_model_id_label(),
            "output_path": sample_file["filepath"],
            "duration_sec": sample_file["duration_sec"],
            "estimated_duration_sec": estimated_narration_seconds(sample_text),
            "chars_per_sec": round(chars_per_second(), 3),
            "text": sample_text,
        }, ensure_ascii=False))
        return
    tts_files, reuse_summary = await synthesize_tts(tts_units, args.tts_dir, args.reuse_tts_manifest)
    draft_input = {
        "segments": segments,
        "ttsFiles": tts_files,
        "captionUnits": caption_units,
        "ttsUnits": tts_units,
        "captionWarnings": [],
        "claudeScript": script,
        "gptScript": script,
        "slotMap": script.get("slot_map", {}),
        "titleBlock": title_block,
        "movieResearch": movie_research,
            "movieIdentity": movie_identity,
            "geminiAnalysis": gemini_analysis,
            "gemini_analysis_path": str(Path(args.gemini_analysis).resolve()) if args.gemini_analysis else "",
        "script_path": str(Path(args.script).resolve()),
        "script_input_path": str(Path(args.script).resolve()),
        "source_video_path": str(Path(args.source_video).resolve()),
        "source_transcript_path": str(Path(args.transcript).resolve()),
        "sourceDurationSec": script.get("source_reference", {}).get("duration_sec", 0),
        "videoPlacementMode": "source_clips",
        "audioPathMode": "absolute",
        "useCapcutTemplate": True,
        "resolution": {"width": 1080, "height": 1920},
        "fps": 30,
        "slotMode": True,
            "ttsProvider": tts_provider_label(),
            "ttsParams": tts_param_payload(),
            "ttsReuseSummary": reuse_summary,
        }
    write_json(args.output, draft_input)
    write_json(
        contained_output_path(args.tts_dir, "gpt_midform_tts_manifest.json"),
        {
            "model_id": tts_model_id_label(),
            "tts_provider": tts_provider_label(),
            "tts_network_disclosure": "Narration text is sent to the configured online TTS provider during synthesis.",
            "reused_from_manifest": str(Path(args.reuse_tts_manifest).resolve()) if args.reuse_tts_manifest else "",
            "caption_units": caption_units,
            "tts_units": tts_units,
            "files": tts_files,
            "tts_params": tts_param_payload(),
            "reuse_summary": reuse_summary,
        },
    )
    print(json.dumps({"captionUnits": len(caption_units), "ttsFiles": len(tts_files), "reused": reuse_summary["reused_count"], "regenerated": reuse_summary["regenerated_count"]}, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
