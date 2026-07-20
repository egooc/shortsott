#!/usr/bin/env python3
"""Build a fixed midform slot map from transcript, Gemini scenes, and usable ranges."""

import argparse
import json
import math
import re
import subprocess
from pathlib import Path


MIN_NARRATION_SLOT_SEC = 4.0
SPEECH_PAD_SEC = 0.05
EXCLUDED_SCENE_KEYWORDS = (
    "구독",
    "엔딩 화면",
    "다른 영상",
    "시청을 유도",
    "credit",
    "credits",
    "end screen",
)
WEAK_DIALOGUE_RE = re.compile(r"^(?:ha+|h+a+h+a+|하+하+|허+허+|음+|어+|오+|아+|와+|헉+|뭐+|왜+|그래+|그랬냐|are you\??|you\??|huh\??|uh+|oh+|ah+)[.!?\s]*$", re.IGNORECASE)
FOREIGN_MISRECOGNITION_RE = re.compile(r"\b(?:je|j['’]|c['’]est|n['’]a|l['’]aime)\b|(?:-[a-z]){2,}", re.IGNORECASE)
HIGH_CONFIDENCE_SCORE = 120
DIALOGUE_HEAVY_RATIO = 0.5
DIALOGUE_HEAVY_MIN_OUTPUT_SEC = 60.0
DIALOGUE_HEAVY_MIN_TARGET_RATIO = 0.5
DIALOGUE_HEAVY_MAX_TARGET_RATIO = 0.8
DIALOGUE_HEAVY_NARRATION_BUDGET = (0.62, 0.88)
QUOTE_SENTENCE_RE = re.compile(r"[^.!?]+[.!?]?")


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def ffprobe_duration(path):
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def normalize_ranges(ranges, duration):
    out = []
    for item in ranges or []:
        if isinstance(item, dict):
            start = float(item.get("start", item.get("start_sec", 0)))
            end = float(item.get("end", item.get("end_sec", 0)))
            reason = str(item.get("reason", item.get("label", "excluded")))
        else:
            start = float(item[0])
            end = float(item[1])
            reason = str(item[2]) if len(item) > 2 else "excluded"
        start = max(0.0, min(duration, start))
        end = max(0.0, min(duration, end))
        if end > start:
            out.append([round(start, 3), round(end, 3), reason])
    out.sort(key=lambda row: (row[0], row[1]))
    return out


def merge_ranges(ranges):
    merged = []
    for start, end, reason in sorted(ranges, key=lambda row: (row[0], row[1])):
        if not merged or start > merged[-1][1] + 0.001:
            merged.append([start, end, reason])
        else:
            merged[-1][1] = max(merged[-1][1], end)
            if reason not in merged[-1][2]:
                merged[-1][2] += f"+{reason}"
    return [[round(a, 3), round(b, 3), r] for a, b, r in merged]


def subtract_ranges(base_ranges, blocked_ranges):
    available = []
    blocked = merge_ranges(blocked_ranges)
    for base_start, base_end, _reason in base_ranges:
        cursor = base_start
        for block_start, block_end, _block_reason in blocked:
            if block_end <= cursor:
                continue
            if block_start >= base_end:
                break
            if block_start > cursor + 0.001:
                available.append([cursor, min(block_start, base_end), "usable"])
            cursor = max(cursor, block_end)
            if cursor >= base_end:
                break
        if cursor < base_end - 0.001:
            available.append([cursor, base_end, "usable"])
    return [[round(a, 3), round(b, 3), r] for a, b, r in available if b - a > 0.05]


def usable_ranges_from_map(usable_map, duration):
    if not usable_map:
        return [[0.0, round(duration, 3), "usable"]], []
    excluded = normalize_ranges(usable_map.get("excluded_ranges") or usable_map.get("unusable_ranges") or [], duration)
    if usable_map.get("usable_ranges"):
        usable = normalize_ranges(usable_map.get("usable_ranges"), duration)
    else:
        usable = subtract_ranges([[0.0, duration, "source"]], excluded)
    return usable, excluded


def transcript_utterances(transcript, duration):
    utterances = []
    for item in transcript.get("utterances", []):
        utt_id = str(item.get("utt_id", "")).strip()
        start = float(item.get("start", 0))
        end = float(item.get("end", 0))
        text = str(item.get("text", "")).strip()
        if utt_id and end > start and start < duration:
            words = []
            raw_words = item.get("words", []) if isinstance(item.get("words"), list) else []
            for word in raw_words:
                try:
                    word_start = float(word.get("start"))
                    word_end = float(word.get("end"))
                except (TypeError, ValueError):
                    continue
                token = str(word.get("word") or "").strip()
                if token and word_end >= word_start:
                    words.append({"word": token, "start": max(0.0, word_start), "end": min(duration, word_end)})
            utterances.append({"utt_id": utt_id, "start": max(0.0, start), "end": min(duration, end), "text": text, "words": words})
    utterances.sort(key=lambda row: (row["start"], row["end"]))
    return utterances


def eojeol_count(text):
    return len([word for word in re.split(r"\s+", str(text or "").strip()) if word])


def dialogue_filter_reason(utterance, score, source_duration):
    text = str(utterance.get("text") or "").strip()
    text_lower = text.lower()
    duration = float(utterance.get("end", 0)) - float(utterance.get("start", 0))
    if not text:
        return "empty_text"
    if FOREIGN_MISRECOGNITION_RE.search(text):
        return "foreign_misrecognition_dialogue"
    if WEAK_DIALOGUE_RE.match(text):
        return "weak_laughter_or_interjection_only"
    words = [word for word in re.split(r"\s+", text) if word]
    if len(words) <= 5 and ("ha" in text_lower or "하" in text) and re.search(r"\b(?:are|you|huh|uh|oh)\b|[??!]", text_lower):
        return "weak_laughter_or_taunt_fragment"
    if duration < 0.5:
        return "too_short_duration"
    if source_duration > 0 and utterance.get("start", 0) >= source_duration * 0.9 and eojeol_count(text) < 3:
        return "late_short_utterance_default_excluded"
    if eojeol_count(text) < 3 and score < HIGH_CONFIDENCE_SCORE:
        return "short_low_confidence_dialogue"
    return ""


def scene_for_range(scenes, start, end):
    midpoint = (start + end) / 2
    overlaps = []
    for scene in scenes:
        scene_start = float(scene.get("start_sec", 0))
        scene_end = float(scene.get("end_sec", 0))
        overlap = min(end, scene_end) - max(start, scene_start)
        if overlap > 0:
            overlaps.append((overlap, scene))
    if overlaps:
        overlaps.sort(key=lambda row: row[0], reverse=True)
        return overlaps[0][1]
    candidates = [scene for scene in scenes if float(scene.get("start_sec", 0)) <= midpoint <= float(scene.get("end_sec", 0))]
    return candidates[0] if candidates else {}


def scene_summary_for_range(scenes, start, end):
    summaries = []
    scene_ids = []
    for scene in scenes:
        scene_start = float(scene.get("start_sec", 0))
        scene_end = float(scene.get("end_sec", 0))
        if min(end, scene_end) - max(start, scene_start) <= 0:
            continue
        scene_id = str(scene.get("scene_id", "")).strip()
        summary = str(scene.get("visible_action") or scene.get("recap_bridge_before") or "").strip()
        if scene_id:
            scene_ids.append(scene_id)
        if summary and summary not in summaries:
            summaries.append(summary)
    return " / ".join(summaries) if summaries else "비발화 장면", scene_ids


def scene_shot_types_for_range(scenes, start, end):
    shot_types = []
    for scene in scenes:
        scene_start = float(scene.get("start_sec", 0))
        scene_end = float(scene.get("end_sec", 0))
        if min(end, scene_end) - max(start, scene_start) <= 0:
            continue
        shot_type = str(scene.get("shot_type") or "").strip()
        if shot_type and shot_type not in shot_types:
            shot_types.append(shot_type)
    return shot_types


def quote_sentence_spans(utterance):
    text = str(utterance.get("text") or "").strip()
    words = utterance.get("words") or []
    if not text or not words:
        return [{"text": text, "start": utterance["start"], "end": utterance["end"]}]
    spans = []
    word_index = 0
    for match in QUOTE_SENTENCE_RE.finditer(text):
        sentence = match.group(0).strip()
        sentence_words = [word for word in re.split(r"\s+", sentence) if word]
        if not sentence_words:
            continue
        start_word_index = min(word_index, len(words) - 1)
        end_word_index = min(len(words) - 1, start_word_index + len(sentence_words) - 1)
        spans.append({
            "text": sentence,
            "start": float(words[start_word_index]["start"]),
            "end": float(words[end_word_index]["end"]),
        })
        word_index = end_word_index + 1
    return [span for span in spans if span["text"] and span["end"] > span["start"]] or [{"text": text, "start": utterance["start"], "end": utterance["end"]}]


def quote_rationale(text, scene):
    lowered = str(text or "").lower()
    if "ain't got to like you" in lowered or "got to like you" in lowered:
        return "장면의 주제를 관통하는 펀치라인: 사랑이 아니라 책임이라는 아버지의 논리를 드러낸다."
    if "how come" in lowered and "like me" in lowered:
        return "아들이 사랑받고 싶은 마음을 직접 묻는 감정 출발점이다."
    if "because you like me" in lowered:
        return "아들이 붙잡고 싶은 기대를 한 문장으로 보여주는 반전 직전 대사다."
    if "responsibility" in lowered or "take care" in lowered:
        return "아버지가 애정보다 의무를 앞세우는 갈등의 핵심 근거다."
    if "worrying about whether somebody like you" in lowered:
        return "아버지의 냉혹한 인생관이 정리되는 마무리 철학이다."
    function = str(scene.get("dialogue_function") or "").replace("_", " ")
    return f"{function or '감정 피크'} 대사로 장면의 갈등을 선명하게 압축한다."


def score_quote_candidate(text, scene, duration):
    lowered = str(text or "").lower()
    score = 0
    if scene.get("should_preserve_original_dialogue") is True:
        score += 80
    score += {"high": 45, "medium": 18, "low": 5}.get(str(scene.get("dialogue_importance", "")).lower(), 0)
    score += {"turning_point": 55, "character_emotion": 35, "confession": 35, "threat": 25, "setup": 20, "exposition": 18}.get(str(scene.get("dialogue_function", "")).lower(), 0)
    if "ain't got to like you" in lowered:
        score += 120
    if "how come" in lowered and "like me" in lowered:
        score += 90
    if "because you like me" in lowered:
        score += 75
    if "responsibility" in lowered or "take care" in lowered:
        score += 70
    if "worrying about whether somebody like you" in lowered:
        score += 55
    if 1.0 <= duration <= 6.0:
        score += 25
    elif duration > 9.0:
        score -= 35
    if str(scene.get("shot_type", "")).lower() == "close_up":
        score += 10
    return score


def select_signature_quotes(utterances, scenes):
    candidates = []
    for utterance in utterances:
        scene = scene_for_range(scenes, utterance["start"], utterance["end"])
        for span in quote_sentence_spans(utterance):
            text = span["text"]
            duration = span["end"] - span["start"]
            if eojeol_count(text) < 3 or duration < 0.6:
                continue
            score = score_quote_candidate(text, scene, duration)
            candidates.append({
                "utt_id": utterance["utt_id"],
                "source_range": [round(span["start"], 3), round(span["end"], 3)],
                "duration": round(duration, 3),
                "caption_source_text": text,
                "scene_id": str(scene.get("scene_id", "")),
                "scene_summary": f"{str(scene.get('visible_action', '')).strip()} / 명대사: {text}",
                "score": round(score, 3),
                "rationale": quote_rationale(text, scene),
                "shot_type": str(scene.get("shot_type", "")),
            })
    candidates.sort(key=lambda item: (-item["score"], item["source_range"][0]))
    selected = []
    used_utterances = set()
    ordered = [item for item in candidates if "ain't got to like you" in item["caption_source_text"].lower()] + candidates
    for item in ordered:
        if len(selected) >= 4:
            break
        if item["utt_id"] in used_utterances and len(selected) >= 2:
            continue
        if any(abs(item["source_range"][0] - other["source_range"][0]) < 0.2 for other in selected):
            continue
        selected.append(item)
        used_utterances.add(item["utt_id"])
    selected.sort(key=lambda item: item["source_range"][0])
    return selected[:4], candidates


def dialogue_heavy_narration_slot(start, end, scenes, role, min_duration=None):
    summary, scene_ids = scene_summary_for_range(scenes, start, end)
    duration = max(end - start, float(min_duration or 0))
    shot_types = scene_shot_types_for_range(scenes, start, end)
    lip_sync_risk = "close_up" in {item.lower() for item in shot_types}
    return {
        "type": "narration",
        "source_range": [round(start, 3), round(end, 3)],
        "duration": round(end - start, 3),
        "scene_summary": summary,
        "scene_ids": scene_ids,
        "tts_budget_sec": [round(max(8.0, duration * DIALOGUE_HEAVY_NARRATION_BUDGET[0]), 3), round(max(10.0, duration * DIALOGUE_HEAVY_NARRATION_BUDGET[1]), 3)],
        "require_min_chars": True,
        "narration_background": True,
        "source_audio_ducking": 0.3,
        "lip_sync_risk": lip_sync_risk,
        "shot_types": shot_types,
        "dialogue_heavy_role": role,
    }


def build_dialogue_heavy_slot_map(utterances, scenes, usable_ranges, excluded_ranges, source_duration, total_speech_duration, speech_ratio):
    selected_quotes, quote_candidates = select_signature_quotes(utterances, scenes)
    events = []
    cursor = usable_ranges[0][0] if usable_ranges else 0.0
    for quote_index, quote in enumerate(selected_quotes):
        quote_start, quote_end = quote["source_range"]
        if quote_start - cursor >= MIN_NARRATION_SLOT_SEC:
            role = "hook" if not events else "bridge"
            events.append(dialogue_heavy_narration_slot(cursor, quote_start, scenes, role))
        events.append({
            "type": "dialogue",
            "utt_id": quote["utt_id"],
            "source_range": quote["source_range"],
            "duration": quote["duration"],
            "caption_source_text": quote["caption_source_text"],
            "needs_translation": True,
            "scene_id": quote["scene_id"],
            "scene_summary": quote["scene_summary"],
            "quote_selection": {"rank": quote_index + 1, "score": quote["score"], "rationale": quote["rationale"], "shot_type": quote["shot_type"]},
        })
        cursor = quote_end
    end_target = min(source_duration, max(source_duration * 0.72, (selected_quotes[-1]["source_range"][1] + 18) if selected_quotes else source_duration * 0.72))
    if end_target - cursor >= MIN_NARRATION_SLOT_SEC:
        events.append(dialogue_heavy_narration_slot(cursor, end_target, scenes, "payoff"))
    events.sort(key=lambda row: (row["source_range"][0], row["source_range"][1], 0 if row["type"] == "narration" else 1))
    for index, event in enumerate(events, start=1):
        event["slot_id"] = f"s{index:02d}"
    total_estimate = sum(slot["duration"] if slot["type"] == "dialogue" else sum(slot["tts_budget_sec"]) / 2 for slot in events)
    fit_failures = []
    if len(selected_quotes) < 2:
        fit_failures.append("SIGNATURE_QUOTES_INSUFFICIENT")
    if total_estimate < DIALOGUE_HEAVY_MIN_OUTPUT_SEC:
        fit_failures.append("ESTIMATED_OUTPUT_UNDER_60_SEC")
    selected_ids = {item["utt_id"] for item in selected_quotes}
    return {
        "source_duration_sec": round(source_duration, 6),
        "composition_mode": "dialogue_heavy_signature_quotes",
        "composition_mode_reason": "speech ratio exceeds 50%; select only 2-4 signature quotes and convert remaining dialogue-heavy ranges into narrated background",
        "speech_duration_sec": round(total_speech_duration, 3),
        "speech_ratio": round(speech_ratio, 4),
        "dialogue_heavy_mode": True,
        "target_output_sec": [round(max(DIALOGUE_HEAVY_MIN_OUTPUT_SEC, source_duration * DIALOGUE_HEAVY_MIN_TARGET_RATIO), 3), round(source_duration * DIALOGUE_HEAVY_MAX_TARGET_RATIO, 3)],
        "material_fit": {"status": "pass" if not fit_failures else "fail", "failures": fit_failures},
        "narration_strategy": {"max_narration_slots": 5, "roles": ["hook", "bridge", "payoff"], "instruction": "명대사 2~4개만 원음으로 살리고, 나머지 대사 구간은 원음 0.3 덕킹 아래 나레이션 배경으로 사용한다."},
        "selected_signature_quotes": [{"rank": index + 1, "utt_id": quote["utt_id"], "source_range": quote["source_range"], "text": quote["caption_source_text"], "rationale": quote["rationale"], "score": quote["score"]} for index, quote in enumerate(selected_quotes)],
        "quote_candidate_count": len(quote_candidates),
        "slots": events,
        "excluded_ranges": merge_ranges(excluded_ranges + [[u["start"], u["end"], "unselected_dialogue_as_narration_background"] for u in utterances if u["utt_id"] not in selected_ids]),
        "excluded_dialogue_utterances": [{"utt_id": u["utt_id"], "source_range": [round(u["start"], 3), round(u["end"], 3)], "text": u["text"], "reason": "not_selected_signature_quote_background_allowed"} for u in utterances if u["utt_id"] not in selected_ids],
        "total_output_estimate_sec": round(total_estimate, 3),
        "dialogue_selected_duration_sec": round(sum(slot["duration"] for slot in events if slot["type"] == "dialogue"), 3),
    }


def excluded_ranges_from_scenes(scenes, duration):
    excluded = []
    for scene in scenes:
        text = " ".join(
            str(scene.get(key) or "")
            for key in ["visible_action", "dialogue_or_caption", "vertical_crop_note"]
        ).lower()
        if not any(keyword.lower() in text for keyword in EXCLUDED_SCENE_KEYWORDS):
            continue
        start = max(0.0, min(duration, float(scene.get("start_sec", 0))))
        end = max(0.0, min(duration, float(scene.get("end_sec", 0))))
        if end > start:
            excluded.append([round(start, 3), round(end, 3), "excluded_end_screen_or_static"])
    return excluded


def select_dialogue_utterances(utterances, scenes, output_estimate_without_dialogue, source_duration):
    scored = []
    excluded = []
    for utterance in utterances:
        scene = scene_for_range(scenes, utterance["start"], utterance["end"])
        score = 0
        if scene.get("should_preserve_original_dialogue") is True:
            score += 100
        importance = str(scene.get("dialogue_importance", "")).lower()
        score += {"high": 60, "medium": 25, "low": 5}.get(importance, 0)
        function = str(scene.get("dialogue_function", "")).lower()
        score += {"turning_point": 40, "character_emotion": 35, "confession": 35, "threat": 30, "setup": 20, "exposition": 15}.get(function, 0)
        duration = utterance["end"] - utterance["start"]
        text_lower = utterance["text"].lower()
        if any(keyword in text_lower for keyword in ["problem", "choice", "destroy", "destroyer", "tough"]):
            score += 45
        if any(keyword in text_lower for keyword in ["open fire", "roger", "reed?", "go back"]):
            score -= 50
        if duration < 0.5:
            score -= 100
        reason = dialogue_filter_reason(utterance, score, source_duration)
        if reason:
            excluded.append({
                "utt_id": utterance["utt_id"],
                "source_range": [round(utterance["start"], 3), round(utterance["end"], 3)],
                "text": utterance["text"],
                "score": round(score, 3),
                "reason": reason,
            })
            continue
        scored.append((score, duration, utterance, str(scene.get("scene_id", ""))))
    scored.sort(key=lambda row: (-row[0], row[2]["start"]))
    selected = []
    selected_duration = 0.0
    selected_per_scene = {}
    # Final ratio is dialogue / (narration_estimate + dialogue). To reach
    # 25-40% final share, dialogue should be roughly 0.34-0.66x narration.
    min_dialogue = max(10.0, output_estimate_without_dialogue * 0.34)
    max_dialogue = max(min_dialogue, output_estimate_without_dialogue * 0.66)
    for score, duration, utterance, scene_id in scored:
        if score < 75:
            continue
        if selected_per_scene.get(scene_id, 0) >= 4:
            continue
        if selected and selected_duration + duration > max_dialogue:
            continue
        selected.append(utterance["utt_id"])
        selected_duration += duration
        selected_per_scene[scene_id] = selected_per_scene.get(scene_id, 0) + 1
    if selected_duration < min_dialogue:
        for score, duration, utterance, scene_id in scored:
            if utterance["utt_id"] in selected or score < 30 or duration < 0.5:
                continue
            if selected_duration + duration > max_dialogue:
                continue
            selected.append(utterance["utt_id"])
            selected_duration += duration
            if selected_duration >= min_dialogue:
                break
    if not selected and scored:
        selected.append(scored[0][2]["utt_id"])
    selected_set = set(selected)
    for score, _duration, utterance, _scene_id in scored:
        if utterance["utt_id"] in selected_set:
            continue
        excluded.append({
            "utt_id": utterance["utt_id"],
            "source_range": [round(utterance["start"], 3), round(utterance["end"], 3)],
            "text": utterance["text"],
            "score": round(score, 3),
            "reason": "not_selected_by_dialogue_budget_or_score",
        })
    excluded.sort(key=lambda row: (row["source_range"][0], row["utt_id"]))
    return selected_set, excluded


def build_slot_map(transcript, gemini, usable_map, source_duration):
    scenes = list(gemini.get("scenes", []))
    usable_ranges, excluded_ranges = usable_ranges_from_map(usable_map, source_duration)
    scene_excluded_ranges = excluded_ranges_from_scenes(scenes, source_duration)
    if scene_excluded_ranges:
        excluded_ranges = merge_ranges(excluded_ranges + scene_excluded_ranges)
        usable_ranges = subtract_ranges(usable_ranges, scene_excluded_ranges)
    utterances = transcript_utterances(transcript, source_duration)
    total_speech_duration = sum(max(0.0, u["end"] - u["start"]) for u in utterances)
    speech_ratio = total_speech_duration / source_duration if source_duration > 0 else 0.0
    dialogue_heavy = speech_ratio > DIALOGUE_HEAVY_RATIO
    if dialogue_heavy:
        return build_dialogue_heavy_slot_map(utterances, scenes, usable_ranges, excluded_ranges, source_duration, total_speech_duration, speech_ratio)
    speech_blocks = [[max(0.0, u["start"] - SPEECH_PAD_SEC), min(source_duration, u["end"] + SPEECH_PAD_SEC), "speech_block"] for u in utterances]
    narration_ranges = subtract_ranges(usable_ranges, speech_blocks)
    narration_ranges = [row for row in narration_ranges if row[1] - row[0] >= MIN_NARRATION_SLOT_SEC]
    output_estimate_without_dialogue = sum((end - start) * 0.85 for start, end, _ in narration_ranges)
    selected_dialogue_ids, excluded_dialogue_utterances = select_dialogue_utterances(utterances, scenes, output_estimate_without_dialogue, source_duration)

    events = []
    for start, end, _ in narration_ranges:
        summary, scene_ids = scene_summary_for_range(scenes, start, end)
        duration = end - start
        events.append(
            {
                "type": "narration",
                "source_range": [round(start, 3), round(end, 3)],
                "duration": round(duration, 3),
                "scene_summary": summary,
                "scene_ids": scene_ids,
                "tts_budget_sec": [round(duration * 0.75, 3), round(duration * 0.95, 3)],
            }
        )
    for utterance in utterances:
        if utterance["utt_id"] not in selected_dialogue_ids:
            continue
        scene = scene_for_range(scenes, utterance["start"], utterance["end"])
        events.append(
            {
                "type": "dialogue",
                "utt_id": utterance["utt_id"],
                "source_range": [round(utterance["start"], 3), round(utterance["end"], 3)],
                "duration": round(utterance["end"] - utterance["start"], 3),
                "caption_source_text": utterance["text"],
                "needs_translation": True,
                "scene_id": str(scene.get("scene_id", "")),
                "scene_summary": f"{str(scene.get('visible_action', '')).strip()} / 발화: {utterance['text']}",
            }
        )
    events.sort(key=lambda row: (row["source_range"][0], row["source_range"][1], 0 if row["type"] == "narration" else 1))
    slots = []
    for index, event in enumerate(events, start=1):
        event["slot_id"] = f"s{index:02d}"
        slots.append(event)
    total_estimate = 0.0
    for slot in slots:
        if slot["type"] == "dialogue":
            total_estimate += slot["duration"]
        else:
            total_estimate += sum(slot["tts_budget_sec"]) / 2
    return {
        "source_duration_sec": round(source_duration, 6),
        "composition_mode": "dialogue_heavy" if dialogue_heavy else "hybrid_standard",
        "composition_mode_reason": "transcript speech ratio exceeds 50%; dialogue carries the story and narration should act as hook/bridge/payoff frame" if dialogue_heavy else "standard hybrid source balance",
        "speech_duration_sec": round(total_speech_duration, 3),
        "speech_ratio": round(speech_ratio, 4),
        "dialogue_heavy_mode": dialogue_heavy,
        "narration_strategy": {
            "max_narration_slots": 3 if dialogue_heavy else None,
            "roles": ["hook", "bridge", "payoff"] if dialogue_heavy else ["hook", "setup", "bridge", "payoff"],
            "instruction": "대사가 스토리를 끌고 가므로 나레이션은 도입, 전환 1개, 마무리 액자만 담당한다." if dialogue_heavy else "나레이션과 대사를 균형 있게 연결한다.",
        },
        "slots": slots,
        "excluded_ranges": merge_ranges(excluded_ranges + [[u["start"], u["end"], "unselected_speech"] for u in utterances if u["utt_id"] not in selected_dialogue_ids]),
        "excluded_dialogue_utterances": excluded_dialogue_utterances,
        "total_output_estimate_sec": round(total_estimate, 3),
        "dialogue_selected_duration_sec": round(sum(slot["duration"] for slot in slots if slot["type"] == "dialogue"), 3),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--transcript", required=True)
    parser.add_argument("--gemini", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--usable-map", default="")
    parser.add_argument("--source-video", default="")
    args = parser.parse_args()

    transcript = load_json(args.transcript)
    gemini = load_json(args.gemini)
    usable_map = load_json(args.usable_map) if args.usable_map else None
    duration = float(transcript.get("source_duration") or gemini.get("source", {}).get("duration_sec") or 0)
    if args.source_video:
        try:
            duration = ffprobe_duration(args.source_video)
        except Exception:
            pass
    slot_map = build_slot_map(transcript, gemini, usable_map, duration)
    write_json(args.output, slot_map)
    print(json.dumps({"slots": len(slot_map["slots"]), "total_output_estimate_sec": slot_map["total_output_estimate_sec"], "composition_mode": slot_map.get("composition_mode"), "speech_ratio": slot_map.get("speech_ratio")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
