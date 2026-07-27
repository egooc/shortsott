# Completion Report — NARRATE 슬롯 길이 추정 기준 확인

Date: 2026-07-21

## 확인 요청

> estimated_speech 계산이 나레이션 "한국어 글자 수" 기준인가, 아니면 원본 영어 구간 길이인가?

## 결론

**원본(영어) 구간/비주얼 길이 기준입니다. 한국어 텍스트 글자 수는 어디에서도 계산에 들어가지 않습니다.** 의심하신 그대로 버그이고, 슬롯 타입별로 실제로 공식이 섞여 있는 게 아니라 — **NARRATE 계열은 전부 한국어 텍스트와 무관하게 계산되고, KEEP_DIALOGUE만 원본 구간 기준으로 맞게 계산됩니다.**

## 코드 근거

`server/services/midformCompressionService.js` 기준:

### 1. cold_open 슬롯 — `finalizeEditPlan()` (line 694-710)

```js
cold.estimated_duration_sec = roundSec(Number(visualSource.end_sec) - Number(visualSource.start_sec));
// visualSource가 없으면:
cold.estimated_duration_sec = roundSec(Math.min(COLD_OPEN_VISUAL_TARGET_SEC, ...));
```

`visualSource`는 무음 티저 비주얼의 원본 영상 구간(`selectColdOpenVisualSource`가 고른 `start_sec`~`end_sec`, 초 단위 원본 타임코드)입니다. cold_open의 `estimated_duration_sec`는 **티저 비주얼 창 길이**로 강제 고정되며, `COLD_OPEN_VISUAL_TARGET_SEC = 4.5`초로 캡까지 걸립니다(line 20). 나레이션 텍스트는 이 시점에 아직 존재하지도 않습니다 — 뒤에서 설명하는 것처럼 나레이션은 `compress-apply` 단계(별도 실행)에서 생성됩니다.

→ Catch the Bullet `slot_01`의 `estimated_duration_sec: 3.57`은 정확히 `teaser_visual_start_sec(87.47) ~ end_sec(91.04)` 구간 길이입니다. 한국어 나레이션("쫓던 쪽은 보안관 일행이었는데...")과는 아무 관계가 없습니다.

### 2. bridge / 일반 NARRATE 슬롯 — Codex 생성 경로

`buildEditPlanPrompt`(line ~778-790)의 지침에는 "NARRATE compresses via narration"과 "Keep estimated_total_sec close to target_sec"만 있고, **NARRATE 슬롯의 `estimated_duration_sec`을 무엇 기준으로 산정해야 하는지에 대한 지침 자체가 없습니다.** Codex 모델이 임의로 채우는 값이고, 이 시점에도 한국어 나레이션 텍스트는 존재하지 않습니다.

### 3. 로컬 폴백 경로 — `narrationDurationForBeat()` (line 345-348)

```js
function narrationDurationForBeat(beat) {
  const sourceDuration = Math.max(4, Number(beat?.end_sec || 0) - Number(beat?.start_sec || 0));
  return roundSec(Math.min(18, Math.max(8, sourceDuration * 0.28)));
}
```

명시적으로 **원본 비트의 영어 구간 길이(`beat.end_sec - beat.start_sec`) × 0.28**을 씁니다. 한국어 글자 수는 인자로 들어오지도 않습니다.

### 4. KEEP_DIALOGUE 슬롯 — `focusDurationForBeat()` (line 350-354) / `finalizeEditPlan()` line 681

```js
next.estimated_duration_sec = roundSec(focus.end_sec - focus.start_sec);
```

이건 원본 대사가 그대로 재생되므로 **영어 구간 길이가 맞는 기준**입니다. 여기는 문제없습니다.

## 구조적 원인

`edit_plan.json`(길이 추정치 포함)은 `compress` 단계에서 생성되고, 실제 한국어 나레이션 텍스트는 그보다 **나중에** 별도 명령인 `compress-apply`(`buildSlotFillsPrompt`, line 808)에서 생성됩니다. 즉 **길이를 추정하는 시점에 한국어 텍스트가 아직 존재하지 않는 순서 문제**입니다. 그리고 `compress-apply` 이후에도 생성된 실제 나레이션 글자 수를 다시 측정해서 `estimated_duration_sec`이나 티저 비주얼 창과 대조·검증하는 코드가 없습니다. `compression_slot_fills.json`의 `quality_check.budget_violations`는 슬롯 채움과 같은 LLM 호출이 자체 채점한 값이라, 슬롯_01처럼 실제로는 6-7초 분량 텍스트가 3.57초 창에 들어간 케이스도 `budget_violations: 0`으로 보고됩니다.

## 영향 범위

- cold_open: 항상 원본 티저 비주얼 창 길이로 고정 (최대 4.5초) — 한국어 텍스트와 완전 무관
- bridge / 기타 NARRATE: Codex 임의값이거나(코덱스 경로) 원본 영어 구간 × 0.28(폴백 경로) — 둘 다 한국어 텍스트와 무관
- KEEP_DIALOGUE: 원본 구간 기준 — 정상, 수정 불필요

말씀하신 "슬롯 타입에 따라 길이 계산이 달라야 한다"는 진단이 정확하고, 지금은 그 분기 자체가 없이 **NARRATE 전체가 원본/비주얼 길이 기준으로 잘못 계산되는 구조**입니다. 데어데블 때의 무음구간/길이초과 재발 리스크 지적도 근거가 명확합니다 — 특히 cold_open은 비주얼 창이 4.5초로 캡되어 있는데 나레이션이 그보다 길면 매번 구조적으로 넘칩니다.

## 다음 제안 (수정안, 아직 미적용)

1. **한국어 나레이션 길이 추정 함수 추가.** 코드베이스에 재사용 가능한 TTS/글자수 기반 길이 추정 유틸이 없음을 확인했습니다(`elevenlabsService.js`, `captionUnits.js` 등 검색 완료). 한국어 평균 발화 속도 기준(초당 약 4~4.5자, 공백 제외) 휴리스틱을 새로 추가해야 합니다.
2. **재계산 시점을 `compress-apply` 이후로 이동.** `runCompressionApply()`가 `compression_slot_fills.json`을 쓴 직후, NARRATE 결정인 슬롯들의 실제 생성된 나레이션 글자 수로 `estimated_duration_sec`을 다시 계산해 `edit_plan.json`에 반영(또는 병합 산출물 생성).
3. **하드 검증 추가.** cold_open은 티저 비주얼 창(`teaser_visual_start_sec`~`end_sec`)보다 나레이션 추정 길이가 길면 에러/경고로 플래그. bridge/일반 NARRATE도 페어링된 비주얼 소스 창이 있다면 동일하게 검증. `validateEditPlan()`의 6.5초 캡 체크(line 873)와 나란히 두는 게 자연스러워 보입니다.
4. **KEEP_DIALOGUE는 그대로 둡니다** — 이미 원본 구간 기준으로 맞습니다.

## 순서 관련

요청하신 순서(①길이 불일치 확인 → ②`8yixKocFDeA` 히트맵 경로 재확인 → ③Phase 2 bootstrap) 그대로 따르겠습니다. ①은 이 보고서로 확인 완료했고, 수정 적용 여부만 컨펌해주시면 바로 진행합니다. `8yixKocFDeA`는 선택사항으로 보류 상태로 둡니다.
