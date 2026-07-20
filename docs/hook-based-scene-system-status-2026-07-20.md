# 원래 훅 기반 장면 분기 시스템 현황 (읽기 전용)

작성일: 2026-07-20

## 결론 요약

- **훅 기반 장면 분기 설계는 스키마/프롬프트/보조 함수 수준으로는 아직 많이 살아 있다.**
- 하지만 **실제 발행용 하이라이트 생성 경로는 지금 `pickProductionHighlightWindow()`(loop_complete / result_reveal 완결 로직)가 우선**이고,
  원래의 scene/hook score 기반 `pickHighlightWindow()` 계열은 **현재 발행 경로에서 사실상 우회**된다.
- `segments` 테이블은 존재하지만, **지금은 scene별 훅 점수 저장용이 아니라 slice_source timeline event 저장용**이다.
- 따라서 “원래 훅 앵커 로직으로 되돌린다”는 건 단순히 점수 필드가 남아 있다는 뜻이 아니라,
  **발행 경로의 selector를 다시 scene/hook candidate 기반으로 연결**해야 한다는 뜻이다.

---

## 1) Gemini 비전 장면 분기: 지금 어떤 필드를 뽑나

### A. scene 분석 스키마에 살아 있는 훅 필드

`server/services/processMetadataService.js`의 `OTTOGI_METADATA_SCHEMA.properties.scene_transitions`에는 scene별로 다음 훅/리듬 필드가 정의돼 있다.

주요 라인:

- `visual_hook_score` — line 460
- `visual_hook_type` — line 461
- `curiosity_reason` — line 462
- `repetition_potential` — line 463
- `mechanical_rhythm` — line 464
- `tempo_score` — line 465
- `tension_score` — line 466
- `transformation_score` — line 467
- `framing_score` — line 468
- `flow_score` — line 469
- `a_grade_score` — line 470
- `scene_role` — line 471
- `human_presence` — line 472
- `cycle_time_sec` — line 474
- `appears_sped_up` — line 475
- `human_visibility` — line 476

출처:

- `server/services/processMetadataService.js:440-494`

즉 scene 단위 훅 점수/훅 타입/리듬/반복성 스키마는 **실제로 살아 있다.**

### B. prompt도 같은 필드를 요구함

`server/prompts/ottogi_process_metadata.txt`는 scene마다 다음 필드를 넣으라고 직접 지시한다.

- `visual_hook_score: integer 1-10`
- `visual_hook_type: one of ...`
- `curiosity_reason`
- `repetition_potential`
- `mechanical_rhythm`
- `human_presence`
- `process_focus_priority`

또 하이라이트 선택은 다음을 선호하라고 적혀 있다.

- `high visual_hook_score`
- `high repetition_potential`
- `strong mechanical_rhythm`
- `high a_grade_score`

출처:

- `server/prompts/ottogi_process_metadata.txt:92-109`

즉 “훅 점수 기반 scene scoring”은 **프롬프트 수준에서도 여전히 현재 설계**다.

### C. shortform / longform 후보 창도 스키마에 남아 있음

동일 스키마에는 아래도 살아 있다.

- `shortform_candidate_windows` — `server/services/processMetadataService.js:412-430`
  - `hook_score`
  - `process_coverage`
  - `cycle_time_sec`
  - `appears_sped_up`
  - `human_visibility`

- `hook_clip_10s`, `story_clip_40s`, `recommended_highlight_window`, `recommended_full_window`, `recommended_midform_window`
  - `server/services/processMetadataService.js:431-436`

또 longform 전처리에는:

- `hook_candidates`
- `story_candidates`
- `midform_candidates`

가 살아 있고,
`hook_candidates`에는 `hook_score`, `tempo_score`, `tension_score`, `transformation_score`, `framing_score`, `flow_score`가 포함된다.

출처:

- `server/services/processMetadataService.js:527-594`
- `server/services/processMetadataService.js:1193-1266`

### D. `HOOK_MOMENT`, `PEAK_ACTION`, `hook_type`, `hook_density`의 실제 현황

repo search 결과:

- `HOOK_MOMENT` / `PEAK_ACTION` → **검색 결과 없음**
- `hook_type` → 현재 시스템의 정식 필드는 `visual_hook_type`
- `hook_density` → 살아 있는 로직 필드가 아니라 **폐기 흔적만 남음**

정확한 흔적:

- `server/services/highlightPatternDbService.js:37-40`
  - `hook_density was computed from v2 segments on the training clip itself;`
  - `segments are now exclusively used for slice_source timelines`
  - `patternStats()/loop_seam_similarity replace what this table gestured at.`

즉 `hook_density`는 **현재 live field가 아니라 과거 실험 흔적**이다.

---

## 2) segments 테이블 / scene별 훅 점수 실제 생성·저장 여부

### A. `segments` 테이블은 존재

`server/services/highlightPatternDbService.js:124-131`

```sql
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_time REAL,
  end_time REAL,
  event_type TEXT,
  description TEXT
);
```

하지만 이 테이블은 **scene별 훅 점수 테이블이 아니다.**

### B. `scores` 테이블은 오히려 drop 대상

`server/services/highlightPatternDbService.js:35-40`

- 기존 `scores` 테이블은 drop됨
- 이유 주석에 이미 `hook_density`/old segment scoring은 퇴역했다고 명시

### C. scene별 훅 점수는 어디에 저장되나?

현재 제품 플로우에서 scene별 훅 점수는 **DB 테이블로 별도 영속화되는 게 아니라**
`ottogi_guide_output.scene_transitions` 안에 포함된 채 `item_config.json`에 저장되는 구조다.

근거:

- `applyOttogiGuideToItem()`이 `guide.scene_transitions`를 normalize해서 item config에 넣음
  - `server/services/processQueueService.js:4779-4783`

즉:

- **scene별 훅 점수는 실제로 생성된다**
- 하지만 **`segments` 테이블에 저장되는 게 아니라 queue item guide JSON에 포함**된다

---

## 3) 훅 점수 → 컷 선택 연결: 원래 하이라이트 컷 로직은 어디 있었나

### A. 원래 shortform/scene score 기반 핵심 함수

`server/services/processQueueService.js`

1. `scoreNaturalRepetitionWindow()`
   - `visual_hook_score`, `repetition_potential`, `mechanical terms`, `tempo`류를 합산
   - `server/services/processQueueService.js:6897-6930`

2. `pickHighlightWindow(itemConfig, maxDurationSec)`
   - scene transitions를 받아 strongest window를 고름
   - `guide.recommended_highlight_window`도 우선 고려
   - shortform에서는 transitions를 스코어링해 strongest window 선택
   - `server/services/processQueueService.js:6932-7058`

3. `collectHighlightCandidateWindows()`
   - `recommended_highlight_window`
   - `hook_clip_10s`
   - `shortform_candidate_windows`
   - `hook_candidates`
   - `highlight_candidates`
   - 그리고 scene transitions 자체를 score-ranked candidate로 확장
   - `server/services/processQueueService.js:7114-7184`

4. `pickHighlightWindows()`
   - `pickHighlightWindow()` + `collectHighlightCandidateWindows()`를 섞어 다중 후보 선택
   - `server/services/processQueueService.js:7186-7243`

요약하면, 원래 하이라이트 설계는:

- **scene transitions / hook candidates / guide window**를 수집하고
- **hook score 기반으로 strongest scene/window를 anchor로 뽑는 구조**였다.

### B. longform 쪽도 같은 훅 계열을 공유

`selectBestHighlightWindow()` / `getDefaultLongformHighlightWindows()` / `getLongformFullCandidateWindows()`는
longform candidate windows를 다시 hook score 기반으로 정렬하는 축이다.

관련 라인:

- `selectBestHighlightWindow()` — `server/services/processQueueService.js:7283-7291`
- `getDefaultLongformHighlightWindows()` — `7245-7270`
- `getLongformFullCandidateWindows()` — `7294-7309` 이후

### C. 지금도 호출되나?

**현재 발행 경로에서는 사실상 아니다.**

현재 실제 발행 highlight 호출은:

- `createHighlightDraftForItem()` → `await pickProductionHighlightWindow(...)`
  - `server/services/processQueueService.js:8380`
- `createKoreanHighlightDraftForItem()` → `await pickProductionHighlightWindow(...)`
  - `server/services/processQueueService.js:9136`
- `generateQueue()` → `await pickProductionHighlightWindow(...)`
  - `server/services/processQueueService.js:9725`

반면 `pickHighlightWindow()` / `pickHighlightWindows()`는 grep상 **외부 실사용 호출이 거의 안 보인다.**

대표 확인:

- `pickHighlightWindow(` 검색 결과는 사실상 `selectBestHighlightWindow()` 내부 fallback (`7291`)만 확인됨

즉 현재 상태에서는 **원래 훅 앵커 기반 선택 함수가 코드엔 남아 있지만, 실배치 발행 highlight 경로의 selector는 아니다.**

---

## 4) 내가 덮은 것: 최근 완결 컷/6초 하한/result_reveal 로직이 우회한 부분

현재 발행 selector는 `pickProductionHighlightWindow()`다.

핵심 흐름:

- `loadOrExtractHighlightTimeline()`
- `buildLoopCompleteHighlightWindow()`
- `buildResultRevealHighlightWindow()`
- 둘 다 없으면 `null`

출처:

- `server/services/processQueueService.js:6864-6891`

이 경로는 **scene transition의 `visual_hook_score`를 읽지 않는다.**

즉 최근 변경(완결 컷 / result_reveal 완결)은

1. `collectHighlightCandidateWindows()`가 수집하던
   - `recommended_highlight_window`
   - `hook_clip_10s`
   - `shortform_candidate_windows`
   - `hook_candidates`
   - `highlight_candidates`
   - `scene_ranked_highlight_candidate`

2. `pickHighlightWindow()`가 하던
   - strongest-scene anchor selection
   - hook score / repetition score / mechanical rhythm 기반 window selection

을 **실제 발행 selector 자리에서 우회**한 셈이다.

### 최근 로직이 꺼버린/우회한 부분

- **scene/hook score 기반 window scoring**
- **guide candidate window 기반 선택**
- **scene-ranked highlight candidate fallback**

대신 지금은:

- timeline event (`IMPACT/RESET/RESULT_REVEAL`)만으로
- loop complete 또는 result reveal completion cut을 고른다.

---

## 5) 원래 훅 앵커 로직으로 되돌리려면 무엇을 복원/제거해야 하나

되돌리려면 “필드를 복원”할 필요보다 **selector를 원래 축으로 되돌리는 것**이 핵심이다.

### 되살릴 대상

실제로 살아 있는 기존 자산:

- `scene_transitions.visual_hook_score` 등 scene scoring fields
- `shortform_candidate_windows`
- `hook_clip_10s`
- `hook_candidates`
- `recommended_highlight_window`
- `pickHighlightWindow()`
- `collectHighlightCandidateWindows()`
- `pickHighlightWindows()`

### 우회/제거해야 할 현재 축

- `pickProductionHighlightWindow()`가 발행 selector로 직접 쓰이는 부분
  - `createHighlightDraftForItem()` caller
  - `createKoreanHighlightDraftForItem()` caller
  - `generateQueue()` caller

즉 복원 방향은:

1. 발행 highlight selector를 `pickProductionHighlightWindow()` 단독에서 빼고
2. `pickHighlightWindow()` / `collectHighlightCandidateWindows()` 축을 다시 primary로 세운 뒤
3. loop/result timeline 완결 로직은 **보정 fallback** 또는 validation gate로 내리는 것

이게 “원래 훅 앵커 로직으로 되돌리는” 실제 작업이다.

---

## 6) 하이라이트 vs 풀드래프트 분기: 원래는 어떻게 갈랐나

원래 설계는 **같은 guide/scene 분기에서 둘 다 뽑는 구조**였다.

근거:

- metadata schema에 동시에 존재:
  - `hook_clip_10s`
  - `story_clip_40s`
  - `recommended_highlight_window`
  - `recommended_full_window`
  - `recommended_midform_window`
  - `scene_transitions`
  - `shortform_candidate_windows`

출처:

- `server/services/processMetadataService.js:412-436`, `509-525`

또 `applyOttogiGuideToItem()`에서 full draft duration은:

- `guide.story_clip_40s?.duration_sec`
- `|| guide.recommended_full_window?.duration_sec`

를 본다.

출처:

- `server/services/processQueueService.js:4762-4766`

즉 원래는:

- **같은 scene/hook analysis 한 번**에서
  - highlight용 hook window
  - full/story용 window
  - midform용 window

를 같이 뽑고,
후단이 그걸 variant별로 소비하는 구조였다.

---

## 최종 정리

### 살아 있는 부분

- 훅 점수 필드 스키마
- prompt 지시
- scene_transitions 기반 hook scoring model
- highlight/full/midform 후보 window 구조
- hook 후보 생성 보조 함수들

### 내가 덮은 부분

- **실제 발행 highlight selection 자리**
- 현재는 scene/hook score가 아니라
  - `loop_complete_reset_cycle`
  - `result_reveal_completion_cut`
  timeline event selector가 우선

### 한 문장 결론

원래 훅 기반 장면 분기 시스템은 **데이터/스키마/보조 함수로는 살아 있지만**,
**실제 발행 하이라이트 selector 자리는 최근 completion-cut 로직이 대체한 상태**다.
