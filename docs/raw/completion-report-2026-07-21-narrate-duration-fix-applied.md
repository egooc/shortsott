# Completion Report — NARRATE 길이 재계산 + 하드 검증 적용

Date: 2026-07-21

## 적용한 수정 (승인된 4가지 그대로)

`server/services/midformCompressionService.js`:

1. **한국어 나레이션 길이 추정 유틸 추가** — `estimateKoreanNarrationSeconds()`. 공백 제외 글자 수 ÷ 4.8자/초 + 0.3초 여유(호흡/휴지), 최소 1.5초. 상수에 "휴리스틱이며 실제 TTS 길이가 정답"이라는 주석을 달아뒀습니다(정확도 한계 인지 표시).
2. **재계산 시점 이동** — `runCompressionApply()`가 `compression_slot_fills.json`을 쓴 직후, 새 함수 `recalculateNarrationDurations(editPlan, slotFills, beats)`를 호출해 실제 생성된 한국어 나레이션 글자 수로 NARRATE 슬롯들의 `estimated_duration_sec`을 다시 계산하고, 그 결과를 `edit_plan.json`에 덮어씁니다.
3. **하드 검증 = 경고 + 조정 제안 (에러 아님)**:
   - cold_open: 나레이션 추정 길이가 현재 티저 비주얼 창보다 길면, `widenColdOpenWindow()`로 **창을 늘리는 쪽(옵션 b)을 우선 적용**합니다. 소스 비트(`visual_source_beat_id`)의 실제 시작/끝 범위 안에서만 늘리고, 임의의 4.5초/6초 캡은 걸지 않습니다.
   - 소스 비트 범위를 다 써도 안 맞으면(`fits: false`) `status: 'needs_narration_trim'`으로 표시하고, 얼마나 줄여야 하는지(초 단위) 구체적 제안 문구를 `duration_check.suggested_action`에 남깁니다. **에러를 던지지 않습니다** — draft-first 철학대로.
   - bridge/일반 NARRATE는 경쟁하는 고정 비주얼 창이 없으므로, 나레이션 추정 길이를 그대로 `estimated_duration_sec`으로 채택합니다.
4. **KEEP_DIALOGUE는 손대지 않았습니다** — `focusDurationForBeat`/`finalizeEditPlan`의 원본 구간 기준 로직 그대로.

추가로 `runCompressionApply()`가 `compression_manifest.json`도 다시 써서, 재계산된 `coldOpenSelection`(넓어진 티저 창 포함)과 새 `narrationDurations` 배열(슬롯별 `estimated_duration_sec`, `narration_estimated_duration_sec`, `duration_check`)을 여기에 싣습니다. 이게 요청하신 "Phase 2가 앞단에서 계산한 시간을 그대로 읽어가게" 하는 부분입니다.

CLI(`scripts/midform.js`)도 `compress-apply` 출력에 `edit_plan_path`를 추가하고, `needs_narration_trim` 경고가 있으면 콘솔에 바로 찍도록 했습니다.

## 실전 검증 — Catch the Bullet 재실행

같은 런(`compress_20260720213249_3e-5BAhZQ5w`)에 `compress-apply`를 다시 돌려 확인했습니다 (나레이션이 새로 생성되므로 이전과 문구는 다릅니다).

**slot_01 (cold_open) 결과:**

```json
"duration_check": {
  "status": "widened",
  "narration_estimated_duration_sec": 13.633,
  "original_visual_window_sec": 3.57,
  "adjusted_visual_window_sec": 13.634,
  "suggested_action": "Cold-open teaser visual window widened from 3.57s to 13.634s to match narration."
}
```

- 티저 비주얼 창이 `82.438–96.072`(13.634초)로 넓어졌고, `timeline[slot_01].estimated_duration_sec`도 13.634로 갱신됨 — 로직이 의도대로 동작 확인.
- `compression_manifest.json`의 `coldOpenSelection.teaser_visual_start_sec/end_sec`과 `narrationDurations[0]`에도 동일하게 반영됨 — Phase 2가 매니페스트만 읽어도 정확한 창/길이를 확보.
- body_peak(slot_06, 143.04초)이 여전히 cold_open(13.634초)보다 훨씬 길어서, 기존 `validateEditPlan`의 "body_peak는 티저보다 길어야 한다" 불변식은 안 깨졌습니다.

**slot_02 (bridge) 결과:** `narration_estimated_duration_sec: 15.925` → `estimated_duration_sec` 동일하게 갱신, `status: ok`.

## 새로 발견된 것 — 이번 재계산이 드러낸 2차 이슈

수정 자체는 정상 동작하는데, 이번 실행에서 나온 실제 나레이션이:

> "멀리서 들린 한 번의 소리가 추격대의 발을 멈춥니다. 그런데 이상한 건, 이 소리가 단순한 위협이 아니라 누군가가 일부러 놓은 신호처럼 보인다는 겁니다."

두 문장짜리라 13.6초로 늘어났습니다. 이건 계산 버그가 아니라 — cold_open 나레이션 자체가 "3-6초 티저"라는 원래 설계 의도(edit_plan의 `reason` 필드에도 그렇게 적혀 있음)에 비해 너무 김니다. `buildSlotFillsPrompt`에는 cold_open 나레이션 길이를 짧게 쓰라는 지침이 없어서, LLM이 훅 한 줄 대신 설명형 두 문장을 씁니다.

**이건 이번에 승인받은 범위 밖이라 코드를 건드리지 않았습니다.** 다만 구조적 구멍은 이제 닫혔지만("창이 작아서 넘친다"는 더 이상 안 생김), 대신 "나레이션이 길어지면 창이 한없이 늘어나 티저의 긴장감이 죽는" 새로운 품질 리스크가 생길 수 있습니다. 필요하시면 `buildSlotFillsPrompt`에 cold_open 전용 길이 예산(예: 공백 제외 20~25자, ~5-6초 타깃)을 추가하는 걸 다음 작업으로 제안드립니다 — 옵션(a)를 프롬프트 단에서 유도하는 방식이라 지금 만든 옵션(b) 폴백과 상호 보완적입니다.

## 남은 항목 (말씀하신 정리 그대로)

1. ~~길이 재계산 + 하드 검증~~ — **완료, 검증됨**
2. **treaty anchor (payoff 3개 허용)** — 아직 미착수. 이번 세션에서 건드리지 않았습니다.

`8yixKocFDeA` 히트맵 경로 확인은 계속 보류 상태입니다.
