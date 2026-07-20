#!/usr/bin/env python3
"""Report slot-mode style and subtitle segmentation quality."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


ACTOR_REAL_NAMES = [
    "크리스 에반스",
    "제시카 알바",
    "이안 그루퍼드",
    "마이클 치클리스",
    "더그 존스",
    "로렌스 피시번",
    "줄리안 맥마흔",
    "Chris Evans",
    "Jessica Alba",
    "Ioan Gruffudd",
    "Michael Chiklis",
    "Doug Jones",
    "Laurence Fishburne",
    "Julian McMahon",
]
CHARACTER_NAMES = [
    "실버 서퍼",
    "수 스톰",
    "인비저블 우먼",
    "리드 리처즈",
    "미스터 판타스틱",
    "닥터 둠",
]
EVASIVE_MOVIE_LABELS = [
    "은빛 존재",
    "낯선 은빛 존재",
    "보라 망토의 영웅",
    "망토의 영웅",
    "여성 영웅",
    "검은 망토의 인물",
    "검은 망토의 남자",
    "어떤 존재",
    "무언가",
    "정체불명",
    "Sue",
]
CAMERA_TERMS = ["클로즈업", "컷", "전환", "장면", "프레임", "화면", "샷", "앵글"]
FORMAL_DIALOGUE_PATTERNS = ["습니까", "십시오", "합니다", "입니다", "했습니다"]
VISUAL_RELAY_VERBS = [
    "보다", "바라", "올려다", "내려다", "서 있", "앉", "걷", "뛰", "날아", "내려오",
    "다가", "돌", "움직", "가로질러", "스치", "배치", "발사", "튀", "쓰러", "멈췄",
    "깜빡", "흔들", "포위", "조준",
]
CONTEXT_LAYER_TERMS = [
    "왜", "정체", "동기", "이유", "선택", "파괴자", "판돈", "위협", "문제는", "그런데",
    "사실", "진짜", "갈락투스", "전령", "고향", "섬기는", "처지", "목적", "대가", "결국",
]
ALLOWED_MOVIE_CONTEXT_TERMS = ["갈락투스", "전령", "선택권", "선택", "파괴자", "묶인 처지", "고향", "경고", "더 큰 파괴자", "첫 대면", "시작에 불과"]
UNGROUNDED_EVENT_PATTERNS = [
    {"token": "손끝", "reason": "body-action not grounded in the verified clip", "always_forbidden": True},
    {"token": "전류", "reason": "electric counteraction not grounded in the verified clip", "always_forbidden": True},
    {"token": "스파크", "reason": "electric counteraction not grounded in the verified clip", "always_forbidden": True},
    {"token": "세 번", "reason": "specific count not grounded in this clip evidence", "always_forbidden": True},
    {"token": "문을 열", "reason": "invented reversal/device consequence", "always_forbidden": True},
    {"token": "착각", "reason": "invented reversal judgment", "always_forbidden": True},
    {"token": "줄을 조종", "reason": "future puppet-master certainty outside the clip", "always_forbidden": True},
    {"token": "곧 드러", "reason": "future plot certainty outside the clip", "always_forbidden": True},
    {"token": "다시 움직", "reason": "recovery after being shot/downed is not grounded in the verified clip", "always_forbidden": True},
    {"token": "다시 일어", "reason": "recovery/counterattack not grounded in the verified clip", "always_forbidden": True},
    {"token": "공중으로 일으", "reason": "invented recovery action", "always_forbidden": True},
    {"token": "보드를 붙잡아 다시", "reason": "invented recovery action", "always_forbidden": True},
    {"token": "반격", "reason": "counterattack not grounded unless source text states it"},
    {"token": "더 강한 장치", "reason": "invented device escalation", "always_forbidden": True},
    {"token": "패배를 버", "reason": "invented recovery/reversal after defeat", "always_forbidden": True},
    {"token": "사냥꾼", "reason": "future villain/threat framing not grounded in this clip", "always_forbidden": True},
    {"token": "다음엔 누가", "reason": "future plot certainty outside the clip", "always_forbidden": True},
]

AWKWARD_FINAL_WORDS = {
    "의", "은", "는", "이", "가", "을", "를", "와", "과", "에", "에서", "에게",
    "로", "으로", "만", "도", "부터", "까지", "처럼",
}
PREDICATE_RE = re.compile(r"(습니다|했습니다|됐습니다|됩니다|였습니다|였죠|했죠|이죠|죠|버렸습니다|막았습니다|흔들렸습니다|돌렸습니다|가까웠죠|반박했습니다)$")
SUBJECT_END_RE = re.compile(r"(이|가)$")
ADVERB_WORDS = {"잠깐", "바로", "다시", "이미", "즉시", "천천히", "결국", "정반대로"}


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def normalize_text(value) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def visible_len(text: str) -> int:
    return len(re.sub(r"\s+", "", text))


def split_sentences(text: str) -> list[str]:
    return [item.strip() for item in re.split(r"(?<=[.!?。！？])\s+", normalize_text(text)) if item.strip()]


def similarity_tokens(text: str) -> set[str]:
    return {
        word
        for word in re.sub(r"[.!?。！？,，]", " ", normalize_text(text)).split(" ")
        if len(word) >= 2 and word not in {"그리고", "그런데", "하지만", "이때", "문제는", "결국", "진짜"}
    }


def jaccard(left: str, right: str) -> float:
    a = similarity_tokens(left)
    b = similarity_tokens(right)
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def plain_da_ending(sentence: str) -> bool:
    text = re.sub(r"[\"'”’)]*$", "", sentence.strip())
    if not re.search(r"[가-힣]다[.!?。！？]?$", text):
        return False
    return not re.search(r"(습니|합니|됩니|입니|였습니|했습니|왔습니|갔습니|있습니|없습니)다[.!?。！？]?$", text)


def starts_like_visual_relay(sentence: str) -> bool:
    text = normalize_text(sentence)
    if not text:
        return False
    return bool(re.search(r"^(수 스톰|실버 서퍼|인비저블 우먼|리드 리처즈|미스터 판타스틱|벤 그리무|벤 그림|휴먼 토치|조니 스톰|닥터 둠|군인|군 병력|미사일|장치|보드|숲|나무|그는|그녀는|그가|그녀가).{0,24}(봤|바라|올려다|내려다|서|앉|걷|뛰|날아|내려|다가|돌|움직|발사|스치|쓰러|멈췄|깜빡|흔들|포위|조준)", text))


def is_screen_relay_sentence(sentence: str) -> bool:
    text = normalize_text(sentence)
    if not text:
        return False
    has_visual = any(token in text for token in VISUAL_RELAY_VERBS)
    has_context = any(token in text for token in CONTEXT_LAYER_TERMS)
    return has_visual and not has_context


def groundedness_log_for_segment(segment: dict) -> list[dict]:
    source_text = normalize_text(segment.get("scene_summary") or "")
    results = []
    for sentence in split_sentences(segment.get("narration") or ""):
        unsupported = [
            item for item in UNGROUNDED_EVENT_PATTERNS
            if item["token"] in sentence and (item.get("always_forbidden") or item["token"] not in source_text)
        ]
        context_hits = [token for token in ALLOWED_MOVIE_CONTEXT_TERMS if token in sentence]
        results.append({
            "segment_id": segment.get("segment_id"),
            "storytelling_role": segment.get("storytelling_role"),
            "sentence": sentence,
            "grounded": not unsupported,
            "evidence": "allowed_movie_context_or_source_fact" if context_hits else "slot_scene_summary_or_story_context",
            "context_hits": context_hits,
            "unsupported": unsupported,
        })
    return results


def closing_drip_present(narration_segments: list[dict]) -> bool:
    last = normalize_text((narration_segments[-1] if narration_segments else {}).get("narration"))
    return any(token in last for token in ["여러분", "그러니까", "이쯤 되면", "웃긴 건", "드립"])


def closing_drip_status(narration_segments: list[dict]) -> str:
    return "token_matched" if closing_drip_present(narration_segments) else "semantic_check_needed"


def load_srt_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig") if path.exists() else ""


def parse_srt_time(value: str) -> float:
    hours, minutes, rest = value.strip().replace(",", ".").split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(rest)


def parse_srt_entries(text: str) -> list[dict]:
    entries = []
    blocks = re.split(r"\n\s*\n", text.strip()) if text.strip() else []
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if len(lines) < 3 or "-->" not in lines[1]:
            continue
        start_raw, end_raw = [item.strip() for item in lines[1].split("-->", 1)]
        start = parse_srt_time(start_raw)
        end = parse_srt_time(end_raw)
        entries.append({"index": lines[0], "start": start, "end": end, "duration": end - start, "text": normalize_text(" ".join(lines[2:]))})
    return entries


def forbidden_boundary_split(left: str, right: str) -> str:
    left_words = normalize_text(left).split()
    right_words = normalize_text(right).split()
    if not left_words or not right_words:
        return ""
    last = left_words[-1].rstrip(",，")
    first = right_words[0].strip()
    right_text = normalize_text(right)
    if SUBJECT_END_RE.search(last) and PREDICATE_RE.search(right_text):
        return "subject_predicate_split"
    if last in ADVERB_WORDS and PREDICATE_RE.search(right_text):
        return "adverb_predicate_split"
    if last.endswith("가로채") and first.startswith("막"):
        return "auxiliary_verb_split"
    if last.endswith("의"):
        return "adnominal_noun_split"
    return ""


def segmentation_violations(entries: list[dict]) -> tuple[list[dict], list[dict]]:
    short_entries = [
        {"index": entry["index"], "duration": round(entry["duration"], 3), "text": entry["text"]}
        for entry in entries
        if entry["duration"] < 1.3 or visible_len(entry["text"]) < 5
    ]
    boundary_violations = []
    for left, right in zip(entries, entries[1:]):
        reason = forbidden_boundary_split(left["text"], right["text"])
        if reason:
            boundary_violations.append({"left_index": left["index"], "right_index": right["index"], "reason": reason, "left": left["text"], "right": right["text"]})
    return short_entries, boundary_violations


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--script", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--srt", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--content-type", default="movie_recap")
    args = parser.parse_args()

    script = load_json(args.script)
    manifest = load_json(args.manifest)
    srt_text = load_srt_text(args.srt)
    srt_entries = parse_srt_entries(srt_text)
    short_subtitle_units, forbidden_split_hits = segmentation_violations(srt_entries)

    narrations = [
        normalize_text(segment.get("narration"))
        for segment in script.get("segments", [])
        if segment.get("tts_enabled") is not False and normalize_text(segment.get("narration"))
    ]
    first_narration = narrations[0] if narrations else ""
    hook_sentence = split_sentences(first_narration)[0] if first_narration else ""
    hook_starts_as_visual_relay = starts_like_visual_relay(hook_sentence)
    narration_text = " ".join(narrations)
    sentences = split_sentences(narration_text)
    screen_relay_sentence_items = [sentence for sentence in sentences if is_screen_relay_sentence(sentence)]
    screen_relay_ratio = len(screen_relay_sentence_items) / len(sentences) if sentences else 0.0
    plain_da_count = sum(1 for sentence in sentences if plain_da_ending(sentence))
    plain_da_ratio = plain_da_count / len(sentences) if sentences else 0.0
    is_movie_recap = args.content_type == "movie_recap"
    real_name_hits = [name for name in ACTOR_REAL_NAMES if name in narration_text]
    evasive_label_hits = [label for label in EVASIVE_MOVIE_LABELS if label in narration_text] if is_movie_recap else []
    character_name_hits = [name for name in CHARACTER_NAMES if name in narration_text] if is_movie_recap else []
    camera_term_hits = [term for term in CAMERA_TERMS if term in narration_text]
    duplicate_events = []
    narration_segments = [
        {"segment_id": str(segment.get("segment_id") or ""), "narration": normalize_text(segment.get("narration"))}
        for segment in script.get("segments", [])
        if segment.get("tts_enabled") is not False and normalize_text(segment.get("narration"))
    ]
    for left_index, left in enumerate(narration_segments):
        for right in narration_segments[left_index + 1:]:
            score = jaccard(left["narration"], right["narration"])
            if score >= 0.55:
                duplicate_events.append({
                    "left": left["segment_id"],
                    "right": right["segment_id"],
                    "similarity": round(score, 3),
                })
    full_groundedness_log = []
    for segment in script.get("segments", []):
        if segment.get("tts_enabled") is not False and normalize_text(segment.get("narration")):
            full_groundedness_log.extend(groundedness_log_for_segment(segment))
    ungrounded_events = [item for item in full_groundedness_log if not item.get("grounded")]
    closing_drip_gate_status = closing_drip_status(narration_segments)
    has_closing_drip = closing_drip_gate_status == "token_matched"

    caption_units = manifest.get("caption_units") or []
    formal_dialogue_hits = []
    for segment in script.get("segments", []):
        if segment.get("tts_enabled") is not False:
            continue
        caption = normalize_text(segment.get("translated_caption_ko") or segment.get("caption_text"))
        hits = [token for token in FORMAL_DIALOGUE_PATTERNS if token in caption]
        if hits:
            formal_dialogue_hits.append({"segment_id": segment.get("segment_id"), "caption": caption, "hits": hits})
    overlong_units = []
    awkward_units = []
    for unit in caption_units:
        text = normalize_text(unit.get("text"))
        if not text:
            continue
        length = visible_len(text)
        if length > 26:
            overlong_units.append({"caption_id": unit.get("caption_id"), "text": text, "chars": length})
        words = text.split(" ")
        if len(words) >= 2 and not text.endswith((".", "!", "?", "。", "！", "？")) and words[-1] in AWKWARD_FINAL_WORDS:
            awkward_units.append({"caption_id": unit.get("caption_id"), "text": text})

    has_required_character_names = (not is_movie_recap) or bool(character_name_hits)
    report = {
        "status": "passed" if not real_name_hits and not evasive_label_hits and has_required_character_names and not camera_term_hits and not duplicate_events and plain_da_ratio <= 0.3 and not hook_starts_as_visual_relay and screen_relay_ratio <= 0.5 and not ungrounded_events and not formal_dialogue_hits and not overlong_units and not awkward_units and not forbidden_split_hits and not short_subtitle_units else "failed",
        "script": str(args.script),
        "manifest": str(args.manifest),
        "srt": str(args.srt),
        "hook_sentence": hook_sentence,
        "hook_starts_as_visual_relay": hook_starts_as_visual_relay,
        "sentences": len(sentences),
        "screen_relay_sentences": len(screen_relay_sentence_items),
        "screen_relay_ratio_pct": round(screen_relay_ratio * 100, 2),
        "screen_relay_examples": screen_relay_sentence_items[:5],
        "plain_da_endings": plain_da_count,
        "plain_da_ratio_pct": round(plain_da_ratio * 100, 2),
        "real_name_hits": real_name_hits,
        "evasive_label_hits": evasive_label_hits,
        "character_name_hits": character_name_hits,
        "camera_term_hits": camera_term_hits,
        "formal_dialogue_hits": formal_dialogue_hits,
        "duplicate_events": duplicate_events,
        "groundedness_status": "passed" if not ungrounded_events else "failed",
        "groundedness_log": full_groundedness_log,
        "ungrounded_events": ungrounded_events,
        "closing_drip_present": has_closing_drip,
        "closing_drip_status": closing_drip_gate_status,
        "caption_units": len(caption_units),
        "max_caption_chars_no_space": max([visible_len(normalize_text(unit.get("text"))) for unit in caption_units] or [0]),
        "overlong_units": overlong_units,
        "awkward_mid_phrase_units": awkward_units,
        "short_subtitle_units": short_subtitle_units,
        "forbidden_split_hits": forbidden_split_hits,
        "segmentation_status": "passed" if not short_subtitle_units and not forbidden_split_hits else "failed",
        "story_outline": script.get("story_outline"),
        "full_srt": srt_text,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "full_srt"}, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
