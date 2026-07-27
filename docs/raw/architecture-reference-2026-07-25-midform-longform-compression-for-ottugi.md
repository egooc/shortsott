# 미드폼 롱폼 압축 구조 이식용 레퍼런스

## 보고서 위치

- `docs/raw/architecture-reference-2026-07-25-midform-longform-compression-for-ottugi.md`

## 범위

이 문서는 현재 midform-only 파이프라인에서 확인한 롱폼 처리 구조를 오뚝이 공정영상 트랙에 이식하기 위한 레퍼런스입니다. 코드 수정은 하지 않았고, 저장된 코드/아티팩트만 읽어 정리했습니다.

오뚝이 공정영상에는 영화 대사/STT 중심 구조가 맞지 않으므로, 발화대사 보존·화자 자막·STT 대사 선택 로직은 제외하거나 “미사용”으로 분리해야 합니다.

---

## 1. Gemini 호출 구조 — 429 관점

### 1.1 현재 Gemini/Vertex 호출 경로

관련 파일:

- `server/services/geminiMidformService.js`
- `server/routes/gemini_midform.js`
- `server/services/midformCompressionService.js`

현재 Gemini 계열 호출은 크게 두 종류입니다.

| 구분 | 파일/함수 | 모델 기본값 | 영상 포함 | 목적 |
|---|---|---:|---:|---|
| 비디오 장면 분석 | `analyzeMidformVideo()` → `requestVertexMidformAnalysis()` | `gemini-2.5-flash` | 예 | 영상 장면/인물/안전/스토리 컨텍스트 분석 |
| 텍스트 JSON 생성 | `generateVertexJson()` via `runJsonGeneration()` | `gemini-2.5-pro` | 아니오 | narrative beats, edit plan, slot fills 생성 |

### 1.2 롱폼 비디오 분석 호출 수

`geminiMidformService.js` 기준:

```text
MIDFORM_CHUNK_THRESHOLD_SEC = 90
MIDFORM_CHUNK_TARGET_SEC = 35
MIDFORM_CHUNK_OVERLAP_SEC = 2
MIDFORM_CHUNK_DELAY_MIN_MS = 3000
MIDFORM_CHUNK_DELAY_MAX_MS = 5000
```

동작:

- 소스 길이 `<= 90초`: Gemini 비디오 호출 1회
- 소스 길이 `> 90초`: 약 35초 단위로 chunk 분할 후 chunk마다 Gemini 비디오 호출 1회
- 2초 overlap을 붙여 chunk 경계 누락을 줄임
- transcript가 있으면 chunk 경계를 근처 침묵/발화 경계로 snap
- chunk 호출 사이에 3~5초 랜덤 delay

대략 호출 수:

| 소스 길이 | 비디오 Gemini 호출 수 추정 |
|---:|---:|
| 3분 | 약 6회 |
| 5분 | 약 9회 |
| 10분 | 약 18회 |

각 호출은 해당 chunk mp4를 `inlineData` base64로 포함합니다.

```js
inlineData: {
  mimeType: 'video/mp4',
  data: fs.readFileSync(videoPath).toString('base64')
}
```

### 1.3 mediaResolution 설정 여부

현재 코드에는 `mediaResolution` / `media_resolution` 설정이 없습니다. 즉 Vertex 기본 해상도 정책에 맡깁니다.

오뚝이 이식 시 권장:

- 1~10분+ 공정영상은 Gemini File API 또는 GCS URI 방식으로 넘기고, 가능하면 `MEDIA_RESOLUTION_LOW`를 명시합니다.
- 공식 문서 기준 long video에는 inline base64보다 File API/GCS URI가 안전합니다.
- `MEDIA_RESOLUTION_LOW`는 긴 영상/일반 장면 이해에 적합하고 비용·토큰·지연을 줄입니다.

참고 공식 문서:

- Gemini video understanding: `https://ai.google.dev/gemini-api/docs/generate-content/video-understanding`
- Media resolution: `https://ai.google.dev/gemini-api/docs/media-resolution`
- Rate limits: `https://ai.google.dev/gemini-api/docs/rate-limits`

### 1.4 호출 간격/순서 제어

비디오 분석은 병렬이 아니라 순차 처리입니다.

```text
for each chunk:
  ffmpeg로 chunk 추출
  Gemini 호출
  response 저장
  다음 chunk 전 3~5초 sleep
```

이 구조가 429 회피에 기여합니다.

### 1.5 재시도/실패 처리

비디오 장면 분석(`requestVertexMidformAnalysis`)은 현재 명시적 retry/backoff가 없습니다.

- `fetch` 실패: `VERTEX_MIDFORM_REQUEST_FAILED`
- HTTP non-OK: `VERTEX_MIDFORM_ANALYSIS_FAILED`
- JSON parse 실패: `GEMINI_MIDFORM_JSON_PARSE_ERROR`
- chunk 추출 실패: `MIDFORM_CHUNK_EXTRACT_FAILED`
- chunk 결과 병합 검증 실패:
  - empty scenes
  - timecode out of range
  - duplicate scene summaries

텍스트 JSON 생성(`runJsonGeneration`)은 제한적 retry가 있습니다.

- validator feedback 기반 최대 2회 생성 시도
- transport retry 최대 3회
- Vertex path에서 retryable로 보는 것:
  - `VERTEX_COMPRESS_REQUEST_FAILED`
  - `VERTEX_COMPRESS_GENERATION_FAILED` 중 status `>= 500`
  - `VERTEX_GEMINI_EMPTY_RESPONSE`
- 429는 현재 retry 대상이 아닙니다. 즉 429가 나면 멈추는 구조입니다.

오뚝이 이식 권장:

1. 비디오 분석에도 429/408/5xx exponential backoff + jitter를 추가
2. 429는 무한 재시도 금지, 예: 3회까지만
3. long video는 chunk 병렬 금지
4. chunk 사이 delay는 최소 3~5초 유지 또는 429 발생 후 더 늘림
5. 가능하면 inline video 대신 File API/GCS URI + `MEDIA_RESOLUTION_LOW`

---

## 2. 롱폼 → 짧은 결과물 압축 구조

### 2.1 현재 큰 흐름

현 midform에는 두 층이 있습니다.

```text
A. 비디오 장면 분석층
source video
-> Gemini chunk scene analysis
-> merged gemini_analysis.json

B. 압축 기획층
YouTube metadata + transcript + heatmap
-> narrative_beats.json
-> edit_plan.json
-> compression_slot_fills.json
-> bootstrap artifacts
-> TTS / CapCut draft
```

오뚝이 공정영상은 STT/대사 중심이 아니므로, B층의 transcript 기반 대사 선택은 제거하고 다음 구조로 바꾸는 것이 맞습니다.

```text
source video
-> Gemini chunk visual/process-step analysis
-> usable range gate
-> process beats: 공정 단계 / 변화 / 실패·반전 / 완성 결과
-> edit plan: hook + build-up + 2개 이상 highlight + payoff
-> slot fill: 짧은 설명 자막/나레이션
-> TTS 실측
-> CapCut draft
```

### 2.2 “쓸 구간” 선택 원리

현 midform의 선택 기준:

1. Gemini scene facts
   - `scenes[].start_sec/end_sec`
   - `visible_action`
   - `shot_type`
   - `dialogue_importance`, `dialogue_function`, `should_preserve_original_dialogue`
2. compression beats
   - `dramatic_weight`
   - `hook_potential`
   - `dialogue_quality`
   - `key_dialogue`, `anchor_dialogue`
3. heatmap
   - `yt-dlp.info.heatmap`에서 top replay peak 추출
   - cold open 후보 beat와 겹치면 우선 사용
   - 겹치지 않으면 hook_potential fallback
4. slot map
   - selected source ranges를 최종 slot 단위로 고정
   - 이후 단계는 slot order/source_range를 바꾸면 안 됨

오뚝이 이식 시 대체 기준:

| midform 영화 기준 | 오뚝이 공정영상 대체 기준 |
|---|---|
| dramatic_weight | 공정 변화량, 실패/반전, 완성도 변화 |
| hook_potential | 첫 1~3초에 궁금증/시각 충격을 줄 수 있는 컷 |
| dialogue_quality | 시각 정보 밀도 / 손동작 명확도 / 재료 변화 |
| key_dialogue | key_visual_moment |
| anchor_dialogue | anchor_visual_range |

### 2.3 story_anchor / source_range 단조 진행 규칙

관련 파일:

- `server/services/gptMidformCliService.js`
- `midform/scripts/build_slot_map.py`
- `midform/scripts/assemble_slot_draft_input.py`
- `midform/scripts/validate_slot_draft.py`
- `server/services/midformBootstrapAdapterService.js`

현재 최종 형태:

- narration segment는 `story_anchor`를 가져야 함
- `story_anchor.source_range_hint = [start_sec, end_sec]`
- `story_anchor.scene_refs`는 근거 Gemini scene id 목록
- narration 순서는 source story progression을 따라야 함
- source section은 건너뛸 수 있지만 뒤로 가면 안 됨
- dialogue_quote timing은 transcript utt_id가 우선이고, story_anchor는 주로 narration/background 선택용

오뚝이 이식 형태:

```json
{
  "segment_id": "slot_03",
  "segment_type": "process_step",
  "narration": "반죽 표면이 갈라지기 시작하면서 실패 신호가 먼저 보입니다.",
  "story_anchor": {
    "source_range_hint": [124.2, 139.8],
    "scene_refs": ["scene_012", "scene_013"]
  },
  "source_scenes": [
    { "scene_id": "scene_012", "start": "00:02:04.200", "end": "00:02:19.800" }
  ]
}
```

핵심은 “나레이션이 말하는 공정 변화”와 “보여주는 원본 구간”이 같은 시간대여야 한다는 점입니다.

### 2.4 usable footage 판정

관련 파일:

- `midform/scripts/preflight_material_gate.py`
- `midform/scripts/build_slot_map.py`
- `server/services/midformBootstrapAdapterService.js`

현재 명시 규칙:

- title/metadata가 scene clip인지 확인
- transcript utterance 수와 speech ratio 확인
- duration guide 확인: `midform/config/duration.json`
  - min `60초`
  - max `160초`
- slot map에서 제외 키워드 처리:
  - `구독`
  - `엔딩 화면`
  - `다른 영상`
  - `시청을 유도`
  - `credit`, `credits`, `end screen`

현재 코드에서 freezedetect 자체가 slot-map 핵심 규칙으로 강하게 보이지는 않습니다. 다만 bootstrap preflight는 다음을 검증합니다.

- source video exists
- source duration covers all timestamps
- reserved range violation 없음
- cross-segment overlap 없음
- narration segment에 explicit b-roll/source range 존재

오뚝이 이식 권장 usable gate:

1. ffprobe로 duration 확인
2. freezedetect/blackdetect로 정지 화면·검은 화면·인트로/아웃트로 후보 제거
3. OCR 또는 Gemini scene labels로 구독/엔딩/로고/완성 후 정지 썸네일 배제
4. 공정 변화가 적은 구간 배제
5. 손/재료/도구가 명확한 구간을 usable로 유지
6. 최종 slot source ranges는 겹치지 않게 고정

---

## 3. 대본 분량 ↔ 영상 길이 정합

### 3.1 현재 대본 분량 결정 구조

관련 파일:

- `server/services/midformCompressionService.js`
- `midform/scripts/assemble_slot_draft_input.py`
- `midform/config/duration.json`

기본 상수:

```text
DEFAULT_TARGET_SEC = 160
BASE_KOREAN_NARRATION_CHARS_PER_SEC = 4.8
KOREAN_NARRATION_MIN_SEC = 1.5
KOREAN_NARRATION_PAUSE_BUFFER_SEC = 0.3
duration guide: 60~160초
```

현재 흐름:

1. edit plan 단계에서 slot별 `estimated_duration_sec` 산출
2. narration은 `estimateKoreanNarrationSeconds()`로 글자 수 기반 추정
3. slot fill prompt에서 `tts_budget_sec`를 강제
4. `assemble_slot_draft_input.py`가 narration을 sentence/caption unit으로 분할
5. TTS 생성 후 ffprobe로 실제 mp3 길이 측정
6. draft input에 실제 TTS 파일 길이를 기록
7. CapCut draft 생성 시 실제 TTS 길이에 맞춰 timeline 구성
8. final duration guide 재검사

즉 “처음에는 예산 기반, 최종은 TTS 실측 기반”입니다.

### 3.2 TTS 재사용 구조

`assemble_slot_draft_input.py`는 `--reuse-tts-manifest`를 받을 수 있습니다.

동작:

- narration text hash 계산
- 이전 manifest에서 같은 text_hash의 mp3가 있으면 복사 재사용
- 바뀐 텍스트만 새로 TTS 생성
- manifest에 reused/regenerated count 기록

오뚝이 이식 시에도 그대로 유용합니다. 공정영상은 대사가 없으므로 TTS 비용/시간이 전체 길이 정합의 핵심이 됩니다.

### 3.3 오뚝이용 길이 정합 권장

공정 숏폼 목표가 “풀드래프트 + 하이라이트 2개+”라면 다음처럼 분리하는 것이 안전합니다.

| 결과물 | 권장 길이 | 생성 방식 |
|---|---:|---|
| 풀드래프트 압축본 | 60~160초 | 전체 공정 arc를 따라 narration + selected source ranges |
| 하이라이트 1 | 15~35초 | 가장 강한 변화/실패/반전 순간 |
| 하이라이트 2 | 15~35초 | 완성/비교/핵심 손동작 순간 |

구조:

```text
process_beats
-> master_edit_plan
   - full_draft_slots
   - highlight_slots[0]
   - highlight_slots[1]
-> 각 결과물별 TTS budget
-> TTS 실측
-> draft 생성
```

---

## 4. 오뚝이 이식용 최소 구조 제안

### 4.1 Gemini 호출 수를 줄인 안전형

10분 소스 기준 현재 midform식 chunk 분석은 약 18회 비디오 호출이 됩니다. 429 관점에서는 안정적이지만 호출 수가 많습니다.

오뚝이 공정영상은 대사보다 시각 변화가 중요하므로 다음 구조가 더 적합합니다.

```text
1. 로컬 전처리
   - ffprobe duration
   - scene/frame sampling
   - freezedetect/blackdetect
   - 간단한 frame-diff로 변화량 후보 추출

2. Gemini 비디오 분석
   - 후보 구간만 20~45초 chunk로 분석
   - 또는 전체 영상을 File API/GCS + low media resolution으로 1회 분석

3. 텍스트 기획
   - process_beats JSON
   - full_draft + highlight 2개 edit_plan JSON
   - narration/caption slot fill JSON

4. TTS 실측 후 draft 생성
```

### 4.2 이식할 핵심 규칙

- chunk 호출은 순차 처리
- chunk 간 3~5초 이상 delay
- 429/408/5xx는 bounded retry만
- long video는 inline base64보다 File API/GCS URI 권장
- `MEDIA_RESOLUTION_LOW` 권장
- source ranges는 한 번 확정되면 뒤에서 변경 금지
- full draft와 highlight는 같은 beat pool에서 파생하되 source range 중복 정책을 명시
- 나레이션은 source range의 실제 공정 변화와 같은 시간대를 말해야 함
- TTS는 예산 추정 후 반드시 실측 길이로 timeline 재계산

### 4.3 버려야 할 midform 영화 전용 요소

오뚝이 공정영상에는 다음을 그대로 이식하지 않는 것이 좋습니다.

- `dialogue_quote`
- `speaker` / 화자별 자막 색상
- STT utterance 기반 대사 선택
- 영화 인물/관계/Pass 0 movie research
- `dialogue_quality`, `anchor_dialogue` 중심 scoring
- “영화 사실” 기반 recap context

대체 필드:

```json
{
  "process_step": "반죽 성형",
  "visual_change": "표면이 매끈해지고 크기가 균일해짐",
  "failure_or_hook": "처음엔 질어 보였지만 접을수록 형태가 잡힘",
  "source_range": [120.0, 145.0],
  "highlight_score": 4.6,
  "usable_reason": "손동작과 재료 변화가 명확함"
}
```

---

## 5. 결론

현재 midform이 10분+ 롱폼을 다룰 수 있었던 핵심은 “통째로 무작정 한 번에 처리”가 아니라 다음 조합입니다.

1. 비디오 분석은 90초 초과 시 35초 chunk로 분할
2. chunk Gemini 호출은 순차 실행 + 3~5초 delay
3. chunk 결과를 source timeline으로 다시 merge
4. story/slot 구조는 source range를 고정한 뒤 뒤 단계가 따름
5. 대본 길이는 예산으로 시작하지만 TTS 실측으로 최종 보정
6. preflight/validation으로 source timestamp, overlap, duration을 막음

오뚝이 공정영상에 이식할 때는 STT/대사 축을 제거하고, 대신 “시각 변화량 + 공정 단계 + 하이라이트 후보 + usable range” 중심으로 바꾸면 됩니다. Gemini 429 안정성만 보면, 현재 chunk+delay 구조를 유지하되 File API/GCS URI와 `MEDIA_RESOLUTION_LOW`, 429 bounded retry를 추가하는 것이 가장 안전한 이식 방향입니다.
