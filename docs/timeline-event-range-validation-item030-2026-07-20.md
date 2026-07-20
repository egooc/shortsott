# timeline event 시간축 검증 보고서 (item_030)

작성일: 2026-07-20

## 요청 요약

1. `item_030`에서 source duration은 `4.876s`인데 timeline event가 `8.5s`까지 나온 원인 확인
2. 모든 추출 event를 `[0, source_duration]` 범위로 clamp/검증하는 방어 추가
3. 다른 성공 7개도 source 길이 안에 있는지 재검

## 결론 요약

- `item_030`의 직접 원인은 **Gemini timeline 응답에 source 길이 밖 timestamp가 들어왔고, 코드가 그걸 그대로 저장한 것**이다.
- `MEDIA_RESOLUTION_LOW` 자체가 시간 스케일을 바꿨다는 증거는 못 찾았다.
- 프롬프트는 **source duration 상한을 명시하지 않고 있었고**, 코드에도 **범위 검증이 없었다.**
- 방어 추가 후 `item_030`의 cache는 정규화되었고, 범위 밖 event 11개가 제거되었다.
- 성공 7개(`item_025,026,029,032,033,034,036`)는 재검 시 **모두 source 길이 안**에 있었다.

---

## 1) item_030 원인 분석

### 실제 source 길이

`ffprobe` 결과:

- `item_030 source_clean.mp4`: **4.876190s**

### 기존 cache 상태

기존 `queue/process/item_030/highlight_action_timeline.json`에는:

- 마지막 event time: **8.5s**
- source duration 대비 약 **3.6초 초과**

즉 기존 cache는 실제로 source 범위를 벗어나 있었다.

### Gemini가 source 길이 밖 좌표를 반환했나?

정황상 **그렇다**.

직접 재추출 결과:

- `extractActionTimeline(item_030)` normalization 로그:
  - `original_event_count: 6`
  - `max_original_time_sec: 6`
  - `max_kept_time_sec: 4.876`
  - `clamped_event_count: 1`
  - `dropped_event_count: 1`

또 cached normalization 로그:

- `original_event_count: 21`
- `max_original_time_sec: 8.5`
- `kept_event_count: 10`
- `dropped_out_of_range_count: 11`

즉 모델/기존 저장값 쪽에서 **clip duration 밖 timestamp가 실제로 발생했다**고 보는 게 맞다.

### mediaResolution LOW 적용 후 시간 스케일이 틀어졌나?

현재 코드에서 timeline 추출은 Vertex/API key 모두:

- `mediaResolution: DEFAULT_TIMELINE_MEDIA_RESOLUTION`
- 값: `MEDIA_RESOLUTION_LOW`

하지만 이번 조사에서 확인된 것은 **시간 스케일이 일정 비율로 늘어난 패턴**이 아니라,
**일부 event만 clip duration 바깥으로 튀는 패턴**이었다.

따라서 지금 근거로는:

- `MEDIA_RESOLUTION_LOW`가 직접 원인이라고 보긴 어렵다.
- 더 정확히는 **Gemini timeline 응답을 무검증 저장한 문제**가 핵심이다.

### 추출 시 source 길이를 프롬프트에 안 알려주나?

**안 알려주고 있었다.**

기존 `server/prompts/action_timeline_extraction.txt`에는
source duration 상한에 대한 직접 지시가 없었다.

원래 문구는:

- “Only report timestamps for moments you can actually see...”

수정 후 추가:

- “Every timestamp must stay inside the real clip duration. Never report a time after the last visible frame of the uploaded clip.”

즉 프롬프트 차원에서도 기존에는 **EOF 바깥 timestamp 금지**가 분명하지 않았다.

---

## 2) 넣은 방어

### A. 추출 직후 정규화 (`geminiService.js`)

추가 함수:

- `normalizeActionTimelineEvents(events, sourceDurationSec)`

동작:

- 유효 타입만 허용: `IMPACT`, `RESULT_REVEAL`, `RESET`
- 시간 숫자 아닌 event 제거
- source duration 기준으로 범위 검증
- 경미한 초과는 **clamp**
- 큰 초과는 **drop**
- 정렬 후 반환
- normalization 통계 생성

로그:

- `console.warn('[timeline-normalization]', ...)`

### B. cache 읽을 때도 재정규화 (`processQueueService.js`)

기존 cache라도 그대로 믿지 않게 바꿈.

- cache hit 시에도 `normalizeActionTimelineEvents(...)` 적용
- 수정이 발생하면:
  - `normalized_at`
  - `normalization`
  - `event_count`
  - `events`
  를 다시 저장

로그:

- `console.warn('[timeline-cache-normalization]', ...)`

### C. prompt 보강

`server/prompts/action_timeline_extraction.txt`에
clip duration 밖 timestamp 금지 문구 추가.

---

## 3) item_030 결과 (방어 후)

cache 정규화 후 `queue/process/item_030/highlight_action_timeline.json`:

- `event_count`: **10**
- `max_kept_time_sec`: **4.876**
- `dropped_out_of_range_count`: **11**
- `clamped_event_count`: **1**

즉 기존 21개 event 중 범위 밖 11개가 제거되었고,
남은 event는 모두 source 안에 들어오도록 보정됐다.

정규화 후 `item_030`은 배치에서:

- `highlight_status: held`
- 사유: `no loop-complete cycle or RESULT_REVEAL completion window found`

이건 정상이다. 즉 **시간축 버그를 제거한 뒤에는, 부적격이면 held로 정직하게 남는다.**

---

## 4) 성공 7개 재검증

대상:

- `item_025`
- `item_026`
- `item_029`
- `item_032`
- `item_033`
- `item_034`
- `item_036`

검사 결과:

| item | duration_sec | max_event_time_sec | in_range |
|---|---:|---:|---|
| item_025 | 15.928889 | 14.0 | true |
| item_026 | 57.190748 | 55.5 | true |
| item_029 | 48.692245 | 48.0 | true |
| item_032 | 34.737052 | 33.0 | true |
| item_033 | 56.21551 | 55.0 | true |
| item_034 | 46.09161 | 44.5 | true |
| item_036 | 38.336145 | 32.0 | true |

판정:

- 성공 7개는 **모두 source 길이 안에 있었다.**
- 따라서 이번에 확인된 시간축 초과는 **광범위한 전면 문제라기보다 item_030 같은 일부 cache/event 이상 케이스**에 더 가깝다.

다만 각 cache에는 아직 `normalization: null`인 예전 파일이 섞여 있으므로,
실사용 중엔 cache hit 시 재정규화가 계속 안전망 역할을 하게 된다.

---

## 5) 원인 판정

### 가장 가능성 높은 원인

1. **Gemini가 source duration 밖 timestamp를 반환할 수 있다**
2. 기존 코드가 **그걸 그대로 저장**했다
3. prompt에도 EOF 상한 지시가 부족했다

### 가능성 낮은 원인

- `MEDIA_RESOLUTION_LOW` 자체가 시간을 일정 비율로 왜곡했다는 직접 증거는 없음

---

## 6) 변경 파일

- `server/services/geminiService.js`
  - timeline event 정규화/검증 추가
- `server/services/processQueueService.js`
  - cache hit 시 timeline 재정규화 + 재저장
- `server/prompts/action_timeline_extraction.txt`
  - clip duration 밖 timestamp 금지 문구 추가

---

## 7) 검증

- `item_030` 재추출/재정규화 확인 완료
- 성공 7개 범위 재검 완료
- `npm run verify` 통과

---

## 최종 결론

`item_030`은 **Gemini timeline 응답 + 무검증 저장**이 결합된 시간축 버그였다.

이제는:

- 추출 직후 정규화
- cache hit 재정규화
- prompt 경고

세 단계 방어가 들어가 있어서,
**범위 밖 event는 더 이상 조용히 살아남지 못한다.**
