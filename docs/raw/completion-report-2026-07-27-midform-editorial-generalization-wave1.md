# Midform Editorial Generalization Wave 1 완료 보고서

Date: 2026-07-27  
Scope: `.sisyphus/plans/midform-editorial-generalization.md` 기반 첫 구현 wave

## 요약

미드폼 리캡 파이프라인을 Steve Jobs/Sculley 장면 전용 패치가 아니라 일반화 가능한 구조로 확장하기 위한 첫 구현 wave를 완료했습니다.

이번 작업은 다음 영역을 중심으로 진행했습니다.

- generalized editorial metadata schema
- teaser suitability scoring
- micro-exchange 후보/metadata 생성
- QC action 구조화 및 vocabulary 정규화
- context reset / callback linkage metadata
- bootstrap metadata propagation
- compact editorial review artifact
- final CapCut `draft_content.json` material color validation
- speaker alias contract tests
- non-confrontation scene policy regression

## 변경 파일

주요 변경 범위는 아래 파일들입니다.

- `midform/schemas/midform_compression_edit_plan_schema.json`
- `server/services/midformCompressionService.js`
- `server/services/midformBootstrapAdapterService.js`
- `tests/artifactQaHelpers.js`
- `tests/dialogueSelectionTiming.test.js`
- `tests/dialogueCoherenceQc.test.js`
- `tests/speakerCaptionColors.test.js`
- `tests/editorialSchema.test.js`
- `tests/microExchangeCandidates.test.js`
- `tests/materialCaptionColors.test.js`
- `tests/editorialReviewArtifact.test.js`
- `tests/bootstrapEditorialMetadata.test.js`
- `tests/teaserSuitability.test.js`

## 구현 내용

### 1. Editorial schema 일반화

`midform_compression_edit_plan_schema.json`에 다음 metadata를 명시적으로 허용했습니다.

- `scene_type`
- `editorial_role`
- `dialogue_unit`
- `teaser_slot_id`
- `callback_slot_id`
- `callback_relation`
- `reused_conflict_axis`
- `qc_action`
- `context_reset.explanation_sufficiency`
- `context_reset.spoiler_leakage`
- `context_reset.callback_readiness`

동시에 `additionalProperties: false`를 유지해 arbitrary/debug field는 계속 차단합니다.

### 2. Micro-exchange 기반 추가

`server/services/midformCompressionService.js`에 deterministic helper를 추가했습니다.

- `buildMicroExchangeCandidates()`
  - adjacent dialogue turns에서 다음 관계를 식별합니다.
    - `accusation_rebuttal`
    - `question_answer`
    - `claim_reversal`
    - `threat_pushback`
- `buildDialogueUnitMetadata()`
  - 실제 finalize/annotation 경로에서 `dialogue_unit` metadata를 생성합니다.
  - 최종적으로 `slot_01_L01`, `slot_01_L02` 같은 실제 source line id를 사용하도록 수정했습니다.

중요한 점은 render output은 계속 line-level segment로 유지하면서, editorial 선택 단위만 exchange metadata로 보존한다는 것입니다.

### 3. Teaser suitability scoring 일반화

`buildTeaserSuitabilityScore()`를 추가하고 cold-open callback scoring에 연결했습니다.

새 scoring field:

- `teaser_hook_strength`
- `callback_payoff_strength`
- `curiosity_gap`
- `context_dependency`
- `context_clarity`
- `standalone_comprehension`
- `pronoun_dependency_risk`
- `accusation_response_balance`
- `quote_value`
- `required_support_action`
- `total`

이제 high-hook line이라도 context-heavy single-line rebuttal이면 raw pass가 아니라 support action이 필요하다는 metadata가 남습니다.

### 4. QC action 구조화

`buildSlotQcReport()`와 dialogue annotation path에 `qc_action`을 추가했습니다.

Action vocabulary는 schema/controller 기준으로 정규화했습니다.

- `none`
- `extend_line_window`
- `merge_adjacent_lines`
- `bridge_required`
- `downgrade_to_narrate`

기존 legacy 값인 `merge_exchange`, `merged_previous_line`, `bridge_narration` 등은 report/action 단계에서 정규화됩니다.

### 5. Callback/context metadata 보강

`buildColdOpenCallbackMetadata()`가 다음 정보를 top-level metadata로 내보내도록 했습니다.

- `scene_type`
- hook teaser의 `teaser_slot_id`, `callback_slot_id`, `callback_relation`
- callback dialogue의 `callback_slot_id`, `callback_relation`, `reused_conflict_axis`
- context reset의 `explanation_sufficiency`, `spoiler_leakage`, `callback_readiness`

이제 callback 구조를 사람이 raw timeline 전체를 뒤지지 않고도 확인할 수 있습니다.

### 6. Bootstrap metadata propagation

`server/services/midformBootstrapAdapterService.js`에서 line-level dialogue segment를 유지하면서 다음 metadata를 `slotMap.slots`와 `script.segments`에 전달합니다.

- `editorial_role`
- `scene_type`
- `teaser_slot_id`
- `callback_slot_id`
- `callback_relation`
- `reused_conflict_axis`
- `dialogue_unit`

또한 기존 `bootstrap_review_draft.md`는 유지하고, 별도 구조화 artifact인 `bootstrap_editorial_review.json`을 추가로 생성하도록 했습니다.

### 7. Final render material color validation

`tests/artifactQaHelpers.js`에 `draft_content.json` material-level validator를 추가했습니다.

검증 기준:

- `edit_manifest.caption_color`
- `draft_content.json.materials.texts[*].content.styles[*].fill.content.solid.color`
- `useLetterColor === true`
- `use_effect_default_color === false`
- material `text_color`와 manifest hex color 일치

즉, manifest metadata만으로 pass하지 않고 실제 CapCut text material fill state까지 검증합니다.

### 8. Speaker alias contract tests

Jobs/Scully alias contract를 테스트로 고정했습니다.

Jobs aliases:

- `Jobs`
- `Steve`
- `Steve Jobs`
- `잡스`
- `스티브 잡스`

Scully/Sculley aliases:

- `Sculley`
- `Scully`
- `John Sculley`
- `John Scully`
- `스컬리`
- `존 스컬리`

Unknown speaker는 blank color를 유지하고 known speaker colors를 훼손하지 않는 것으로 고정했습니다.

## Review 결과와 수정

구현 후 review-work 절차를 실행했습니다.

초기 Goal/Constraint Oracle review는 **FAIL**을 냈습니다.

### Blocking issue

`dialogue_unit` metadata가 fixture/test에서는 보존되지만, 실제 live finalize path에서 생성되는 것이 충분히 보장되지 않았습니다.

### 수정 내용

아래를 즉시 수정했습니다.

1. `annotateDialogueSlotForQc()`에서 실제 `dialogue_line_windows` 기반으로 `dialogue_unit`을 생성하도록 수정.
2. `source_line_ids`가 placeholder `L01/L02`가 아니라 실제 `slot_01_L01`, `slot_01_L02` 형태가 되도록 수정.
3. `qc_action.action` vocabulary를 schema/controller 값으로 정규화.
4. regression test 추가:
   - `finalizeEditPlan generates dialogue_unit metadata before bootstrap when source plan lacks it`

수정 후 모든 검증을 다시 통과했습니다.

## 검증 결과

### LSP diagnostics

- `server/services/midformCompressionService.js`: error 0
- `server/services/midformBootstrapAdapterService.js`: error 0
- `tests/`: error 0

### Unit tests

Command:

```bash
node --test tests/*.test.js
```

Result:

```text
tests 27
pass 27
fail 0
```

### Full project verification

Command:

```bash
npm run verify
```

Result: pass

Included steps:

- `npm run check:encoding` — pass
- `npm run verify:js` — pass
- `npm run verify:py` — pass
- `npm run verify:fixture` — command exit 0
- `npm run test:unit` — 27 pass

Note: `verify:fixture` still prints an existing caption balance JSON with `status: "failed"` for overlong caption reporting, but the command exits 0 and this is existing project behavior noted in prior plan context.

## 현재 상태

Wave 1 + early Wave 2 foundation work is complete.

Completed:

- schema generalization
- micro-exchange generation foundation
- teaser suitability score foundation
- QC action structure
- context/callback metadata
- bootstrap metadata propagation
- editorial review artifact helper/output
- material-level color validator
- alias contract tests
- non-confrontation policy regression
- review blocker fix
- full verification

Remaining for later waves:

- deeper selector integration beyond helper-level scoring
- broader non-confrontation fixture coverage
- final Steve Jobs/Sculley e2e regeneration/QA if external/network conditions allow
- final F1-F4 review wave after all planned implementation tasks are complete
