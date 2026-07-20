# TTS + 자막 비례 배분 아키텍처

## 문서 목적

이 문서는 현재 레포의 **문장 단위 TTS + 표시 자막 비례 배분** 구조를 다른 레포의 Phase 2 draft 경로로 이식하기 위한 아키텍처 메모다. 기준 코드는 아래 두 파일이다.

- `midform/scripts/assemble_slot_draft_input.py`
- `scripts/capcut_draft.py`

핵심 결론부터 말하면, **현재 활성 경로는 “문장 1개 = TTS 1개 MP3” + “문장 내부 표시 자막은 여러 개로 분할 후 문자수 비례로 시간 배분”** 구조다.

> 중요: README와 일부 서버 경로에는 예전 `1 caption unit = 1 mp3` / ElevenLabs 기반 설명이 남아 있다. 하지만 `assemble_slot_draft_input.py` 기준 현재 실제 문장 단위 경로는 **Edge TTS (`edge_tts`)** 를 쓴다.

---

## 0. 전체 흐름 요약

```text
script.segments[]
-> assemble_slot_draft_input.py
   -> 문장 단위 tts_units 생성
   -> 화면 표시용 captionUnits 생성(11자 기준 분할)
   -> 문장별 mp3 생성(ttsFiles)
   -> draft_input.json 저장
-> capcut_draft.py
   -> ttsFiles를 오디오 트랙에 순차 배치
   -> sentence_id / tts_caption_id 기준으로 captionUnits 재그룹
   -> 각 문장 오디오 길이 안에서 화면 자막 조각에 비례 시간 배분
   -> SRT 생성
   -> CapCut subtitle/text segment 생성
   -> edit_manifest.json 기록
```

---

## 1. 데이터 계약 (가장 중요)

## 1-1. 입력 원고 형태

진입 입력은 `assemble_slot_draft_input.py` 의 `script.get("segments", [])` 이다.

최소한 실제로 참조되는 필드:

```json
{
  "segment_id": "s02",
  "segment_type": "recap",
  "tts_enabled": true,
  "narration": "코리는 사랑을 묻고 싶었지만, 트로이는 책임이라는 말로 대답을 끝냈습니다. 아들이 집 안으로 돌아가자 로즈는 그 상처가 가족 전체로 번졌다는 걸 알았죠.",
  "caption_text": "...",
  "translated_caption_ko": "...",
  "source_clips": [
    {
      "clip_id": "slot_s02",
      "scene_id": "scene_015",
      "start": "01:58.850",
      "end": "02:20.040",
      "speed_multiplier": 1,
      "source": "slot_map_narration"
    }
  ]
}
```

텍스트 선택 규칙은 `build_timeline_units()` 에서 갈린다.

- **TTS 사용 세그먼트**: `segment_type` 이 `dialogue_quote`, `dialogue` 가 아니고 `tts_enabled !== false`
  - 텍스트 우선순위: `narration` -> `caption_text`
- **비TTS 세그먼트(주로 대사)**:
  - 텍스트 우선순위: `translated_caption_ko` -> `caption_text`

즉, 이 구조는 원고를 처음부터 “자막 유닛 배열”로 받는 게 아니라, **segment 배열에서 TTS용 문장 유닛과 표시용 자막 유닛을 파생 생성**한다.

## 1-2. 중간 산출물: TTS 생성 단위

`assemble_slot_draft_input.py` 는 중간에 두 배열을 만든다.

### A. `tts_units` = 문장 단위 TTS 생성 단위

필드 스키마:

```json
{
  "caption_id": "s02_sent_001",
  "sentence_id": "s02_sent_001",
  "segment_id": "s02",
  "segment_type": "recap",
  "tts_enabled": true,
  "order": 1,
  "text": "코리는 사랑을 묻고 싶었지만, 트로이는 책임이라는 말로 대답을 끝냈습니다.",
  "source_segment_order": 2
}
```

생성 규칙:

- ID 규칙: `"{safe_segment_id}_sent_{NNN}"`
- 1 sentence = 1 TTS 요청 = 1 MP3

### B. `ttsFiles` = 실제 합성 완료 파일 목록

실제 예시 (`midform/test_runs/run_013_tVxYCeRXzGo_e2e/draft_input_rerun.json`):

```json
{
  "caption_id": "s02_sent_001",
  "segment_id": "s02",
  "filename": "s02_sent_001.mp3",
  "filepath": "...\\tts_rerun\\s02_sent_001.mp3",
  "duration_sec": 6.072,
  "text": "코리는 사랑을 묻고 싶었지만, 트로이는 책임이라는 말로 대답을 끝냈습니다.",
  "success": true
}
```

파일명 규칙은 `caption_id + ".mp3"` 이다.

### C. TTS manifest

`assemble_slot_draft_input.py` 는 `gpt_midform_tts_manifest.json` 도 함께 저장한다.

상위 스키마:

```json
{
  "model_id": "edge-tts:ko-KR-SunHiNeural",
  "tts_provider": "Microsoft Edge online TTS via edge-tts",
  "tts_network_disclosure": "Narration text is sent to Microsoft's online Edge TTS service during synthesis.",
  "reused_from_manifest": "",
  "caption_units": [...],
  "tts_units": [...],
  "files": [...]
}
```

## 1-3. 출력: 표시 자막 유닛과 오디오 연결 구조

표시용 자막은 `captionUnits` 배열로 저장된다. 현재 활성 구조에서는 **표시 자막 조각이 sentence TTS에 매달린다**.

실제 예시:

```json
{
  "caption_id": "s02_sent_001_cap_001",
  "sentence_id": "s02_sent_001",
  "tts_caption_id": "s02_sent_001",
  "segment_id": "s02",
  "segment_type": "recap",
  "tts_enabled": true,
  "order": 1,
  "text": "코리는 사랑을",
  "source_segment_order": 2
}
```

연결 키는 다음처럼 동작한다.

- `ttsFiles[].caption_id` = 문장 오디오의 식별자
- `tts_units[].caption_id` = 문장 오디오의 식별자
- `captionUnits[].tts_caption_id` = 어떤 문장 오디오에 붙는지 가리키는 외래키
- `captionUnits[].sentence_id` = 사실상 같은 값의 보조 키

즉 실제 연결 그래프는 아래다.

```text
ttsFiles.caption_id == tts_units.caption_id == captionUnits.tts_caption_id == captionUnits.sentence_id
```

### 실제 JSON 연결 예시

```json
{
  "tts_unit": {
    "caption_id": "s02_sent_001",
    "text": "코리는 사랑을 묻고 싶었지만, 트로이는 책임이라는 말로 대답을 끝냈습니다."
  },
  "tts_file": {
    "caption_id": "s02_sent_001",
    "filename": "s02_sent_001.mp3",
    "duration_sec": 6.072
  },
  "display_caption_units": [
    {
      "caption_id": "s02_sent_001_cap_001",
      "tts_caption_id": "s02_sent_001",
      "text": "코리는 사랑을"
    },
    {
      "caption_id": "s02_sent_001_cap_002",
      "tts_caption_id": "s02_sent_001",
      "text": "묻고 싶었지만,"
    },
    {
      "caption_id": "s02_sent_001_cap_003",
      "tts_caption_id": "s02_sent_001",
      "text": "트로이는 책임이라는 말로"
    },
    {
      "caption_id": "s02_sent_001_cap_004",
      "tts_caption_id": "s02_sent_001",
      "text": "대답을 끝냈습니다."
    }
  ]
}
```

이게 이식 포인트의 핵심이다. **오디오는 sentence granularity, 화면 자막은 display-unit granularity** 다.

---

## 2. 핵심 로직 위치와 책임

## 2-1. `assemble_slot_draft_input.py`

### (A) 문장 단위 TTS 생성 로직

핵심 함수:

- `split_tts_sentences(text)`
- `build_timeline_units(segments)`
- `synthesize_unit(unit, output_dir)`
- `synthesize_tts(tts_units, output_dir)`

핵심 시그니처:

```python
def split_tts_sentences(text):
def build_timeline_units(segments):
async def synthesize_unit(unit, output_dir):
async def synthesize_tts(tts_units, output_dir):
```

실제 호출부:

```python
VOICE = "ko-KR-SunHiNeural"
TTS_PROVIDER = "Microsoft Edge online TTS via edge-tts"

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
```

### ElevenLabs 관련 해석

요청 항목에는 “ElevenLabs 호출부”가 있었지만, **이 파일 안에는 현재 ElevenLabs 호출이 없다.**

- 현재 활성 문장 단위 경로: `edge_tts.Communicate(...).save(...)`
- 레포 내부에 별도 `server/services/elevenlabsService.js` 는 존재하지만, 그건 **서버 측 레거시/병행 TTS 경로** 다.
- 따라서 이식 기준을 `assemble_slot_draft_input.py` 로 잡는다면, TTS provider는 사실상 **provider-agnostic** 으로 보고 `ttsFiles[]` 계약만 맞추면 된다.

참고로 레거시 ElevenLabs 서비스는 아래 형태다.

```js
fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
  method: 'POST',
  headers: {
    'xi-api-key': apiKey,
    'Content-Type': 'application/json',
    Accept: 'audio/mpeg'
  },
  body: JSON.stringify({
    text,
    model_id: modelId || 'eleven_v3',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75
    }
  })
})
```

하지만 이건 **현재 문장 비례 배분 구조의 필수 요소가 아니다.** 필수는 오직:

- 문장별 mp3 생성
- `caption_id == sentence_id` 유지
- `duration_sec` 측정

### (B) 11자 분할 로직

관련 상수:

```python
CAPTION_MAX_CHARS = 11
CAPTION_EXTENDED_CHARS = 14
CAPTION_MIN_CHARS = 4
CAPTION_MIN_DURATION_SEC = 0.9
```

관련 함수:

- `split_by_sentence_boundaries(text)`
- `split_long_caption_by_eojeol(text, ...)`
- `split_caption_text(text, max_chars=11, ...)`
- `merge_short_units(units, segment=...)`
- `merge_short_dialogue_units_across_slots(...)`

동작 순서:

1. `split_tts_sentences()` 가 **TTS용 문장**을 만든다.
2. 각 문장에 대해 `split_caption_text()` 가 **화면 자막 조각**으로 쪼갠다.
3. 너무 짧은 조각은 `merge_short_units()` 로 다시 합친다.

핵심 로직 발췌:

```python
def split_caption_text(text, max_chars=CAPTION_MAX_CHARS, min_eojeol=1):
    for sentence in split_by_sentence_boundaries(text):
        if visible_len(sentence) <= max_chars:
            units.append(sentence)
            continue
        comma_parts = [part.strip() for part in re.split(r"(?<=[,，])\s+", sentence) if part.strip()]
        if len(comma_parts) > 1:
            for part in comma_parts:
                units.extend(split_long_caption_by_eojeol(part, ...))
        else:
            units.extend(split_long_caption_by_eojeol(sentence, ...))
```

```python
def merge_short_units(units, segment=None, ...):
    estimated = duration / len(units) if duration > 0 else 2.0
    too_short = visible_len(current) < min_chars or estimated < min_duration_sec
```

즉 규칙은 단순 “11자 자르기” 가 아니라:

- 우선 **문장 경계 유지**
- 그 다음 **쉼표 경계 우선**
- 그래도 길면 **어절 균형 분할**
- 너무 짧거나 너무 빨리 지나갈 조각은 **재병합**

### sentence_id 역연결

이 역연결이 이 구조의 핵심이다.

```python
sentence_id = f"{safe_filename_stem(segment_id, f's{segment_index:02d}')}_sent_{sentence_order:03d}"

tts_units.append({
    "caption_id": sentence_id,
    "sentence_id": sentence_id,
    ...
})

caption_units.append({
    "caption_id": f"{sentence_id}_cap_{display_order:03d}",
    "sentence_id": sentence_id,
    "tts_caption_id": sentence_id,
    ...
})
```

즉 display caption은 자기 자신의 `caption_id` 가 따로 있지만, **오디오 참조는 `tts_caption_id` 로 sentence에 매단다.**

## 2-2. `capcut_draft.py`

### (A) 오디오 타임라인 배치 로직

입력 로딩 위치:

```python
tts_files = data.get("ttsFiles", [])
caption_units_input = data.get("captionUnits", [])
caption_warnings_input = data.get("captionWarnings", [])
```

오디오 배치는 `draft_timeline_units` 생성 후 순차 누적 방식으로 들어간다.

핵심 알고리즘:

1. `tts_by_caption_id[tts_item.caption_id] = tts_item`
2. `captionUnits` 안에 `tts_caption_id` 가 있으면 현재 구조를 **decoupled sentence-TTS mode** 로 판단
3. 문장 TTS는 한 번만 emit
4. 각 mp3를 `current_time_us` 부터 이어 붙임

핵심 코드:

```python
audio_segment = cc.AudioSegment(
    material=audio_material,
    source_timerange=cc.Timerange(start=0, duration=duration_us),
    target_timerange=cc.Timerange(start=current_time_us, duration=duration_us),
)
script.add_segment(audio_segment, track_name="tts")
timeline_end_us = current_time_us + duration_us
current_time_us += duration_us
```

즉 문장 mp3는 **겹치지 않고 순차 배치** 된다.

### (B) 자막 타이밍 비례 배분 로직

이식에서 가장 중요한 부분은 여기다.

문장 오디오 타임라인이 먼저 확정된 뒤, 같은 `tts_caption_id` 를 가진 표시 자막 조각들을 다시 모은다.

```python
grouped_caption_units[tts_caption_id].append(unit)
sentence_timeline = tts_timeline_by_caption_id.get(tts_caption_id)
start_us = int(sentence_timeline.get("timeline_start_us") or 0)
end_us = int(sentence_timeline.get("timeline_end_us") or start_us)
duration_us = max(1, end_us - start_us)
weights = [max(1, len(str(unit.get("text") or ""))) for unit in units_for_sentence]
total_weight = sum(weights) or 1
```

문자수 비례 수식:

```python
unit_start_us = start_us + round(duration_us * elapsed_weight / total_weight)
elapsed_weight += unit_weight
unit_end_us = end_us if last_unit else start_us + round(duration_us * elapsed_weight / total_weight)
unit_duration_us = max(1, unit_end_us - unit_start_us)
```

정리하면:

```text
weight_i = max(1, len(unit_i.text))
start_i = sentence_start + sentence_duration * (sum(weight_<i) / sum(weight_all))
end_i   = sentence_start + sentence_duration * (sum(weight_<=i) / sum(weight_all))
```

마지막 조각은 항상 `sentence_end` 로 강제한다. 그래서 rounding 오차가 중간에서 조금 나더라도 마지막 조각이 전체 문장 오디오 끝에 맞는다.

결과 산출 예:

```json
{
  "caption_id": "s02_sent_001_cap_003",
  "sentence_id": "s02_sent_001",
  "tts_caption_id": "s02_sent_001",
  "segment_id": "s02",
  "tts_enabled": true,
  "timeline_start_us": 2894,
  "timeline_end_us": 4927,
  "tts_duration_us": 2033,
  "text": "트로이는 책임이라는 말로",
  "mp3_path": ".../s02_sent_001.mp3",
  "timing_source": "proportional_sentence_tts"
}
```

### (C) 대사 / non-TTS 유닛 별도 처리

`tts_enabled == false` 인 유닛은 문장 MP3를 참조하지 않는다.

별도 규칙:

```python
def estimate_non_tts_caption_duration_us(segment_info, segment_id, segment_type=""):
    total_source_sec = sum(source_clip_durations)
    duration_sec = total_source_sec / unit_count if total_source_sec > 0 else 2.0
    if non_dialogue:
        duration_sec = max(1.0, min(duration_sec, 4.0))
    else:
        duration_sec = max(0.001, duration_sec)
```

즉 non-TTS는:

- source clip 총길이를 같은 세그먼트의 non-TTS caption 수로 나눔
- 일반 non-dialogue는 1~4초로 clamp
- dialogue 류는 0.001초 이상만 보장

그리고 warning 도 명시적으로 남긴다.

```json
"warnings": ["subtitle-only original-dialogue caption; no TTS audio generated"]
```

---

## 3. 의존성과 전제

## 3-1. TTS API 호출 방식

### 현재 활성 경로

- 파일: `midform/scripts/assemble_slot_draft_input.py`
- 방식: `edge_tts` Python 라이브러리
- 호출: `edge_tts.Communicate(text, VOICE).save(path)`
- 현재 voice: `ko-KR-SunHiNeural`

즉 현재 구조는 **“문장별 mp3를 만들 수 있으면 provider는 바뀌어도 됨”** 쪽에 가깝다.

### 레거시/병행 ElevenLabs 경로

- 파일: `server/services/elevenlabsService.js`
- 방식: SDK 아님, raw REST `fetch`
- endpoint: `POST /v1/text-to-speech/{voiceId}`
- 기본 파라미터:
  - `model_id: eleven_v3`
  - `voice_settings.stability: 0.5`
  - `voice_settings.similarity_boost: 0.75`
- 재시도: 최대 2회 + 500~1000ms jitter

이 경로는 현재 문장 비례 배분 엔진의 핵심은 아니지만, **다른 레포에서 ElevenLabs로 다시 붙일 경우 참조할 수 있는 레거시 구현** 이다.

## 3-2. 오디오 길이 측정 방식

### Python 쪽

`assemble_slot_draft_input.py`

```python
subprocess.run([
  "ffprobe", "-v", "error",
  "-show_entries", "format=duration",
  "-of", "default=noprint_wrappers=1:nokey=1",
  str(path)
])
```

### Node 쪽 레거시 유틸

`server/utils/ffprobe.js`

```js
execFileSync(ffprobePath(), [
  '-v', 'quiet',
  '-print_format', 'json',
  '-show_format',
  filePath
])
return parseFloat(data?.format?.duration)
```

전제와 caveat:

- 주로 `format.duration` 사용
- MP3는 `start_time` offset 이 있을 수 있음
- 짧은 VBR MP3는 duration estimation 오차 가능
- 이 코드베이스는 마지막 방어선으로 `pyCapCut AudioMaterial.duration` 과 비교해 더 짧은 쪽으로 clamp 한다

```python
duration_us = min(requested_duration_us, material_duration_us)
```

이 clamp 가 꽤 중요하다. ffprobe 값이 조금 길게 잡혀도 CapCut material duration을 넘기지 않게 막는다.

## 3-3. CapCut draft 구조 전제

현재 구조가 가정하는 CapCut 전제:

- `pyCapCut` 또는 `pycapcut` 설치 필요
- 트랙 이름을 명시적으로 사용
  - `source_video`
  - `tts`
  - `subtitle`
- 템플릿을 쓸 때 `TEMPLATE_SUBTITLE`, `TEMPLATE_TITLE`, `TEMPLATE_PRETITLE`, `TEMPLATE_MOVIE_TITLE` 같은 marker text asset 이 실제 draft 안에 있어야 함

최근 핫픽스 성격의 clone 전제:

- 텍스트 segment는 템플릿 marker segment/material 을 **clone** 해서 재생성 가능
- overlay video는 `render_timerange` 가 0이어도 그대로 보존해야 함
- `track_render_index` 가 비어 있거나 음수면 CapCut이 불안정해질 수 있어 0 이상으로 강제 보정

관련 코드:

```python
if original_track_render_index is None:
    segment["track_render_index"] = 0
```

```python
segment["track_render_index"] = max(0, coerce_int(segment.get("track_render_index"), 0))
```

```python
cloned_segment["track_render_index"] = 0
```

## 3-4. 이 구조가 가정하는 원고 특성

현재 로직이 암묵적으로 기대하는 입력 특성:

- narration 문장은 한국어 종결형 경계가 어느 정도 살아 있음
- 문장 내부를 11자 안팎 표시 자막으로 나눌 수 있음
- 너무 긴 문단은 sentence split + comma split + eojeol split 로 완전히 부서져야 함
- 표시 자막은 아주 짧으면 재병합 가능해야 함
- dialogue 세그먼트는 TTS가 아니라 원본 음성 위에 자막만 얹는 경우가 있음

실제 방어값:

- 표시 자막 기본 길이: 11자
- 확장 허용: 14자
- 최소 읽을거리: 4자
- 최소 체감 표시시간 기준: 0.9초
- 비TTS non-dialogue 자막 추정표시시간: 1~4초 clamp

---

## 4. 알려진 함정 / 핫픽스 포인트

아래는 git commit 이력보다는 **현재 guard code, 주석, warning 문자열, `midform/test_runs/*hotfix*` 산출물 이름** 에서 확인되는 함정들이다.

## 4-1. README/레거시 구현과 현재 활성 경로가 다르다

가장 큰 함정이다.

- README: `1 caption unit = 1 TTS mp3`
- 현재 sentence path: `1 sentence = 1 mp3`, `caption unit` 은 그 sentence에 매달린 표시 조각

즉 다른 레포로 이식할 때 예전 caption-unit 기반 TTS를 그대로 가져오면 **비례 배분 구조가 사라진다.**

## 4-2. `tts_caption_id` 연결이 없으면 현재 구조가 무너진다

`capcut_draft.py` 는 `captionUnits` 안에 `tts_caption_id` / `sentence_id` 가 있으면 decoupled mode 로 동작한다.

이 키들이 빠지면 fallback 으로 옛 1:1 caption-to-mp3 방식으로 해석할 수 있다. 즉 이식 시 필수 보존 필드는:

- `captionUnits[].tts_caption_id`
- `captionUnits[].sentence_id`
- `ttsFiles[].caption_id`

## 4-3. `track_render_index` 강제 보정

현재 코드 곳곳에서 `track_render_index = 0` 또는 `max(0, ...)` 보정이 들어간다. 이건 우연이 아니다.

이식 시 clone/rebuild 된 text/video segments 에서 이 값을 비워 두면 CapCut import/render 순서가 흔들릴 가능성이 높다.

## 4-4. 템플릿 clone 은 “보이는 박스만 있고 글자가 안 보이는” 문제를 겪었다

직접적인 warning 문구가 남아 있다.

```python
"template-cloned process captions can produce selectable boxes without visible glyphs in CapCut"
```

그래서 process 쪽은 일부 경우 `template_marker_clone` 대신 `simple_text_for_process_caption` fallback 을 둔다. midform subtitle 재구성도 결국은 템플릿 clone + plain text rebuild 두 경로를 모두 가진다.

## 4-5. overlay/render timerange 를 함부로 늘리면 안 된다

주석 그대로:

```python
# CapCut template overlay videos often use render duration 0 while
# the visible range is controlled by target_timerange. Preserve that
# instead of stretching the template segment like source footage.
```

즉 템플릿 overlay video 는 일반 source footage 와 같은 규칙으로 duration stretch 하면 깨질 수 있다.

## 4-6. 0-duration subtitle/tail 방지

현재 코드가 반복해서 `max(1, end_us - start_us)` 를 쓰는 이유가 있다.

```python
duration_us = max(1, end_us - start_us)
unit_duration_us = max(1, unit_end_us - unit_start_us)
```

비례 배분 결과 어떤 조각이 rounding 때문에 0 길이가 되는 걸 방지한다. 이게 없으면 마지막/짧은 조각이 사라지거나 EOF 근처에서 깨질 수 있다.

EOF 문자열 자체는 코드에 명시돼 있지 않았지만, 이 guard 와 `scene_tail_trim`/`safe_tail` 류 테스트 산출물 이름을 보면 **끝 프레임/끝 자막의 꼬리 안정화** 가 실제 핫픽스 축 중 하나였던 것으로 보인다.

## 4-7. ffprobe 값만 믿지 않고 CapCut material duration으로 다시 clamp 한다

짧은 mp3 에서 duration probe 오차가 있으면 자막 전체 타이밍이 밀릴 수 있다. 현재 코드는:

- ffprobe로 `duration_sec` 기록
- `cc.AudioMaterial(...).duration` 재확인
- 둘 중 안전한 쪽으로 clamp

이중 검증을 빼면 문장 자막 끝이 실제 음성보다 길게 남을 수 있다.

## 4-8. sentence TTS 누락 시 표시 자막만 남는 문제가 생길 수 있다

현재 코드는 다음 warning 을 남긴다.

```python
warnings.append(f"{tts_caption_id}: sentence TTS referenced by caption unit but no generated TTS file was found")
```

즉 비례 배분 구조는 “표시 자막 조각만 있고 sentence mp3가 없음” 상태를 정상으로 보지 않는다.

## 4-9. 비TTS 대사 자막은 완전히 별도 정책이다

대사 세그먼트는 원본 음성 보호 때문에 TTS 흐름에 태우지 않는다. 이걸 실수로 sentence-TTS 구조에 섞으면:

- 원본 대사 + TTS 이중음성
- 잘못된 duration accumulation
- dialogue reserved range 위반

같은 문제가 생긴다.

## 4-10. slot-map 모드에서는 source clip speed 도 보정된다

`capcut_draft.py` 는 slot-map 모드에서 non-dialogue source clip 의 speed multiplier 를 **0.7~1.5x** 범위로 clamp 한다.

이건 오디오 총길이와 source visual 길이를 얼추 맞추기 위한 안전장치다. 다른 레포 이식 시 이 정책을 빼면 “문장 TTS는 끝났는데 영상 슬롯이 너무 길거나 짧은” 현상이 커질 수 있다.

---

## 5. 이식 시 최소 보존 계약

다른 레포에서 이 구조를 그대로 살리려면 최소한 아래 계약은 유지해야 한다.

### 필수 입력 계약

```ts
type Segment = {
  segment_id: string
  segment_type: string
  tts_enabled?: boolean
  narration?: string
  caption_text?: string
  translated_caption_ko?: string
  source_clips?: Array<{ start: string, end: string, speed_multiplier?: number }>
}
```

### 필수 중간 계약

```ts
type TtsUnit = {
  caption_id: string   // == sentence_id
  sentence_id: string
  segment_id: string
  text: string
}

type CaptionUnit = {
  caption_id: string
  sentence_id?: string
  tts_caption_id?: string
  segment_id: string
  tts_enabled: boolean
  text: string
}

type TtsFile = {
  caption_id: string   // sentence key
  segment_id: string
  filename: string
  filepath: string
  duration_sec: number
  text: string
  success: true
}
```

### 필수 알고리즘 계약

1. **문장 단위 TTS 먼저 생성**
2. **표시 자막은 문장 내부를 11자 안팎으로 분할**
3. **표시 자막은 `tts_caption_id` 로 문장 오디오에 연결**
4. **문장 오디오 길이 안에서 문자수 비례로 표시 시간 분할**
5. **마지막 표시 조각은 문장 끝시간에 정확히 맞춤**

---

## 6. 이식 권장안

공정 쇼츠 레포 Phase 2 에 이식할 때는 **TTS provider 자체보다 데이터 계약부터 먼저 고정** 하는 게 맞다.

권장 순서:

1. `sentence_tts_units[]` / `display_caption_units[]` 이원화
2. `tts_caption_id` 연결키 도입
3. sentence mp3 duration 확보
4. proportional timing allocator 이식
5. 마지막에 provider(Edge/ElevenLabs/기타) 교체

이 구조의 본질은 음성합성 엔진이 아니라 **문장 오디오와 표시 자막을 느슨하게 분리하고, 마지막 단계에서 다시 시간적으로 결합하는 것** 이다.
