# Midform Editorial Generalization Wave 2 진행 보고서

Date: 2026-07-27  
Scope: selector/QC metadata가 실제 cold-open 선택 결과를 바꾸도록 연결

## 요약

Wave 2 첫 패치로 teaser suitability와 micro-exchange metadata를 단순 보고 필드가 아니라 cold-open callback selector의 실제 ranking input으로 연결했습니다.

핵심 변화는 다음입니다.

- `bestColdOpenCallbackBeat()`가 beat 단위 점수만 보지 않고, anchor dialogue 후보와 transcript 기반 micro-exchange 후보를 함께 비교합니다.
- `required_support_action`이 선택 점수에 반영됩니다.
- unsupported high-context single-line rebuttal은 raw cold-open hook으로 통과하지 못하고, coherent micro-exchange가 있으면 그쪽이 선택됩니다.
- 사용자가/LLM이 지정한 `cold_open_selection.beat_id`는 여전히 존중하되, `bridge_required`인 단일 unsupported teaser에는 preference를 주지 않습니다.

## 변경 파일

- `server/services/midformCompressionService.js`
- `tests/dialogueSelectionTiming.test.js`

## 구현 내용

### 1. Micro-exchange 후보를 cold-open selector에 연결

새 helper를 추가했습니다.

- `supportActionSelectionWeight()`
- `coldOpenMicroExchangeFocusesForBeat()`
- `coldOpenFocusCandidatesForBeat()`

이제 cold-open callback 후보는 다음을 모두 포함합니다.

1. 기존 anchor dialogue focus
2. transcript adjacent turn에서 나온 micro-exchange focus

### 2. QC action 기반 ranking

`buildTeaserSuitabilityScore()`가 반환하는 `required_support_action`을 selection score에 반영했습니다.

가중치 방향:

- `none`: 강한 가산
- `merge_adjacent_lines`: 가산
- `extend_line_window`: 약한 가산
- `bridge_required`: 감점
- `downgrade_to_narrate`: 강한 감점 및 선택 제외

즉, hook potential이 높아도 문맥 의존적인 단일 rebuttal은 coherent exchange보다 우선되지 않습니다.

### 3. Planned cold-open beat preference 보존

기존 plan이 지정한 `cold_open_selection.beat_id`는 유지할 가치가 있으므로 bounded preference를 추가했습니다.

단, 이 preference는 다음 경우에만 적용됩니다.

- teaser QC가 `bridge_required`가 아니거나
- `bridge_required`라도 같은 beat 안에 추가 key dialogue가 있어 extend/merge로 repair 가능할 때

반대로 key dialogue가 단일 line뿐인 unsupported rebuttal은 preference를 받지 못합니다.

## 추가 regression

`tests/dialogueSelectionTiming.test.js`에 다음 regression을 추가했습니다.

- `finalizeEditPlan prefers coherent micro-exchange over unsupported high-hook single-line teaser`

이 테스트는 다음을 증명합니다.

1. `cold_open_selection.beat_id`가 unsupported high-hook single line을 가리켜도 그대로 통과하지 않습니다.
2. adjacent accusation/rebuttal micro-exchange가 있으면 cold-open beat가 그 exchange로 바뀝니다.
3. 선택된 hook의 `dialogue_selection_scores.required_support_action`은 `merge_adjacent_lines`입니다.
4. 최종 slot의 `qc_action.action`도 `merge_adjacent_lines`로 남습니다.

## 검증 결과

### LSP diagnostics

- `server/services/midformCompressionService.js`: error 0
- `tests/dialogueSelectionTiming.test.js`: error 0

### Focused test

```bash
node --test tests/dialogueSelectionTiming.test.js
```

Result:

```text
tests 8
pass 8
fail 0
```

### Unit test suite

```bash
node --test tests/*.test.js
```

Result:

```text
tests 28
pass 28
fail 0
```

### Full project verification

```bash
npm run verify
```

Result: passed

Included gates:

- `npm run check:encoding`
- `npm run verify:js`
- `npm run verify:py`
- `npm run verify:fixture`
- `npm run test:unit`

## Remaining Wave 2 work

Still pending after this patch:

1. Broaden scene-type coverage for `dialogue_confrontation`, `emotional_confession`, and `comedic_setpiece` fixtures.
2. Regenerate or refresh live Steve Jobs/Sculley fixture evidence once external OAuth/DNS access is available.
3. Add before/after fixture proof showing selector outcome changes on real compression artifacts, not only synthetic unit cases.

Known blocker for live regeneration remains external network/auth:

```text
request to https://oauth2.googleapis.com/token failed, reason: getaddrinfo ENOTFOUND oauth2.googleapis.com
```
