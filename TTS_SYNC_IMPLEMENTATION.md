# TTS / 자막 / 화면 싱크 구현 레퍼런스

이 문서는 midform 파이프라인에서 이미 동작 중인 **TTS-자막-화면 3자 싱크** 구현을 공정 쇼츠 메인 레포로 이식 판단할 수 있도록 추출한 실물 레퍼런스다. 런타임 코드는 수정하지 않았고, 실제 파일/라인 기준으로만 정리했다.

## 결론 요약

midform의 핵심 구조는 다음과 같다.

1. **단일 진실은 `captionUnits`다.** `draft_content.json`의 자막 텍스트는 `captionUnits[].text`에서만 나온다.
2. **TTS 문장과 화면 자막은 분리 가능하지만 연결 키가 고정된다.** `ttsFiles[].caption_id`는 문장 TTS 단위이고, `captionUnits[].tts_caption_id`가 그 문장 오디오를 참조한다.
3. **오디오는 연속 배치된다.** `current_time_us`가 모든 TTS/비TTS 구간의 타임라인 시작점을 결정한다.
4. **자막은 오디오 타임라인을 상속한다.** 한 TTS 문장이 여러 자막 조각으로 쪼개지면, 해당 문장 오디오 길이를 글자 수 가중치로 비례 분배한다.
5. **영상은 TTS 타임라인에 맞춰진다.** 소스 클립을 트림/속도 조정/반복 패딩해서 각 segment의 `tts_duration_us`와 영상 배치 길이를 맞춘다.

---

## 1. 자막 트랙 생성의 단일 진실 구조

### 1.1 현재 sealed slot pipeline의 단일 진실

활성 midform slot pipeline에서는 `midform/scripts/assemble_slot_draft_input.py`가 `script.segments`에서 **두 산출물**을 만든다.

- `tts_units`: 실제 TTS mp3 생성 단위. 보통 문장 단위.
- `caption_units`: 화면 자막 표시 단위. 보통 더 짧은 caption chunk 단위.

두 구조는 `sentence_id` / `tts_caption_id`로 연결된다.

실제 코드: `midform/scripts/assemble_slot_draft_input.py:529-583`

```python
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
                        "source_segment_order": segment_index,
                    }
                )
                chunks = merge_short_units(split_caption_text(sentence), segment=segment)
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
                            "text": chunk,
                            "source_segment_order": segment_index,
                        }
                    )
        else:
            chunks = merge_short_units(split_caption_text(text), segment=segment)
            for order, chunk in enumerate(chunks, start=1):
                caption_id = f"{safe_filename_stem(segment_id, f's{segment_index:02d}')}_cap_{order:03d}"
                caption_units.append(
                    {
                        "caption_id": caption_id,
                        "segment_id": segment_id,
                        "segment_type": segment_type,
                        "tts_enabled": False,
                        "order": order,
                        "text": chunk,
                        "source_segment_order": segment_index,
                    }
                )
    return merge_short_dialogue_units_across_slots(caption_units, segments_by_id), tts_units
```

중요한 차단 장치:

- TTS-enabled segment는 `segment.narration || segment.caption_text`만 사용한다.
- dialogue/source-audio segment는 `translated_caption_ko || caption_text`만 사용하고 `tts_enabled=false`가 된다.
- 이후 `draft_input.json`에는 이 함수가 만든 `captionUnits`와 `ttsFiles`가 함께 들어간다. 다른 텍스트 소스가 `draft_content.json` 자막으로 직접 들어가는 경로는 없다.

`draft_input` 작성 지점: `midform/scripts/assemble_slot_draft_input.py:653-705`

```python
segments = enrich_segments_from_slot_map(script.get("segments", []), script.get("slot_map", {}))
validate_dialogue_utterance_references(segments, transcript)
caption_units, tts_units = build_timeline_units(segments)
...
tts_files = load_reusable_tts_files(args.reuse_tts_manifest) if args.reuse_tts_manifest else await synthesize_tts(tts_units, args.tts_dir)
draft_input = {
    "segments": segments,
    "ttsFiles": tts_files,
    "captionUnits": caption_units,
    "captionWarnings": [],
    "claudeScript": script,
    "gptScript": script,
    ...
    "videoPlacementMode": "source_clips",
    "audioPathMode": "absolute",
    "slotMode": True,
    "ttsProvider": TTS_PROVIDER,
}
write_json(args.output, draft_input)
write_json(
    contained_output_path(args.tts_dir, "gpt_midform_tts_manifest.json"),
    {
        "model_id": f"edge-tts:{VOICE}",
        "tts_provider": TTS_PROVIDER,
        "caption_units": caption_units,
        "tts_units": tts_units,
        "files": tts_files,
    },
)
```

### 1.2 TTS mp3 생성도 같은 `tts_units`에서 출발

실제 코드: `midform/scripts/assemble_slot_draft_input.py:596-618`

```python
async def synthesize_unit(unit, output_dir):
    caption_id = safe_filename_stem(unit.get("caption_id"), "caption")
    output_path = contained_output_path(output_dir, f"{caption_id}.mp3")
    await edge_tts.Communicate(unit["text"], VOICE).save(str(output_path))
    return {
        "caption_id": caption_id,
        "segment_id": unit["segment_id"],
        "filename": output_path.name,
        "filepath": str(output_path),
        "duration_sec": round(ffprobe_duration(output_path), 3),
        "text": unit["text"],
        "success": True,
    }

async def synthesize_tts(tts_units, output_dir):
    Path(output_dir).resolve().mkdir(parents=True, exist_ok=True)
    files = []
    for unit in tts_units:
        if unit.get("tts_enabled") is False:
            continue
        files.append(await synthesize_unit(unit, output_dir))
    return files
```

즉 `ttsFiles[].text`와 `captionUnits[].text`는 같은 segment text에서 파생된다. 다만 TTS는 문장 단위, 화면 자막은 문장 내부 chunk 단위다.

### 1.3 CapCut text segment는 `caption_timeline_entries -> SRT -> TextSegment`만 사용

`scripts/capcut_draft.py`는 `captionUnits`를 읽고 `caption_timeline_entries`를 만든다. 이후 자막 트랙은 이 entries를 SRT로 쓰고 다시 parse해서 `cc.TextSegment(text=entry["text"], timerange=...)`로 추가한다.

SRT 작성 함수: `scripts/capcut_draft.py:110-127`

```python
def write_srt_entries(srt_path, entries):
    lines = []
    for index, entry in enumerate(entries, start=1):
        start_us = int(entry.get("timeline_start_us", 0) or 0)
        end_us = int(entry.get("timeline_end_us", start_us) or start_us)
        text = str(entry.get("text") or "").strip()
        if not text or end_us <= start_us:
            continue
        lines.extend(
            [
                str(index),
                f"{srt_timestamp_from_us(start_us)} --> {srt_timestamp_from_us(end_us)}",
                text,
                "",
            ]
        )
    with open(srt_path, "w", encoding="utf-8") as file:
        file.write("\n".join(lines).rstrip() + "\n")
```

CapCut text segment 생성: `scripts/capcut_draft.py:10023-10055`

```python
if caption_timeline_entries:
    copied_srt_path = os.path.abspath(os.path.join(subtitle_dir, "subtitles.srt"))
    write_srt_entries(copied_srt_path, caption_timeline_entries)
    srt_entries = parse_srt(copied_srt_path)
    subtitle_style = subtitle_components["style"]
    subtitle_clip = subtitle_components["clip_settings"]
    subtitle_font = subtitle_components["font"]
    subtitle_border = subtitle_components["border"]
    subtitle_background = subtitle_components["background"]
    subtitle_effect_id = subtitle_components["effect_id"]
    for entry in srt_entries:
        start_us = int(entry["start_sec"] * 1_000_000)
        duration_us = int((entry["end_sec"] - entry["start_sec"]) * 1_000_000)
        text_segment = cc.TextSegment(
            text=entry["text"],
            timerange=cc.Timerange(start=start_us, duration=duration_us),
            font=subtitle_font,
            style=subtitle_style,
            clip_settings=subtitle_clip,
            border=subtitle_border,
            background=subtitle_background,
        )
        if subtitle_effect_id:
            try:
                text_segment.add_effect(subtitle_effect_id)
            except Exception:
                warnings.append(f"failed to apply template text effect id={subtitle_effect_id}")
                fallback_template_style_used = True
        script.add_segment(text_segment, track_name="subtitle")
        subtitle_track_count += 1
```

이 구조상 `draft_content.json`의 자막 텍스트가 다른 원고/제목/템플릿 텍스트를 참조할 수 있는 지점은 없다. 템플릿은 스타일 추출용이고, 자막 track은 위 loop에서 새로 생성된다.

참고: legacy ElevenLabs route도 같은 사상을 가진다. `server/routes/gpt_midform.js:323-355`에서 `captionUnits`를 만들고 그중 `tts_enabled !== false`만 TTS로 보낸다. `server/services/srtGenerator.js:10-32`는 `ttsResults[].text`를 연속 타임라인으로 SRT화한다. 다만 현재 sealed slot path는 `assemble_slot_draft_input.py`가 더 정교한 문장/화면자막 분리 구조를 가진다.

---

## 2. 화면-오디오-자막 3자 싱크

### 2.1 오디오 배치 시작점: `current_time_us` 연속 배치

오디오 timeline은 `scripts/capcut_draft.py`의 `current_time_us` 하나로 결정된다.

초기화: `scripts/capcut_draft.py:9014-9023`

```python
current_time_us = 0
added_audio_count = 0
edit_manifest_entries = []
caption_timeline_entries = []
caption_manifest_entries = []
segment_to_caption_map = {}
split_warnings = []
tts_timeline_by_caption_id = {}
```

TTS mp3 배치: `scripts/capcut_draft.py:9258-9293`

```python
requested_duration_us = int(round(duration_sec * 1_000_000))

audio_material = cc.AudioMaterial(draft_audio_path)
material_duration_us = int(audio_material.duration or 0)
...
duration_us = min(requested_duration_us, material_duration_us)
...
script.add_material(audio_material)
audio_segment = cc.AudioSegment(
    material=audio_material,
    source_timerange=cc.Timerange(start=0, duration=duration_us),
    target_timerange=cc.Timerange(start=current_time_us, duration=duration_us),
)
script.add_segment(audio_segment, track_name="tts")
timeline_end_us = current_time_us + duration_us
current_time_us += duration_us
added_audio_count += 1

caption_timeline_entries.append(
    {
        "caption_id": caption_id,
        "segment_id": segment_id,
        "segment_type": segment_type,
        "tts_enabled": True,
        "timeline_start_us": timeline_start_us,
        "timeline_end_us": timeline_end_us,
        "tts_duration_us": duration_us,
        "text": narration,
        "mp3_path": draft_audio_path,
        "combined_segment_ids": combined_segment_ids,
    }
)
```

핵심:

- 오디오는 `target_timerange.start=current_time_us`로 놓인다.
- 배치 후 `current_time_us += duration_us`로 다음 문장 시작점이 결정된다.
- 이 같은 start/end가 `caption_timeline_entries`에도 기록된다.

### 2.2 한 문장 TTS 안의 여러 자막 chunk 비례 분배

slot pipeline에서는 `captionUnits`가 TTS 문장보다 더 잘게 쪼개질 수 있다. 이때 `decoupled_tts_caption_units=true`가 되고, 문장 오디오 구간을 자막 텍스트 길이에 비례해 나눈다.

실제 코드: `scripts/capcut_draft.py:9335-9417`

```python
if decoupled_tts_caption_units:
    grouped_caption_units = {}
    grouped_caption_order = []
    for unit in caption_units_input:
        if not isinstance(unit, dict) or unit.get("tts_enabled") is False:
            continue
        tts_caption_id = str(unit.get("tts_caption_id") or unit.get("sentence_id") or "").strip()
        if not tts_caption_id:
            continue
        if tts_caption_id not in grouped_caption_units:
            grouped_caption_units[tts_caption_id] = []
            grouped_caption_order.append(tts_caption_id)
        grouped_caption_units[tts_caption_id].append(unit)

    display_caption_timeline_entries = [entry for entry in caption_timeline_entries if entry.get("tts_enabled") is False]
    display_caption_manifest_entries = [entry for entry in caption_manifest_entries if entry.get("tts_enabled") is False]

    for tts_caption_id in grouped_caption_order:
        sentence_timeline = tts_timeline_by_caption_id.get(tts_caption_id)
        units_for_sentence = grouped_caption_units.get(tts_caption_id) or []
        if not sentence_timeline:
            warnings.append(f"{tts_caption_id}: sentence TTS timeline not found for proportional subtitles")
            continue
        start_us = int(sentence_timeline.get("timeline_start_us") or 0)
        end_us = int(sentence_timeline.get("timeline_end_us") or start_us)
        duration_us = max(1, end_us - start_us)
        weights = [max(1, len(str(unit.get("text") or ""))) for unit in units_for_sentence]
        total_weight = sum(weights) or 1
        elapsed_weight = 0
        for unit_index, unit in enumerate(units_for_sentence):
            unit_weight = weights[unit_index]
            unit_start_us = start_us + int(round(duration_us * elapsed_weight / total_weight))
            elapsed_weight += unit_weight
            unit_end_us = end_us if unit_index == len(units_for_sentence) - 1 else start_us + int(round(duration_us * elapsed_weight / total_weight))
            unit_duration_us = max(1, unit_end_us - unit_start_us)
            ...
            display_caption_timeline_entries.append(
                {
                    "caption_id": caption_id_value,
                    "sentence_id": tts_caption_id,
                    "tts_caption_id": tts_caption_id,
                    "segment_id": segment_id_value,
                    "segment_type": segment_type_value,
                    "tts_enabled": True,
                    "timeline_start_us": unit_start_us,
                    "timeline_end_us": unit_end_us,
                    "tts_duration_us": unit_duration_us,
                    "text": text_value,
                    "mp3_path": sentence_timeline.get("mp3_path") or "",
                    "combined_segment_ids": combined_segment_ids,
                    "timing_source": "proportional_sentence_tts",
                }
            )
```

따라서 draft 자막은 “원고 텍스트를 다시 임의 split”하지 않는다. 이미 만들어진 `captionUnits`를 오디오 문장 구간 안에서 비례 타이밍만 계산한다.

### 2.3 비TTS dialogue/source-audio 구간

`dialogue_quote` / `dialogue`는 `tts_enabled=false`다. 이 경우 TTS mp3는 없고, 소스 영상/소스 오디오를 유지하며 translated Korean subtitle만 표시한다.

타이밍은 transcript utterance 또는 source clip 길이에서 온다. 실제 코드: `scripts/capcut_draft.py:9137-9192`

```python
if tts is None:
    duration_us = estimate_non_tts_caption_duration_us(segment_info, segment_id, segment_type)
    duration_override_sec = safe_float(caption_unit.get("duration_override_sec") if caption_unit else 0, 0.0)
    if duration_override_sec > 0:
        duration_us = int(round(duration_override_sec * 1_000_000))
    timeline_end_us = current_time_us + duration_us
    current_time_us += duration_us

    caption_timeline_entries.append(
        {
            "caption_id": caption_id,
            "segment_id": segment_id,
            "segment_type": segment_type,
            "tts_enabled": False,
            "timeline_start_us": timeline_start_us,
            "timeline_end_us": timeline_end_us,
            "tts_duration_us": 0,
            "text": narration,
            "mp3_path": "",
            "combined_segment_ids": combined_segment_ids,
        }
    )
    ...
    edit_manifest_entries.append(
        {
            "caption_id": caption_id,
            "segment_id": segment_id,
            "segment_type": segment_type,
            "tts_enabled": False,
            "narration": narration,
            ...
            "warnings": ["subtitle-only original-dialogue caption; no TTS audio generated"],
        }
    )
    continue
```

### 2.4 영상 배치: TTS timeline에 source clips를 맞춤

`caption_timeline_entries`가 만들어진 뒤 segment별 start/end를 합산해서 영상 placement 단위가 만들어진다.

실제 코드: `scripts/capcut_draft.py:9425-9456`

```python
segment_timeline_entries_for_video = []
segment_timeline_map = {}
for item_index, caption_entry in enumerate(caption_timeline_entries):
    segment_id = caption_entry["segment_id"]
    start_us = int(caption_entry["timeline_start_us"])
    end_us = int(caption_entry["timeline_end_us"])
    if segment_id not in segment_timeline_map:
        segment_timeline_map[segment_id] = {
            "segment_id": segment_id,
            "timeline_start_us": start_us,
            "timeline_end_us": end_us,
            "tts_duration_us": max(0, end_us - start_us),
            "combined_segment_ids": combined_segment_ids,
            "first_index": item_index,
        }
    else:
        segment_timeline_map[segment_id]["timeline_end_us"] = max(segment_timeline_map[segment_id]["timeline_end_us"], end_us)
        segment_timeline_map[segment_id]["tts_duration_us"] = max(
            0,
            segment_timeline_map[segment_id]["timeline_end_us"] - segment_timeline_map[segment_id]["timeline_start_us"],
        )

segment_timeline_entries_for_video = sorted(
    segment_timeline_map.values(),
    key=lambda row: row["first_index"],
)
```

그 다음 source clip을 segment의 `tts_duration_us`에 맞춰 배치한다.

실제 코드: `scripts/capcut_draft.py:9632-9674`, `9720-9905`

```python
def add_video_segment_with_manifest(...):
    timeline_end_us = timeline_start_us + place_duration_us
    video_segment_kwargs = {
        "material": source_video_material,
        "source_timerange": cc.Timerange(start=source_start_us, duration=source_duration_for_segment_us),
        "target_timerange": cc.Timerange(start=timeline_start_us, duration=place_duration_us),
    }
    video_segment_local = cc.VideoSegment(**video_segment_kwargs)
    script.add_segment(video_segment_local, track_name="source_video")
    total_video_timeline_end_us = max(total_video_timeline_end_us, timeline_end_us)
    video_cut_placements.append({...})
    return timeline_end_us
```

```python
speed_multiplier = safe_float(clip.get("speed_multiplier"), 1.0)
if segment_type in {"dialogue_quote", "dialogue"}:
    speed_multiplier = 1.0
speed_multiplier = max(0.001, speed_multiplier)
playable_timeline_us = int(round(usable_source_us / speed_multiplier))
place_duration_us = min(playable_timeline_us, remaining_us)
source_duration_for_segment_us = min(usable_source_us, int(math.ceil(place_duration_us * speed_multiplier)))
...
timeline_end_us = add_video_segment_with_manifest(
    segment_id=segment_id,
    clip_id=clip_id,
    source_start_tc=clip_start_tc,
    source_end_tc=clip_end_tc,
    source_start_us=clip_source_start_us,
    source_duration_for_segment_us=source_duration_for_segment_us,
    place_duration_us=place_duration_us,
    timeline_start_us=timeline_cursor_us,
    tts_duration_us=tts_duration_us,
    placement_warnings=clip_warnings,
    speed_multiplier=speed_multiplier,
)
segment_video_end_us = max(segment_video_end_us, timeline_end_us)
timeline_cursor_us = timeline_end_us
remaining_us -= place_duration_us
...
if remaining_us > 0:
    if midform_hybrid_mode and segment_type in {"dialogue_quote", "dialogue"}:
        raise ValueError(...)
    fill_ref = last_segment_clip_ref or last_valid_clip_ref
    if fill_ref:
        pad_mode = "repeat_last"
        while remaining_us > 0:
            repeat_us = min(fill_ref["source_duration_us"], remaining_us)
            repeat_end_us = add_video_segment_with_manifest(...)
            timeline_cursor_us = repeat_end_us
            segment_video_end_us = max(segment_video_end_us, repeat_end_us)
            remaining_us -= repeat_us
```

최종 alignment 판정: `scripts/capcut_draft.py:9902-9905`

```python
total_tts_duration_sec = round(current_time_us / 1_000_000, 6)
total_video_duration_sec = round(total_video_timeline_end_us / 1_000_000, 6)
timeline_duration_diff_sec = round(total_tts_duration_sec - total_video_duration_sec, 6)
video_timeline_aligned_to_tts = abs(timeline_duration_diff_sec) <= 0.2
```

정리하면:

- TTS가 영상에 맞춰지는 것이 아니라, **영상이 TTS timeline에 맞춰진다**.
- narration segment는 `speed_multiplier`로 source clip 길이를 늘이거나 줄인다. 자동 slot map에서는 `0.7x~1.5x` 범위로 제한한다. 관련 코드: `scripts/capcut_draft.py:8986-9012`.
- dialogue segment는 원본 발화 보존이므로 `speed_multiplier=1.0`으로 강제된다.
- source clip이 짧으면 narration segment는 마지막 클립 반복 또는 placeholder로 빈 화면을 막는다. dialogue segment에서 반복이 필요하면 실패한다.

---

## 3. 원고 분량이 영상 길이에 맞게 나오는 장치

### 3.1 slot map에서 source range별 TTS budget 생성

`midform/scripts/build_slot_map.py`가 영상/transcript/Gemini를 기반으로 slot을 만들고 narration slot마다 `tts_budget_sec`를 넣는다.

실제 코드: `midform/scripts/build_slot_map.py:520-567`

```python
"tts_budget_sec": [round(duration * 0.75, 3), round(duration * 0.95, 3)],
...
total_estimate = 0.0
for slot in slots:
    if slot["type"] == "dialogue":
        total_estimate += slot["duration"]
    else:
        total_estimate += sum(slot["tts_budget_sec"]) / 2
return {
    "source_duration_sec": round(source_duration, 6),
    "composition_mode": "dialogue_heavy" if dialogue_heavy else "hybrid_standard",
    "speech_duration_sec": round(total_speech_duration, 3),
    "speech_ratio": round(speech_ratio, 4),
    "dialogue_heavy_mode": dialogue_heavy,
    "narration_strategy": {...},
    "slots": slots,
    "excluded_ranges": ...,
    "total_output_estimate_sec": round(total_estimate, 3),
    "dialogue_selected_duration_sec": round(sum(slot["duration"] for slot in slots if slot["type"] == "dialogue"), 3),
}
```

자동 narration-only fallback도 같은 원리다. `server/services/gptMidformCliService.js:303-374`는 scene duration에서 `tts_budget_sec=[duration*0.75, duration*0.95]`를 만든다.

### 3.2 GPT prompt에서 budget을 직접 지시

활성 GPT slot-fill prompt: `server/services/gptMidformCliService.js:1604-1758`

핵심 문구: `server/services/gptMidformCliService.js:1630-1634`

```js
'## Narration budget',
'- tts_budget_sec is mandatory. Korean TTS averages roughly 5-6 Korean characters per second.',
'- Example: 14 seconds means about 70-84 Korean characters excluding spaces.',
'- Keep narration slightly under the slot duration; do not fill every frame with speech.',
```

caption/TTS 단일화 문구: `server/services/gptMidformCliService.js:1726-1734`

```js
'## Caption unit rules',
'- For every narration slot, fill caption_units with the exact Korean chunks that TTS/subtitles should use.',
'- Obey each narration slot tts_budget_sec strictly. Keep Korean characters excluding spaces within the budget implied by 5-6 chars/sec.',
'- caption_units must concatenate to the narration text with spaces only. Subtitle and TTS use the same units 1:1.',
'- Split by sentence boundary first, then comma/connector boundary. Never split in the middle of an eojeol/word.',
'- Each caption unit should be at most 22 Korean characters excluding spaces when possible, and each split piece should have at least 2 eojeol unless the whole sentence is shorter.',
'- Do not produce chunks that split a subject from its predicate or split one action phrase across captions.',
'- For dialogue slots, caption_units should contain only the translated subtitle pieces and caption_kr should be their joined text.',
```

### 3.3 Validator가 budget 초과를 실패 처리

char budget 계산: `server/services/gptMidformCliService.js:704-710`

```js
function slotBudgetCharRange(slot) {
  const budget = Array.isArray(slot?.tts_budget_sec) ? slot.tts_budget_sec : [0, 0];
  const minSec = Number(budget[0] || 0);
  const maxSec = Number(budget[1] || 0);
  const minChars = slot?.require_min_chars === true ? Math.floor(minSec * 4) : Math.floor(minSec * 5);
  return [minChars, Math.ceil(maxSec * 6)];
}
```

검증: `server/services/gptMidformCliService.js:1000-1094`

```js
if (slot.type === 'narration') {
  const narration = String(fill.narration || '').trim();
  const [minChars, maxChars] = slotBudgetCharRange(slot);
  const charCount = narration.replace(/\s+/g, '').length;
  const effectiveMinChars = slot.require_min_chars === true ? Math.floor(minChars * 0.9) : minChars;
  if (slot.require_min_chars === true && charCount < effectiveMinChars) {
    errors.push(`${slotId} narration char count ${charCount} is below dialogue-heavy budget min ${effectiveMinChars}`);
  }
  const effectiveMaxChars = slot.require_min_chars === true ? Math.ceil(maxChars * 1.15) : maxChars;
  if (minChars > 0 && charCount > effectiveMaxChars) {
    errors.push(`${slotId} narration char count ${charCount} exceeds budget max ${effectiveMaxChars}`);
  }
  ...
}
```

retry loop: `server/services/gptMidformCliService.js:1835-1911`

- slot map이 없으면 movie recap은 실패한다.
- story outline 생성 후 slot fill을 생성한다.
- `collectSlotFillValidationErrors`가 budget/grounding/style 오류를 모아 재시도한다.
- dialogue-heavy는 최대 3회, 일반은 2회.

---

## 4. 화면 내용과 대사의 정합 요구

### 4.1 Gemini prompt: transcript-first

`midform/prompts/gemini_analysis_midform.md:11-19`

```md
## Transcript-First Rule
An STT transcript may be provided after this prompt under a section named "Source transcript utterances". Treat that transcript as the single source of truth for spoken dialogue text and dialogue timing.

- Gemini's role is visual observation plus mapping scenes to transcript utterance IDs.
- Do not invent, paraphrase, or retime spoken dialogue outside the transcript.
- If dialogue is heard or preserved, dialogue_or_caption must use transcript wording or "none".
- Every scene must include utt_refs. Use transcript utterance IDs such as ["utt_004"] when the scene contains those utterances, or [] when no transcript utterance belongs to the scene.
- A scene boundary must not split a transcript utterance. If an utterance overlaps a visual transition, expand the scene so the full utterance stays inside one scene.
- should_preserve_original_dialogue may be true only for scenes with one or more utt_refs.
```

`midform/prompts/gemini_analysis_midform.md:68-73`

```md
### dialogue preservation guidance
- Preserve 2 to 5 lines at most for a 60-180 second midform.
- Prefer short, high-impact lines: decisions, reveals, threats, confessions, emotional encouragement, iconic callbacks, or punchlines.
- Do not preserve routine instructions, repeated scoring calls, or exposition that can be summarized faster.
- If a dialogue line is preserved, translated_caption_ko must be suitable as on-screen subtitle while the original source audio plays, and utt_refs must identify the exact transcript utterance(s).
- Never preserve dialogue without utt_refs.
```

### 4.2 GPT prompt: story_anchor and non-overlap

`server/services/gptMidformCliService.js:1499-1506`

```js
'## Story-anchor synchronization rules',
'- Every recap/bridge narration segment must include story_anchor.',
'- story_anchor.source_range_hint must be [start_sec, end_sec] for the source story moment that the narration describes.',
'- story_anchor.scene_refs must list the Gemini scene_id values that support that narration.',
'- Narration order must follow source story progression. You may skip source sections, but must not go backward in source time.',
'- Later narration that describes later story events must use later source ranges, not early visual filler.',
'- The final recap/bridge narration must anchor to source content after 70% of source duration unless the source facts prove the story ends earlier.',
'- Dialogue_quote timing remains controlled by utt_id; story_anchor is primarily for recap/bridge background-video selection.',
```

validator: `server/services/gptMidformCliService.js:623-697`

- narration segment must include `story_anchor.source_range_hint` and `story_anchor.scene_refs`.
- narration anchors must not move backward.
- final narration anchor must cover after 70% of source duration.
- dialogue_quote must include `utt_id` when transcript exists.

### 4.3 assemble-time dialogue range validation

`midform/scripts/assemble_slot_draft_input.py:238-276` validates dialogue source clips against transcript utterance ranges before TTS/draft input is written.

```python
def validate_dialogue_utterance_references(segments, transcript):
    utterance_map = build_transcript_utterance_map(transcript)
    if not utterance_map:
        raise ValueError("TRANSCRIPT_UTTERANCES_REQUIRED: --transcript must contain utterances for dialogue slot validation")
    errors = []
    for segment in segments:
        ...
        if segment_type not in {"dialogue_quote", "dialogue"}:
            continue
        ...
        within_utterance = start >= utterance["start"] - 0.05 and end <= utterance["end"] + 0.05 and end > start
        exact_utterance = abs(start - utterance["start"]) <= 0.05 and abs(end - utterance["end"]) <= 0.05
        if not (exact_utterance or within_utterance):
            errors.append(...)
    if errors:
        raise ValueError("DIALOGUE_UTTERANCE_REFERENCE_FAILED: " + "; ".join(errors))
```

---

## 5. 실제 중간 JSON 예시: run_013

소스 파일:

- `midform/test_runs/run_013_tVxYCeRXzGo_e2e/draft_input_signature_quotes.json`
- `server/output/drafts/pipeline_1784045533/edit_manifest.json`

### 5.1 `draft_input_signature_quotes.json` 축약 예시

```json
{
  "sourceDurationSec": 140.039546,
  "videoPlacementMode": "source_clips",
  "ttsProvider": "Microsoft Edge online TTS via edge-tts",
  "segmentCount": 9,
  "ttsFiles": [
    {
      "caption_id": "s01_sent_001",
      "segment_id": "s01",
      "filename": "s01_sent_001.mp3",
      "duration_sec": 3.696,
      "text": "아들이 원하는 건 거창한 게 아니었습니다.",
      "success": true
    },
    {
      "caption_id": "s01_sent_002",
      "segment_id": "s01",
      "filename": "s01_sent_002.mp3",
      "duration_sec": 4.848,
      "text": "아버지 트로이에게 자신이 사랑받는 아들인지 확인하고 싶었죠.",
      "success": true
    }
  ],
  "captionUnits": [
    {
      "caption_id": "s01_sent_001_cap_001",
      "sentence_id": "s01_sent_001",
      "tts_caption_id": "s01_sent_001",
      "segment_id": "s01",
      "segment_type": "recap",
      "tts_enabled": true,
      "text": "아들이 원하는 건 거창한 게 아니었습니다."
    },
    {
      "caption_id": "s01_sent_002_cap_001",
      "sentence_id": "s01_sent_002",
      "tts_caption_id": "s01_sent_002",
      "segment_id": "s01",
      "segment_type": "recap",
      "tts_enabled": true,
      "text": "아버지 트로이에게"
    }
  ]
}
```

### 5.2 `edit_manifest.json` 축약 예시

```json
{
  "videoTimelineAlignedToTts": true,
  "audioTrackCount": 14,
  "subtitleTrackCount": 57,
  "segmentTimelineAlignment": [
    {
      "segment_id": "s01",
      "tts_start_sec": 0,
      "tts_end_sec": 8.544,
      "tts_duration_sec": 8.544,
      "video_start_sec": 0,
      "video_end_sec": 8.544,
      "video_duration_sec": 8.544,
      "duration_diff_sec": 0
    }
  ],
  "captions": [
    {
      "caption_id": "s01_sent_002_cap_001",
      "sentence_id": "s01_sent_002",
      "tts_caption_id": "s01_sent_002",
      "text": "아버지 트로이에게",
      "start_sec": 3.696,
      "end_sec": 5.1504,
      "timing_source": "proportional_sentence_tts"
    }
  ],
  "videoCutPlacements": [
    {
      "segment_id": "s01",
      "source_start": "00:00.000",
      "source_end": "00:07.000",
      "timeline_start_sec": 0,
      "timeline_end_sec": 8.544,
      "tts_duration_sec": 8.544,
      "video_duration_sec": 8.544,
      "speed_multiplier": 0.819288,
      "duration_diff_sec": 0,
      "warnings": [
        "trimmed to fit TTS segment duration",
        "speed adjusted for narration background: 0.819x"
      ]
    }
  ]
}
```

---

## 6. 파이프라인 순서도

```text
source video + yt-dlp metadata
  -> STT transcript
  -> preflight_material_gate.py
  -> Gemini scene analysis
      - transcript-first scene/utt_ref mapping
  -> build_slot_map.py
      - slots[] with source_range, type, tts_budget_sec
  -> generateMidformScriptWithGptCli()
      - buildStoryOutlinePrompt()
      - buildSlotFillPrompt()
      - collectSlotFillValidationErrors()
      - normalizeSlotFillsToScript()
  -> assemble_slot_draft_input.py
      - validate_dialogue_utterance_references()
      - build_timeline_units()
          segments -> tts_units + caption_units
      - synthesize_tts(tts_units)
      - write draft_input.json + gpt_midform_tts_manifest.json
  -> capcutService.generateDraft()
      - scripts/capcut_draft.py
      - ttsFiles -> AudioSegment target_timerange
      - captionUnits -> caption_timeline_entries -> SRT -> TextSegment
      - source_clips -> VideoSegment target_timerange matching segment TTS duration
  -> draft_content.json + subtitles.srt + edit_manifest.json + ZIP
```

---

## 7. 이식 체크리스트

공정 쇼츠 Phase 2에 이식할 때 가장 중요한 것은 “자막 텍스트 소스가 여러 갈래로 섞이지 않게 하는 것”이다.

1. `captionUnits`를 draft 자막의 유일한 입력으로 둔다.
2. TTS 요청 text와 captionUnits text를 같은 upstream unit에서 파생한다.
3. TTS 문장 ID와 자막 chunk ID를 분리하되 `tts_caption_id`로 연결한다.
4. `draft_content.json` text track은 SRT/entries 기반으로 재생성하고 템플릿 텍스트를 복사하지 않는다.
5. audio/video/subtitle 모두 `current_time_us`에서 파생된 동일 timeline을 공유한다.
6. source video는 TTS에 맞춰 trim/speed/repeat 처리한다. TTS를 영상에 맞춰 임의로 늘이거나 줄이지 않는다.
7. dialogue/source-audio 구간은 `tts_enabled=false`, `speed_multiplier=1.0`, transcript utterance timing authority로 분리한다.
8. 생성 단계에서 budget을 prompt로 지시하고, validation에서 char budget을 실패 처리한다.
