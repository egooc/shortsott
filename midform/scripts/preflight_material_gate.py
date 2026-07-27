#!/usr/bin/env python3
"""Pre-flight material suitability gate for midform sealed runs.

This script intentionally sits before the Gemini/GPT/TTS/CapCut pipeline body.
It uses only yt-dlp metadata and STT transcript output so unsuitable sources can
be rejected before spending Vertex/Gemini calls.
"""

import argparse
import json
import re
import sys
from pathlib import Path


MIN_UTTERANCES = 6
MIN_SPEECH_RATIO = 0.15
PROJECT_ROOT = Path(__file__).resolve().parents[2]
DURATION_CONFIG_PATH = PROJECT_ROOT / "midform" / "config" / "duration.json"
SCENE_CLUE_RE = re.compile(
    r"\b(scene|clip|moment|confronts?|confrontation|argument|dialogue|conversation|"
    r"monologue|speech|confession|interrogation|breakdown|fight|battle|attack|attacks|"
    r"duel|first\s+duel|rescue|death|ending|finale|reaction|talks?|meets?|abandons?)\b",
    re.IGNORECASE,
)
GENERIC_TITLE_RE = re.compile(
    r"^(?:january|february|march|april|may|june|july|august|september|october|"
    r"november|december)\s+\d{1,2},?\s+\d{4}$|^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$",
    re.IGNORECASE,
)
MOVIE_HASHTAG_RE = re.compile(r"#\s*([A-Za-z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+){1,})")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_duration_config() -> dict:
    defaults = {"min_duration_sec": 60.0, "max_duration_sec": 160.0}
    if not DURATION_CONFIG_PATH.exists():
        return defaults
    try:
        data = json.loads(DURATION_CONFIG_PATH.read_text(encoding="utf-8-sig"))
    except Exception:
        return defaults
    if not isinstance(data, dict):
        return defaults
    return {
        "min_duration_sec": safe_float(data.get("min_duration_sec"), defaults["min_duration_sec"]),
        "max_duration_sec": safe_float(data.get("max_duration_sec"), defaults["max_duration_sec"]),
    }


def normalize_text(value) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def safe_float(value, fallback=0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if number == number else fallback


def transcript_metrics(transcript: dict, source_duration_sec: float) -> dict:
    utterances = []
    for item in transcript.get("utterances", []) if isinstance(transcript, dict) else []:
        text = normalize_text(item.get("text")) if isinstance(item, dict) else ""
        start = safe_float(item.get("start") if isinstance(item, dict) else None, -1)
        end = safe_float(item.get("end") if isinstance(item, dict) else None, -1)
        if text and end > start >= 0:
            utterances.append({"start": start, "end": end, "text": text})
    total_speech_sec = sum(item["end"] - item["start"] for item in utterances)
    ratio = total_speech_sec / source_duration_sec if source_duration_sec > 0 else 0.0
    return {
        "utterance_count": len(utterances),
        "total_speech_sec": round(total_speech_sec, 3),
        "source_duration_sec": round(source_duration_sec, 3),
        "speech_ratio": round(ratio, 4),
        "passes": len(utterances) >= MIN_UTTERANCES and ratio >= MIN_SPEECH_RATIO,
    }


def metadata_duration(source_info: dict, transcript: dict) -> float:
    return safe_float(
        source_info.get("duration")
        or source_info.get("duration_sec")
        or source_info.get("duration_string")
        or transcript.get("source_duration")
        or transcript.get("duration"),
        0.0,
    )


def load_optional_json(path_value: str):
    raw = normalize_text(path_value)
    if not raw:
        return None
    path = Path(raw)
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    if not path.exists():
        return None
    try:
        return load_json(path)
    except Exception:
        return None


def estimate_duration_from_edit_plan(edit_plan) -> float:
    if not isinstance(edit_plan, dict):
        return 0.0
    budget = edit_plan.get("duration_budget") if isinstance(edit_plan.get("duration_budget"), dict) else {}
    estimated = safe_float(budget.get("estimated_total_sec"), 0.0)
    if estimated > 0:
        return estimated
    timeline = edit_plan.get("timeline") if isinstance(edit_plan.get("timeline"), list) else []
    return sum(safe_float(item.get("estimated_duration_sec"), 0.0) for item in timeline if isinstance(item, dict))


def estimate_duration_from_tts_manifest(tts_manifest) -> float:
    if not isinstance(tts_manifest, dict):
        return 0.0
    direct = safe_float(tts_manifest.get("total_duration_sec") or tts_manifest.get("totalDurationSec"), 0.0)
    if direct > 0:
        return direct
    candidates = []
    for key in ["files", "items", "results", "tts_results", "captions"]:
        value = tts_manifest.get(key)
        if isinstance(value, list):
            candidates = value
            break
    return sum(safe_float(item.get("duration_sec"), 0.0) for item in candidates if isinstance(item, dict))


def duration_guidance(estimated_sec: float, source: str, config: dict) -> dict:
    min_sec = safe_float(config.get("min_duration_sec"), 60.0)
    max_sec = safe_float(config.get("max_duration_sec"), 160.0)
    status = "ok"
    message = "duration within guide"
    if estimated_sec > max_sec:
        status = "warn"
        message = f"추정 총 길이 {round(estimated_sec, 3)}초가 상한 {round(max_sec, 3)}초를 초과합니다."
    elif 0 < estimated_sec < min_sec:
        status = "warn"
        message = f"추정 총 길이 {round(estimated_sec, 3)}초가 하한 {round(min_sec, 3)}초보다 짧습니다."
    return {
        "status": status,
        "source": source,
        "estimated_total_sec": round(estimated_sec, 3),
        "min_duration_sec": min_sec,
        "max_duration_sec": max_sec,
        "message": message,
    }


def compact_movie_title(value: str) -> str:
    text = normalize_text(value)
    text = re.sub(r"[\U00010000-\U0010ffff]", " ", text)
    text = normalize_text(text)
    if not text or GENERIC_TITLE_RE.match(text):
        return ""
    text = re.sub(r"\b(official|hd|4k|movie|film|clip|scene|moment|shorts?)\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text).strip(" -–—|:,.!")
    if len(text) < 3 or len(text.split()) > 8:
        return ""
    return text


def infer_explicit_movie_title(source_info: dict, manual_title: str = "") -> dict:
    if normalize_text(manual_title):
        return {"status": "known", "title_en": normalize_text(manual_title), "source": "manual"}

    title = normalize_text(source_info.get("title"))
    description = normalize_text(source_info.get("description") or source_info.get("fulltitle"))
    tags = [normalize_text(tag) for tag in source_info.get("tags", []) if normalize_text(tag)] if isinstance(source_info.get("tags"), list) else []
    search_text = " ".join([title, description, " ".join(tags)])

    separators = [" - ", " | ", " – ", " — ", ": "]
    for separator in separators:
        if separator in title:
            left = compact_movie_title(title.split(separator, 1)[0])
            if left:
                return {"status": "known", "title_en": left, "source": "title_prefix"}

    quoted = re.search(r"[\"'“”‘’]([A-Z][A-Za-z0-9:,'&.\- ]{2,80})[\"'“”‘’]", search_text)
    if quoted:
        candidate = compact_movie_title(quoted.group(1))
        if candidate:
            return {"status": "known", "title_en": candidate, "source": "quoted_metadata"}

    hashtag_candidates = [compact_movie_title(match.group(1)) for match in MOVIE_HASHTAG_RE.finditer(search_text)]
    hashtag_candidates = [item for item in hashtag_candidates if item]
    if hashtag_candidates:
        return {"status": "known", "title_en": hashtag_candidates[0], "source": "hashtag"}

    return {"status": "unknown", "title_en": "", "source": "none"}


def metadata_scene_signal(source_info: dict) -> dict:
    title = normalize_text(source_info.get("title"))
    description = normalize_text(source_info.get("description") or source_info.get("fulltitle"))
    tags = " ".join(normalize_text(tag) for tag in source_info.get("tags", []) if normalize_text(tag)) if isinstance(source_info.get("tags"), list) else ""
    haystack = " ".join([title, description[:1200], tags])
    match = SCENE_CLUE_RE.search(haystack)
    return {"passes": bool(match), "matched": match.group(0) if match else ""}


def build_decision(source_info: dict, transcript: dict, manual_movie_title: str = "", edit_plan=None, tts_manifest=None) -> dict:
    duration = metadata_duration(source_info, transcript)
    speech = transcript_metrics(transcript, duration)
    identity = infer_explicit_movie_title(source_info, manual_movie_title)
    scene_signal = metadata_scene_signal(source_info)
    duration_config = load_duration_config()
    duration_estimate = estimate_duration_from_tts_manifest(tts_manifest)
    duration_source = "tts_manifest"
    if duration_estimate <= 0:
        duration_estimate = estimate_duration_from_edit_plan(edit_plan)
        duration_source = "edit_plan"
    duration_check = duration_guidance(duration_estimate, duration_source, duration_config) if duration_estimate > 0 else {
        "status": "not_checked",
        "source": "none",
        "estimated_total_sec": 0.0,
        "min_duration_sec": duration_config["min_duration_sec"],
        "max_duration_sec": duration_config["max_duration_sec"],
        "message": "edit_plan 또는 TTS manifest가 없어 draft 길이 추정 검사를 건너뜁니다.",
    }
    warnings = [duration_check["message"]] if duration_check.get("status") == "warn" else []
    failures = []
    if not speech["passes"]:
        failures.append({
            "code": "DIALOGUE_INSUFFICIENT",
            "message": "대사 부족 소재: STT utterance 수 또는 총 발화 비율이 기준 미달입니다.",
        })
    if identity["status"] == "unknown":
        failures.append({
            "code": "MOVIE_TITLE_UNKNOWN",
            "message": "영화 제목 확인 실패: 영화 제목 입력 또는 소재 교체가 필요합니다.",
        })
    if not scene_signal["passes"]:
        failures.append({
            "code": "SCENE_SIGNAL_MISSING",
            "message": "메타데이터가 대사 장면 클립임을 충분히 시사하지 않습니다.",
        })
    return {
        "status": "pass" if not failures else "fail",
        "source": {
            "id": source_info.get("id") or source_info.get("display_id") or "",
            "title": normalize_text(source_info.get("title")),
            "webpage_url": normalize_text(source_info.get("webpage_url") or source_info.get("original_url")),
        },
        "criteria": {
            "min_utterances": MIN_UTTERANCES,
            "min_speech_ratio": MIN_SPEECH_RATIO,
            "requires_explicit_movie_title": True,
            "requires_scene_metadata_signal": True,
        },
        "speech": speech,
        "movie_identity_pre_gemini": identity,
        "scene_metadata_signal": scene_signal,
        "duration_guidance": duration_check,
        "warnings": warnings,
        "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run midform material pre-flight gate before Gemini.")
    parser.add_argument("--source-info", required=True, type=Path)
    parser.add_argument("--transcript", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--movie-title", default="", help="Manual movie title override when metadata is explicit to the operator but not machine-readable.")
    parser.add_argument("--edit-plan", default="", help="Optional edit_plan.json for non-blocking duration warning.")
    parser.add_argument("--tts-manifest", default="", help="Optional TTS manifest/result JSON for measured duration warning.")
    args = parser.parse_args()

    source_info = load_json(args.source_info)
    transcript = load_json(args.transcript)
    decision = build_decision(
        source_info,
        transcript,
        args.movie_title,
        load_optional_json(args.edit_plan),
        load_optional_json(args.tts_manifest),
    )
    write_json(args.output, decision)
    print(json.dumps({
        "status": decision["status"],
        "output": str(args.output),
        "failures": [failure["code"] for failure in decision["failures"]],
        "utterance_count": decision["speech"]["utterance_count"],
        "speech_ratio": decision["speech"]["speech_ratio"],
        "movie_title": decision["movie_identity_pre_gemini"]["title_en"],
    }, ensure_ascii=False))
    return 0 if decision["status"] == "pass" else 2


if __name__ == "__main__":
    sys.exit(main())
