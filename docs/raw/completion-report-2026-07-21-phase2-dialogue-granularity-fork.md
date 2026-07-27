# Phase 2 진행 보고 + 설계 분기 발견 (KEEP_DIALOGUE 자막 싱크)

Date: 2026-07-21

## 지금까지 완료 (전부 node --check + require 로드 검증됨)

System A(압축 서비스) 쪽 변경 완료:

1. `buildSlotFillsPrompt()`에 KEEP_DIALOGUE 한국어 자막(`caption_kr_dialogue`) 규칙 추가 — 1:1 대응/구어체/호칭 통일.
2. `midform_slot_fills_schema.json`에 `caption_kr_dialogue` 추가 (required 아님 — NARRATE 슬롯 안 깨지게).
3. `validateSlotFillsDialogueCaptions()` — KEEP_DIALOGUE 슬롯의 `caption_kr_dialogue` 개수가 `dialogue_focus_lines`와 정확히 일치하는지 compress-apply 시점에 검증.
4. 콜드오픈 겹침 회피 — `subtractReservedRanges`/`pickBestFreeWindow`/`tryColdOpenVisualSourceForBeat` + `selectColdOpenVisualSource`가 KEEP_DIALOGUE 예약 구간을 피해 티저 창 선택. 호출부에서 실제 예약 구간 계산해 전달까지 연결.
5. `downloadCompressionSourceVideo()` — 압축 run 폴더에 실제 소스 영상 다운로드(idempotent), 매니페스트에 경로 기록.

## 어댑터(System B 브릿지) 착수 중 발견한 분기

어댑터가 KEEP_DIALOGUE 슬롯을 System B의 `dialogue_quote` 세그먼트로 변환하는데, 실제 조립 코드(`capcut_draft.py`)를 추적해보니 **두 시스템의 대사 단위 모델이 다릅니다.**

- **System A의 KEEP_DIALOGUE 슬롯**은 여러 대사 줄을 담은 **하나의 구간**입니다. 예: Catch the Bullet `slot_03`은 82.94–112.12초(29.18초) 한 구간에 대사 3줄.
- **System B의 `dialogue_quote` 모델**은 원래 **짧은 명대사 1개 = 세그먼트 1개**로 설계됐습니다.

### 조립 코드의 실제 자막 타이밍 (`capcut_draft.py` 추적 결과)

대사(비-TTS) 세그먼트의 자막 타이밍은:
- `estimate_non_tts_caption_duration_us`: 세그먼트 타임라인 길이 = `소스클립_총길이 / 자막유닛_개수` (균등 분할).
- 한국어 자막 텍스트(`translated_caption_ko`)는 조립 스크립트의 11자 청킹 규칙으로 다시 쪼개지고, 그 조각들이 **구간 전체에 문자수 비례로 균등 분산**됩니다.
- 즉 각 원본 영어 대사가 실제 발화되는 정확한 시점에 자막이 붙는 게 아니라, **구간 전체에 걸쳐 균등하게 흩뿌려집니다.**

### 이게 왜 문제인가

"대사 5줄인데 자막이 뭉치면 싱크 어긋난다"고 하신 우려가 여기서 실제로 걸립니다. 한 KEEP_DIALOGUE 구간(29초, 3줄)을 세그먼트 1개로 넣으면, 한국어 자막 3줄이 원본 대사 3줄의 실제 발화 시점에 각각 붙는 게 아니라 29초에 균등 분산됩니다. 대사 사이 간격이 불규칙하면(한 줄 말하고 5초 침묵 후 다음 줄) 자막이 실제 대사보다 앞서거나 늦습니다.

## 분기 — 결정 필요

### 옵션 A: 슬롯 1개 = 세그먼트 1개 (승인된 계획의 매핑 그대로)
- KEEP_DIALOGUE 슬롯 하나를 dialogue_quote 세그먼트 하나로. `caption_kr_dialogue`를 이어붙여 `translated_caption_ko`로.
- 장점: 단순, 어댑터 구현 작음, 계획대로.
- 단점: 자막이 구간 전체에 균등 분산 — 원본 대사 발화 시점과 정확히 안 맞음. 여러 줄 구간일수록 드리프트 큼.

### 옵션 B: 대사 줄 1개 = 세그먼트 1개 (진짜 라인 락 싱크)
- KEEP_DIALOGUE 슬롯을 `dialogue_focus_lines` 개수만큼 세그먼트로 분할, 각 세그먼트가 그 줄의 정확한 원본 자막 구간(transcript cue의 start/end)을 소스로 갖고, 그 줄의 한국어 자막 1개를 실음.
- 장점: 각 한국어 자막이 해당 원본 대사가 실제 발화되는 시점에 정확히 붙음. System B의 "1대사=1세그먼트" 원래 모델과도 일치. 겹침/단조성/VAD 게이트 모두 통과 가능(줄들은 구간 내 순서대로 인접·비겹침).
- 단점: 각 `dialogue_focus_line`을 transcript cue의 정확한 [start,end]에 매칭해야 함. 현재 edit_plan은 병합된 구간 하나만 내보내고 줄별 시점은 없음 → `finalizeEditPlan`(또는 어댑터)에서 줄↔cue 매칭을 새로 해야 함. VTT 자동자막이 누적/중복 텍스트라 매칭이 퍼지함(압축 서비스에 이미 `collectDialogueFocus`/`scoreCueAgainstQuote` 퍼지 매칭 로직은 있음 — 이걸 줄 단위로 재사용 가능).

## 추가로 발견한 게이트 (양 옵션 공통, 참고)

- **VAD 게이트 (`MIDFORM_DIALOGUE_VAD_FAILED`):** 대사 세그먼트의 소스 창에 실제 오디오 활동이 없으면 실패 또는 근처 활동으로 스냅. 우리 KEEP_DIALOGUE는 실제 대사라 통과 예상이나, 창 경계가 침묵에 걸리면 스냅/경고 발생 가능.
- 단조성/겹침 게이트는 계획대로 대응(스크립트에 slot_map 키 미포함 + 콜드오픈 예약구간 회피 + 어댑터 preflight).

## 내 추천

**옵션 B.** 이유: (1) 사용자가 명시적으로 우려한 싱크 문제를 근본적으로 해결, (2) System B 원래 모델과 일치해 조립 게이트와 덜 싸움, (3) 압축 서비스에 이미 있는 퍼지 매칭 로직 재사용 가능. 비용은 줄↔cue 매칭 로직 추가인데, 이건 어차피 데어데블식 "자막이 엉뚱한 데 붙는" 버그를 막는 핵심이라 값어치가 있음.

옵션 A는 구현이 빠르지만, 이번 작업의 목적 자체가 "싱크/무음 같은 접점 버그 재발 방지"라 균등분산 드리프트를 남기는 건 목적과 어긋남.
