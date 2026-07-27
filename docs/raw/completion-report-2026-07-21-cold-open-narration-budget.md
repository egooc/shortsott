# Completion Report — 콜드오픈 나레이션 길이 예산 + 앞단 마무리 검증

Date: 2026-07-21

## 적용한 수정

`server/services/midformCompressionService.js`, `buildSlotFillsPrompt()`:

- cold_open 나레이션 규칙 추가: 단문 훅 한 문장만, 설명/답 금지, 공백 제외 20-30자(~4-6초) 타깃, 스타일 예시 한 줄 제공.
- bridge/일반 NARRATE는 기존 방식(나레이션 길이만큼 시간 배정) 그대로 — 콜드오픈만 예외로 처리.

**treaty anchor(payoff 3-anchor 허용)는 코드 수정을 하지 않았습니다.** `isRevealHeavyBeat()` / `REVEAL_BEAT_MAX_ANCHOR_LINES = 3` / `maxAnchorsForBeat()`가 이미 지난 세션(`docs/raw/completion-report-2026-07-20-payoff-anchor-3line.md`)에 구현·검증되어 있는 걸 코드에서 확인했습니다. 이번엔 재검증만 했습니다.

## 검증 중 추가로 발견한 버그 (승인 범위는 아니지만 같은 영역이라 바로 고침)

Catch the Bullet을 반복 재실행하며 확인하던 중, 이전 라운드에서 13.6초로 넓어졌던 콜드오픈 창이 **새로 짧아진 나레이션(4.5초)에도 다시 줄어들지 않고 13.6초로 고정된 채 남는 문제**를 발견했습니다. 기존 로직이 "창이 나레이션보다 작을 때만 넓힌다"였고, 그보다 클 때 줄이는 경로가 없었기 때문입니다. `compress-apply`를 반복 실행할 때마다 창이 커지기만 하고 절대 줄지 않는 구조라, 방치하면 프롬프트 수정 효과 자체가 무의미해지는 문제였습니다.

수정: `resizeColdOpenWindow()`로 교체해 매번 **안정적인 중심점(`visual_source_center_sec`, 원래 포커스 대사 중심)을 기준으로 나레이션 길이에 맞춰 창을 다시 계산**하도록 했습니다(넓히기/줄이기 양방향). `finalizeEditPlan()`에도 이 중심점을 처음부터 기록해 재계산이 매번 안정적으로 같은 기준점에서 이뤄지게 했습니다.

## 검증 — Catch the Bullet (재실행)

`compress-apply`를 다시 돌린 결과:

- 나레이션: 짧은 의문형 한 문장으로 생성됨 (질문형 훅, 설명/답 없음)
- `narration_estimated_duration_sec: 4.467`
- 콜드오픈 창: 13.634s → **4.468s로 재조정**, `status: "resized"`

```json
"duration_check": {
  "status": "resized",
  "narration_estimated_duration_sec": 4.467,
  "original_visual_window_sec": 13.634,
  "adjusted_visual_window_sec": 4.468,
  "suggested_action": "Cold-open teaser visual window resized from 13.634s to 4.468s to match narration."
}
```

4-6초 목표 범위 안에 들어옴 — 통과.

## 검증 — Twilight (신규 런: `compress_20260721021138_ngYmFVO_bzM`)

### 콜드오픈

- 나레이션: 짧은 의문형 한 문장 ("그 해변 이름만 듣고, 왜 그는 갑자기 굳어버렸을까?" 스타일)
- `narration_estimated_duration_sec: 4.883`
- 콜드오픈 창: 3s → **4.884s로 재조정**, `status: "resized"`

4-6초 목표 범위 안 — 통과.

(참고: 이번 Twilight 런은 Codex edit-plan 생성이 실패해 로컬 폴백 플래너 경로를 탔습니다 — `cold_open_selection.reason`에 그렇게 기록돼 있습니다. 폴백 경로에서도 콜드오픈 길이 예산이 정상 동작하는 것까지 같이 확인된 셈입니다.)

### Payoff anchor (treaty)

`slot_08` (`beat_07`, role `payoff`)의 `dialogue_focus_quotes`에 요청하신 3줄이 모두 들어있음을 확인:

```json
"dialogue_focus_quotes": [
  ">> Okay. Um, did you know kuutes are supposedly descended from wolves?",
  "But they claimed to be something different. So, we made a treaty with them.",
  ">> What are they really?"
]
```

- wolves ✅
- treaty ✅
- what are they really ✅

셋 다 통과.

## 결론

말씀하신 두 검증(콜드오픈 4-6초 짧은 훅 / Twilight payoff 3-anchor) 모두 통과했습니다. 앞단(비트분할 / 콜드오픈 짧은 훅 / anchor 보장 / 폴백 / 길이계산)이 정리하신 기준대로 완성됐습니다.

## 다음

- `8yixKocFDeA` 히트맵 경로 확인 — 선택, 보류 유지
- Phase 2 (bootstrap 접점) — 진행 여부 컨펌 주시면 시작하겠습니다
