# 하이라이트 window 선택 로직 8f97458 원복 보고

작성일: 2026-07-21

## 배경

`processQueueService.js`의 하이라이트 window 선택 부분이 8f97458(정상 동작 확인 커밋) 이후
미커밋 워킹트리 변경으로 오염된 상태였다. `capcut_draft.py`는 이미 `git checkout 8f97458`로
복구되어 있었고(item_026 18세그먼트 확인 완료), 남은 작업은 `processQueueService.js`의
window 선택 계열만 선별적으로 8f97458 상태로 되돌리는 것이었다.

## 작업 범위

되돌린 대상(window 선택 계열 전부):

- `pickProductionHighlightWindow`, `pickHookAnchoredProductionWindow`,
  `buildLoopCompleteHighlightWindow`, `buildResultRevealHighlightWindow`,
  `loadOrExtractHighlightTimeline`(action timeline 캐시),
  `assertPublishableProductionHighlightWindow`(publish hold),
  `getShortformHighlightPublishMaxDurationSec`, hook evidence 빌더 등
  신규 함수 15개, 총 382줄 제거
- 상수 원복: `SHORTFORM_HIGHLIGHT_MAX_DURATION_SEC` 23.999 → **10**,
  `LONGFORM_HIGHLIGHT_MAX_DURATION_SEC` → **24**, 3초 하한 상수 삭제
- JP/KR 하이라이트 호출부를 `selectedOverrideWindow || pickHighlightWindow(...)`
  원래 경로로 복귀
- `generateQueue`의 longform 분기를 `selectBestHighlightWindow`
  (+ `getDefaultLongformHighlightWindows` fallback 복원) 원래 코드로 복귀
- 부수 오염 제거: `HIGHLIGHT_INELIGIBLE`/`held` 상태 분기,
  manifest·notes의 `hook_selection_evidence`/`completion_refinement_*` 필드,
  `jp_highlight_exact`/`kr_highlight_exact`(정의처 없는 dangling 정책 ID),
  `extractActionTimeline`/`findCycleAlignedWindow` import

보존한 대상(되돌리지 않음, hunk 단위로 확인):

- Vertex ADC 인증 통일, timeline 좌표 clamp (`geminiService.js` 쪽, 이번 파일과 무관)
- 풀드래프트 관련 전부: 검수 게이트(`script_review`), KR full SRT 전달,
  TTS 플랜/수리 함수, `fullDraftRules` 기반 skip 로직
- Track B 격리 코드

8f97458 대비 잔여 diff에서 highlight/window를 언급하는 라인은
`decideOutputModeForItem` 호출 1줄(풀드래프트 skip 로직)뿐임을 확인했다.

## 검증

### 1. 가드 스크립트

| 스크립트 | 결과 |
|---|---|
| `npm run check:encoding` | ok (84 files) |
| `npm run check:shortform-highlight` | ok |
| `scripts/check-metadata-repair-guards.js` | ok |
| `scripts/check-output-config-contract.js` | ok |
| `npm run verify` (encoding + contract + build) | 통과 |

### 2. item_026 재생성 (batch `revert_verify_item026`, 성공)

새 드래프트: `20260721-H-005439-職人のパン作り 生地から黄金の焼き上がりまで [CHECKOUT-8f97458]`

`edit_manifest.json` 인용:

```json
{
  "source_window": {
    "start_sec": 0.455,
    "duration_sec": 10,
    "end_sec": 10.455,
    "score": 1505.8,
    "reason": "natural_repetitive_mechanical_hook_window",
    "selection_strategy": "natural_source_repetition_no_artificial_loop",
    "selected_scene_ids": ["scene_001","scene_002","scene_003","scene_004","scene_005",
                            "scene_006","scene_007","scene_008","scene_009","scene_010"],
    "cut_selection_tier": "T1"
  }
}
```

- **a. 원래 셀렉터 사용 확인**: `selection_strategy: natural_source_repetition_no_artificial_loop`,
  `reason: natural_repetitive_mechanical_hook_window` — `pickHighlightWindow`의 scene 스코어 경로.
  `hook_selection_evidence`/`completion_refinement_*` 필드는 manifest에 미존재(신규 로직 흔적 없음).
- **b. video 세그먼트 수**: 메인 video 트랙 **9세그먼트** + 오버레이 video 트랙 2 → ≥2 유지.
- **c. source 구간**: **0.455s ~ 10.455s (10.0s)**, `scene_001~scene_010` 선택,
  `score 1505.8`, `cut_selection_tier T1` — 0~24 통짜가 아니라 훅 장면 중심 10초 창.

## 결론

기준(8f97458과 동일 동작)을 충족했다. 새 셀렉터 로직 작성이나 "개선" 시도는 하지 않았으며,
검증값은 재생성된 실제 manifest에서 직접 인용했다.

## 다음 제안

1. **회귀 방지 가드 추가 검토**: `check-shortform-highlight-contract.js`처럼
   `pickHighlightWindow`/`selectBestHighlightWindow`가 유일한 선택 경로임을
   문자열 계약으로 고정하는 스크립트가 없다. 이번처럼 워킹트리에 새 셀렉터가
   슬쩍 추가되는 회귀를 잡으려면 `scripts/check-highlight-window-selector-contract.js`
   같은 가드를 추가하는 것을 권장한다.
2. **미커밋 변경 정리**: 이번 대화 시작 시점 `git status`에 남아 있던 나머지
   미커밋 변경(`server/routes/*.js`, `server/services/*.js` 다수)도 8f97458 이후
   의도된 변경인지 오염인지 확인이 필요하다. 특히 `capcutService.js`,
   `highlightSlicerService.js`, `highlightPatternDbService.js`는 하이라이트와
   직접 연관되므로 우선 검토 대상으로 제안한다.
3. **커밋 시점 판단**: 현재 워킹트리는 검증 통과 상태이므로, 사용자가 원하면
   이번 되돌리기 결과를 별도 커밋으로 분리해 이후 변경과 섞이지 않게 하는 것을
   권장한다(사용자 명시적 지시 시에만 커밋 진행).
