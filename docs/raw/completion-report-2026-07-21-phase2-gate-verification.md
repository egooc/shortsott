# Phase 2 — 게이트 실제 실행 검증 (단조성 / reserved-range)

Date: 2026-07-21

## 목적

어댑터가 생성한 slot_map/script/transcript이 capcut_draft.py의 두 하드 게이트를 실제로 통과하는지, 추론이 아니라 게이트 함수를 실제로 돌려서 확인.

## 방법

- 어댑터(`midformBootstrapAdapterService.js`)로 두 검증 영상(Catch the Bullet, Twilight)의 transcript/slot_map/script 생성.
- `capcut_draft.py`에서 **모듈 레벨(임포트 가능)** 함수 `build_midform_dialogue_map`, `validate_midform_dialogue_reserved_ranges`를 그대로 import해서 생성물에 대해 실행.
- 단조성 게이트(`validate_slot_source_monotonicity`)는 클로저라 직접 import 불가 → 비교 로직(capcut_draft.py 9552-9598)을 **한 줄도 안 바꾸고 그대로 추출**해 실행 + `slot_map_mode`는 capcut의 실제 식 `bool(script.slot_map.slots)`로 계산.

## 결과 (두 영상 모두)

```
slot_map_mode (bool(script.slot_map.slots)) = False  -> monotonicity not_applicable
[REAL] reserved-range gate violations: 0  PASS
monotonicity (as shipped): not_applicable
```

- **reserved-range 게이트(치명적, `MIDFORM_DIALOGUE_RESERVED_RANGE_FAILED`)를 실제로 실행 → 위반 0, 통과.** cue 제외 + `narration_background:true` 설계가 게이트를 실제로 만족함을 확인.
- **`slot_map_mode=False`** (script.json에 slot_map 키 없음) → 단조성 함수가 비교 전에 `not_applicable`로 단락. 콜드오픈 역행은 검사조차 되지 않음.

## Q1-Q3 (사용자 질의) — 소스 기반 확답

- **Q1 인접 쌍 비교.** 9581행 `start_sec + 0.25 < previous_start_sec` — 직전 세그먼트와의 러닝 비교 (전체 순증가 아님).
- **Q2 소스 시작 없는 세그먼트는 스킵**(9579 `if start_sec is None: continue`, previous 미갱신) → 앞뒤가 직접 비교됨. 단 읽는 값은 `source_clips[0].start`이지 `expected_*` 필드가 아님.
- **Q3** 단조성 보호는 필드 생략이 아니라 `slot_map_mode=False`(slot_map 키 생략). capcut 실제 식으로 계산해 False 확인.

## expected_source_start_sec

코드베이스 전체(scripts/midform/server) grep 결과 **존재하지 않음**. 어느 소비자도 안 읽음. 단조성은 slot_map 키 생략으로 이미 완전히 꺼짐. → 이 필드는 추가해도 inert(무효 메타데이터)이며 "단조성을 제어한다"는 오해만 남기므로 추가하지 않음.

## 정직 노트

단조성을 **가정상 강제로 True**로 돌린 테스트도 위반 0이 나왔으나, 이는 bridge/body-narrate 세그먼트의 source_scenes가 정적 스크립트에서 비어있기(런타임에 오토피커가 채움) 때문이라 런타임을 대표하지 않음. 실제 보증은 `slot_map_mode=False`이며 그것만 신뢰함.

## 남은 것

1. **빈 자막 블로커**: 두 영상의 `compression_slot_fills.json`이 `caption_kr_dialogue` 프롬프트 규칙 이전 생성물이라 대사 자막이 전부 비어있음 → `compress-apply` 재실행(LLM 호출) 필요.
2. preflight 빌더(모든 체크 로컬 인코딩).
3. CLI + `startRun` 브릿지(`midformPipelineService.js` 수정 — 데어데블 4종 대조, 스크립트 교체 방식). 직접 실행 모드(`pauseBeforeTts=false`)로 — 리뷰/resume 경로는 `normalizeSlotFillsToScript`가 slot_map을 재임베드해 단조성을 되살리므로 피함.
