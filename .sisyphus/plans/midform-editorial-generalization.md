# Midform Editorial Generalization Plan

## TL;DR

> **Quick Summary**: Generalize the midform recap pipeline beyond one Steve Jobs fixture by improving teaser selection quality, micro-exchange preservation, QC-as-controller behavior, scene-type opening policy, callback metadata, human review artifacts, and final-render speaker color validation.
>
> **Deliverables**:
> - Generalized editorial scoring and scene-type opening policy.
> - Micro-exchange candidate representation and preservation rules.
> - QC gates that trigger merge/bridge/downgrade corrections, not just reports.
> - Context reset and callback linkage schema/metadata.
> - Final `draft_content.json` text-material color validator.
> - Regression tests for Steve Jobs/Sculley plus additional scene-type fixtures.
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 4 implementation waves + final verification
> **Critical Path**: T1/T2 schema+fixtures → T3/T4 selector/QC → T7 bootstrap metadata → T8 render validator → T11 end-to-end QA → final verification

---

## Context

### Original Request

User asked to plan applicable code improvements from the current audit, not to implement yet. The work must generalize across the midform recap pipeline and must not patch only the Steve Jobs scene.

### Source of Truth

- `docs/raw/current-state-audit-2026-07-27-midform-pipeline.md` - current state audit.
- `midform/test_runs/compress_20260727142327_luMBOVwyNzo/` - Steve Jobs/Sculley compression fixture.
- `midform/test_runs/run_20260727_200332_Steve_vs._Scully_Full_Scene_Steve_Jobs/` - latest bootstrap/render run.
- `server/output/drafts/pipeline_1785150227/edit_manifest.json` - latest rendered manifest.

### Current Key Findings

- `cold_open_callback` already exists in current code/artifacts.
- Current bottlenecks are quality/invariance issues:
  - hook selection can choose rebuttal-heavy/context-dependent lines;
  - planning is beat/slot-based but bootstrap/render is line-level;
  - QC fields exist but are not consistently controlling selection;
  - manifest color correctness does not prove final rendered text material correctness.

### Plan Review Note

- Metis delegation was attempted but blocked by plan-family delegation restrictions. This plan uses direct audit/code evidence and explicit self-review guardrails instead.

---

## Work Objectives

### Core Objective

Make `cold_open_callback` and dialogue-driven scene handling reliable at the system level: choose understandable high-hook teasers, preserve exchange-level confrontation logic, convert QC metadata into correction/gating behavior, and verify speaker color in final CapCut material state.

### Concrete Deliverables

- Updated editorial schemas for scene type, editorial role, dialogue unit, QC actions, and callback linkage.
- Selector scoring that includes context clarity and accusation/response balance.
- Micro-exchange candidate generation and preservation.
- QC controller that applies line extension, adjacent-line merge, bridge narration requirement, or downgrade.
- Human-readable editorial review artifact.
- CapCut draft material color validation against manifest colors.
- Regression tests and fixtures covering confrontation, confession, and comedy/setpiece scene types.

### Definition of Done

- [ ] `node --test tests/*.test.js` passes.
- [ ] `npm run verify` passes.
- [ ] Steve Jobs/Sculley confrontation fixture passes teaser/callback/max narration/material-color checks.
- [ ] At least one non-confrontation fixture proves narration-only/flexible opening remains allowed.
- [ ] High-risk teaser candidates cannot pass as raw single-line `KEEP_DIALOGUE` without correction.
- [ ] Final render validation reads `draft_content.json` material fill state, not only `edit_manifest.caption_color`.

### Must Have

- Generalize across midform pipeline; no one-scene hardcoding.
- Preserve existing midform-only guardrails; do not reintroduce Ottugi/shortform/Virlo/YouTube upload paths.
- Keep final SRT free of debug tags.
- Preserve Korean/Japanese encoding rules.
- Use artifact-executable verification only.

### Must NOT Have

- No manual CapCut template editing as a “fix”.
- No visual-only speaker color validation.
- No Steve Jobs-specific string hacks.
- No requiring browser UI/client build in `npm run verify`.

---

## Verification Strategy

### Test Decision

- **Infrastructure exists**: YES
- **Automated tests**: TDD / tests-before-implementation for each subsystem
- **Framework**: Node built-in `node --test tests/*.test.js` plus existing `npm run verify`

### QA Policy

Every implementation task includes agent-executable QA. Evidence should be saved under `.sisyphus/evidence/` when executed.

---

## Execution Strategy

### Parallel Execution Waves

```text
Wave 1 — schemas, fixtures, test scaffolding (parallel)
├── T1: Editorial schema + fixture taxonomy
├── T2: Micro-exchange fixture/test scaffolding
├── T3: Render material color validator test scaffolding
├── T4: Review artifact schema/test scaffolding
└── T5: Speaker alias normalization contract tests

Wave 2 — selector and QC controller (after Wave 1)
├── T6: Teaser suitability scoring generalization
├── T7: Micro-exchange candidate generation and selection
├── T8: QC controller actions: extend/merge/bridge/downgrade
├── T9: Scene-type-aware opening policy
└── T10: Context reset and callback linkage quality checks

Wave 3 — bootstrap/render integration (after Wave 2)
├── T11: Propagate editorial role/linkage metadata to slot_map/script/manifest
├── T12: Human editorial review artifact
├── T13: Final draft_content material color validation
└── T14: Central speaker alias normalization integration

Wave 4 — end-to-end fixtures and cleanup (after Wave 3)
├── T15: Steve Jobs/Sculley e2e rerender + artifact QA
├── T16: Non-confrontation fixture coverage
├── T17: Documentation/comments cleanup and verify wiring
└── T18: Backward compatibility and failure-mode audit

Wave FINAL — parallel reviews
├── F1: Plan compliance audit
├── F2: Code quality review
├── F3: Artifact QA replay
└── F4: Scope fidelity check
```

### Dependency Matrix

- **T1-T5**: no blockers; block T6-T14.
- **T6**: blocked by T1/T2; blocks T9/T15.
- **T7**: blocked by T2; blocks T8/T11/T15.
- **T8**: blocked by T6/T7; blocks T10/T15.
- **T9**: blocked by T6; blocks T15/T16.
- **T10**: blocked by T8; blocks T11/T12/T15.
- **T11**: blocked by T7/T10; blocks T12/T15.
- **T12**: blocked by T11; blocks final review.
- **T13**: blocked by T3; blocks T15/T17.
- **T14**: blocked by T5; blocks T13/T15.
- **T15-T18**: final integration wave; block F1-F4.

### Agent Dispatch Summary

- Wave 1: T1-T5 → `quick` / `unspecified-high` for schema+fixtures.
- Wave 2: T6-T10 → `deep` for selector/QC logic.
- Wave 3: T11-T14 → `unspecified-high`; T13 may need Python/CapCut artifact expertise.
- Wave 4: T15-T18 → `unspecified-high` / `quick`.
- Final: F1 `oracle`, F2/F3 `unspecified-high`, F4 `deep`.

### Planner Self-Review and Gap Classification

- **Critical gaps requiring user input**: None. The user explicitly requested planning only, gave the audit as source of truth, and named the generalization areas.
- **Minor gaps auto-resolved**:
  - Metis review could not run because plan-family delegation is blocked in this environment; fallback is explicit self-review against the audit and current generated plan.
  - External API/network execution is excluded from verification because the project requires `npm run verify` to remain API-free and current OAuth DNS is unavailable.
  - CapCut color correctness is defined as artifact-level `draft_content.json` material validation, not visual/manual inspection.
- **Defaults applied**:
  - Automated tests use existing Node test infrastructure and project `npm run verify` rather than adding a new test framework.
  - Non-confrontation regression fixtures may be synthetic or existing local fixtures, as long as they are API-free and deterministic.
  - Review artifact remains separate from final SRT; final viewer subtitles must stay debug-tag free.

---

## TODOs

- [ ] 1. Define editorial schema and scene-type taxonomy

  **What to do**:
  - Extend relevant schemas/artifact contracts to explicitly represent scene type and editorial roles.
  - Add fields for `scene_type`, `editorial_role`, `dialogue_unit`, `teaser_slot_id`, `callback_slot_id`, `callback_relation`, `reused_conflict_axis`, and QC action outputs.
  - Keep schema backward-compatible where possible; existing artifacts without new keys should degrade safely.

  **Must NOT do**:
  - Do not hardcode Steve Jobs beat IDs or speaker names.
  - Do not require non-confrontation scenes to use `cold_open_callback`.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: focused schema/contract update.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T6-T14
  - **Blocked By**: None

  **References**:
  - `midform/schemas/midform_compression_edit_plan_schema.json` - current `editorial_pattern`, `hook_teaser`, `context_reset`, `callback_dialogue` schema.
  - `server/services/midformCompressionService.js:1794` - `buildColdOpenCallbackMetadata()`.
  - `docs/raw/current-state-audit-2026-07-27-midform-pipeline.md` - audit source of truth.

  **Acceptance Criteria**:
  - [ ] Schema accepts generalized editorial metadata without allowing arbitrary unrelated keys.
  - [ ] Tests cover old artifacts without metadata and new artifacts with metadata.

  **QA Scenarios**:
  ```text
  Scenario: New metadata validates
    Tool: Bash
    Steps:
      1. Run `node --test tests/*.test.js`.
      2. Assert schema/contract tests pass for `cold_open_callback` metadata.
    Expected Result: New metadata is accepted and missing optional legacy metadata does not crash.
    Evidence: .sisyphus/evidence/task-1-schema-tests.txt

  Scenario: Non-confrontation remains flexible
    Tool: Bash
    Steps:
      1. Run targeted scene taxonomy test.
      2. Assert non-confrontation fixture is not forced into `cold_open_callback`.
    Expected Result: Scene-type policy is explicit and scoped.
    Evidence: .sisyphus/evidence/task-1-scene-taxonomy.txt
  ```

- [ ] 2. Add micro-exchange fixture/test scaffolding

  **What to do**:
  - Add tests representing `accusation -> rebuttal`, `question -> answer`, `claim -> reversal`, and `threat -> pushback` units.
  - Use synthetic transcript/beat fixtures plus Steve Jobs fixture references.
  - Verify micro-exchange candidate shape before selector implementation.

  **Must NOT do**:
  - Do not test only exact Korean copy.
  - Do not collapse all exchanges into full-beat preservation.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T7, T8, T15
  - **Blocked By**: None

  **References**:
  - `tests/dialogueSelectionTiming.test.js` - current timing/QC test style.
  - `tests/artifactQaHelpers.js` - artifact parsing helpers.
  - `midform/test_runs/compress_20260727142327_luMBOVwyNzo/narrative_beats.json` - real confrontation beat examples.

  **Acceptance Criteria**:
  - [ ] Tests fail before exchange selector exists.
  - [ ] Tests distinguish single-line hook from micro-exchange hook.

  **QA Scenarios**:
  ```text
  Scenario: Accusation rebuttal candidate is recognized
    Tool: Bash
    Steps:
      1. Run `node --test tests/dialogueSelectionTiming.test.js`.
      2. Assert a synthetic accusation/rebuttal transcript produces one exchange candidate.
    Expected Result: Candidate includes both source lines and relation type.
    Evidence: .sisyphus/evidence/task-2-exchange-candidate.txt

  Scenario: Full beat is not selected when exchange is enough
    Tool: Bash
    Steps:
      1. Run targeted selector fixture test.
      2. Assert selected duration stays within configured micro-exchange max.
    Expected Result: Exchange-level preservation avoids full-beat bloat.
    Evidence: .sisyphus/evidence/task-2-no-full-beat.txt
  ```

- [ ] 3. Add final render material color validator tests

  **What to do**:
  - Add tests/helpers that open generated `draft_content.json`, locate subtitle text materials, parse material `content`, and compare nested fill RGB values against `edit_manifest.caption_color`.
  - Verify `useLetterColor`, `use_effect_default_color`, and effect-ref removal where applicable.

  **Must NOT do**:
  - Do not treat `edit_manifest.caption_color` alone as pass.
  - Do not require visual/manual CapCut inspection.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T13, T15, T17
  - **Blocked By**: None

  **References**:
  - `scripts/capcut_draft.py:159` - `caption_color_for_speaker()`.
  - `scripts/capcut_draft.py:191` - `apply_text_material_fill_color()`.
  - `scripts/capcut_draft.py:2648` - `rebuild_midform_caption_track_from_template()`.
  - `server/output/drafts/pipeline_1785150227/edit_manifest.json` - latest manifest evidence.

  **Acceptance Criteria**:
  - [ ] Test can fail when manifest color exists but material fill is missing/wrong.
  - [ ] Test passes on a valid generated draft where text material fill matches manifest color.

  **QA Scenarios**:
  ```text
  Scenario: Manifest color mismatch is caught
    Tool: Bash
    Steps:
      1. Run a fixture test with deliberately mismatched material fill data.
      2. Assert validator reports exact caption/material ID mismatch.
    Expected Result: Mismatch fails with actionable material reference.
    Evidence: .sisyphus/evidence/task-3-color-mismatch.txt

  Scenario: Latest draft material colors validate
    Tool: Bash
    Steps:
      1. Run validator against `server/output/drafts/pipeline_1785150227`.
      2. Compare nested RGB fill to manifest hex colors for Jobs/Scully captions.
    Expected Result: All colored dialogue captions either pass or produce exact failures.
    Evidence: .sisyphus/evidence/task-3-latest-draft-color.txt
  ```

- [ ] 4. Add human editorial review artifact contract tests

  **What to do**:
  - Define a compact review artifact listing slot, editorial role, scene type, source beat, speaker, risk scores, source lines, and teaser/callback linkage.
  - Add tests validating the artifact includes linkage and risk information.

  **Must NOT do**:
  - Do not put review-only tags into final SRT.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T12
  - **Blocked By**: None

  **References**:
  - `server/services/midformBootstrapAdapterService.js:67` - `buildReviewDraftMarkdown()`.
  - `midform/test_runs/compress_20260727142327_luMBOVwyNzo/bootstrap_review_draft.md` - current review draft.

  **Acceptance Criteria**:
  - [ ] Review artifact can show teaser/callback relation without reading raw JSON.
  - [ ] Final SRT remains debug-tag free.

  **QA Scenarios**:
  ```text
  Scenario: Review artifact shows editorial linkage
    Tool: Bash
    Steps:
      1. Generate/inspect review artifact test fixture.
      2. Assert teaser slot, callback slot, relation, risk scores, and source lines are present.
    Expected Result: Human can audit callback structure from one artifact.
    Evidence: .sisyphus/evidence/task-4-review-linkage.txt

  Scenario: Viewer SRT remains clean
    Tool: Bash
    Steps:
      1. Grep generated SRT for `KEEP_DIALOGUE|NARRATE|slot_\d+|faithful_dialogue`.
    Expected Result: No matches.
    Evidence: .sisyphus/evidence/task-4-srt-clean.txt
  ```

- [ ] 5. Add speaker alias normalization contract tests

  **What to do**:
  - Define central alias expectations for `Jobs/Steve/Steve Jobs/잡스` and `Scully/Sculley/John Sculley/스컬리`.
  - Add tests ensuring alias normalization happens before color lookup.

  **Must NOT do**:
  - Do not scatter alias fixes in one-off fixture data only.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T14, T13
  - **Blocked By**: None

  **References**:
  - `midform/config/caption_colors.json` - current role/speaker map.
  - `scripts/capcut_draft.py:159` - current color lookup.
  - `tests/speakerCaptionColors.test.js` - current speaker color tests.

  **Acceptance Criteria**:
  - [ ] Alias variants resolve to the same role/color.
  - [ ] Unknown speaker behavior is explicit and stable.

  **QA Scenarios**:
  ```text
  Scenario: Alias variants normalize
    Tool: Bash
    Steps:
      1. Run speaker alias tests.
      2. Assert Scully/Sculley variants map to `#37FF3D`; Jobs variants map to `#00A9F7`.
    Expected Result: All configured aliases resolve consistently.
    Evidence: .sisyphus/evidence/task-5-aliases.txt

  Scenario: Unknown speaker does not corrupt known colors
    Tool: Bash
    Steps:
      1. Run mixed known/unknown speaker fixture.
      2. Assert known speakers remain colored and unknown speaker handling is documented.
    Expected Result: Known color path unaffected.
    Evidence: .sisyphus/evidence/task-5-unknown-speaker.txt
  ```

- [ ] 6. Generalize teaser suitability scoring

  **What to do**:
  - Extend selection scoring beyond hook strength to include `context_clarity`, `standalone_comprehension`, `pronoun_dependency_risk`, `accusation_response_balance`, `curiosity_gap`, and `callback_payoff_strength`.
  - Penalize high-context single-line rebuttals unless paired with micro-exchange or required bridge narration.

  **Must NOT do**:
  - Do not choose the latest/strongest payoff solely because it has high drama.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with T7/T9 after tests exist.
  - **Parallel Group**: Wave 2
  - **Blocks**: T8, T9, T15
  - **Blocked By**: T1, T2

  **References**:
  - `server/services/midformCompressionService.js:1832` - `bestColdOpenCallbackBeat()`.
  - `server/services/midformCompressionService.js:1840` - `prepareColdOpenCallbackTimeline()`.
  - `docs/raw/current-state-audit-2026-07-27-midform-pipeline.md:381` - failure modes.

  **Acceptance Criteria**:
  - [ ] Tests show context-heavy single-line teaser is corrected or rejected.
  - [ ] Strong but understandable hook still wins over chronology when appropriate.

  **QA Scenarios**:
  ```text
  Scenario: Rebuttal-heavy teaser requires support
    Tool: Bash
    Steps:
      1. Run selector test with a rebuttal-only high-hook line.
      2. Assert selected action is micro-exchange, bridge-required, or downgrade; not raw single-line pass.
    Expected Result: Context-heavy teaser cannot pass unsupported.
    Evidence: .sisyphus/evidence/task-6-rebuttal-support.txt

  Scenario: Clean accusation hook wins
    Tool: Bash
    Steps:
      1. Run selector test with clean accusation and late payoff candidates.
      2. Assert clean hook wins or becomes teaser while payoff becomes callback/body.
    Expected Result: Scoring balances hook and comprehension.
    Evidence: .sisyphus/evidence/task-6-clean-hook.txt
  ```

- [ ] 7. Implement micro-exchange candidate generation and selection

  **What to do**:
  - Build candidate grouping for adjacent source lines/turns: accusation→rebuttal, question→answer, claim→reversal, threat→pushback.
  - Feed these candidates into teaser and callback selection.
  - Preserve line-level render output while retaining exchange-level metadata.

  **Must NOT do**:
  - Do not merge Korean captions in a way that breaks `caption_kr_dialogue` count matching.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with T6 after Wave 1.
  - **Parallel Group**: Wave 2
  - **Blocks**: T8, T11, T15
  - **Blocked By**: T2

  **References**:
  - `server/services/midformCompressionService.js:1951-1977` - current focus/window enrichment.
  - `server/services/midformBootstrapAdapterService.js:220-287` - line-level bootstrap output.

  **Acceptance Criteria**:
  - [ ] Exchange metadata survives while render remains line-level.
  - [ ] Exchange duration constraints prevent full-beat bloat.

  **QA Scenarios**:
  ```text
  Scenario: Exchange metadata survives bootstrap
    Tool: Bash
    Steps:
      1. Run bootstrap fixture generation.
      2. Inspect script/slot_map for parent exchange metadata and per-line segments.
    Expected Result: Exchange intent visible, line timing preserved.
    Evidence: .sisyphus/evidence/task-7-exchange-bootstrap.txt

  Scenario: Count matching stays valid
    Tool: Bash
    Steps:
      1. Run `node --test tests/*.test.js`.
      2. Assert `caption_kr_dialogue.length` matches selected line count.
    Expected Result: No sync-breaking merge.
    Evidence: .sisyphus/evidence/task-7-count-match.txt
  ```

- [ ] 8. Promote QC fields into correction/gating controller

  **What to do**:
  - Convert `semantic_risk`, `pronoun_risk`, `standalone_score`, `boundary_score`, and `coherence_checks` into action decisions.
  - Action sequence: line window extension → adjacent-line merge → bridge narration requirement → downgrade to `NARRATE`.
  - Record action taken in edit plan and slot QC report.

  **Must NOT do**:
  - Do not silently pass high-risk single-line `KEEP_DIALOGUE` without action metadata.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with T9/T10 after T6/T7 starts.
  - **Parallel Group**: Wave 2
  - **Blocks**: T10, T15
  - **Blocked By**: T6, T7

  **References**:
  - `server/services/midformCompressionService.js:216` - `buildSlotQcReport()`.
  - `server/services/midformCompressionService.js:1230` - readable dialogue window resolution area.
  - `docs/raw/current-state-audit-2026-07-27-midform-pipeline.md:387-389` - risk fields currently descriptive.

  **Acceptance Criteria**:
  - [ ] High pronoun-risk teaser triggers correction or downgrade.
  - [ ] QC report includes the selected correction action.

  **QA Scenarios**:
  ```text
  Scenario: Pronoun risk triggers merge
    Tool: Bash
    Steps:
      1. Run QC controller fixture with pronoun-dependent line.
      2. Assert adjacent context line is merged or bridge-required is set.
    Expected Result: Risk causes action, not only logging.
    Evidence: .sisyphus/evidence/task-8-pronoun-merge.txt

  Scenario: Unfixable line downgrades
    Tool: Bash
    Steps:
      1. Run fixture where line remains unclear after merge/bridge candidates.
      2. Assert slot becomes `NARRATE` or candidate is rejected.
    Expected Result: Unsafe dialogue does not survive as raw KEEP_DIALOGUE.
    Evidence: .sisyphus/evidence/task-8-downgrade.txt
  ```

- [ ] 9. Enforce scene-type-aware opening policy

  **What to do**:
  - Make `dialogue_confrontation` scenes prefer `cold_open_callback` by default.
  - Allow narration-only opening only when teaser suitability fails after correction attempts.
  - Keep non-confrontation flexibility.

  **Must NOT do**:
  - Do not force confession/comedy/visual setpiece scenes into confrontation rules.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with T8/T10.
  - **Parallel Group**: Wave 2
  - **Blocks**: T15, T16
  - **Blocked By**: T1, T6

  **References**:
  - `server/services/midformCompressionService.js:932` - `isDialogueDrivenConfrontation()`.
  - `server/services/midformCompressionService.js:724` - `defaultDecisionForBeat()`.

  **Acceptance Criteria**:
  - [ ] Confrontation fixture defaults to `cold_open_callback` when a valid teaser exists.
  - [ ] Non-confrontation fixture can keep narration-only opening.

  **QA Scenarios**:
  ```text
  Scenario: Confrontation defaults to callback pattern
    Tool: Bash
    Steps:
      1. Run confrontation fixture through selector/finalizer test.
      2. Assert `editorial_pattern` is `cold_open_callback` unless no valid teaser exists.
    Expected Result: Policy is explicit and tested.
    Evidence: .sisyphus/evidence/task-9-confrontation-policy.txt

  Scenario: Comedy setpiece remains flexible
    Tool: Bash
    Steps:
      1. Run non-confrontation fixture.
      2. Assert narration-only or chronological opening can pass.
    Expected Result: No confrontation overfit.
    Evidence: .sisyphus/evidence/task-9-non-confrontation.txt
  ```

- [ ] 10. Add context reset and callback linkage quality checks

  **What to do**:
  - Add QC fields for `explanation_sufficiency`, `spoiler_leakage`, and `callback_readiness`.
  - Ensure callback is on same conflict axis and not accidental repetition.

  **Must NOT do**:
  - Do not require LLM semantic judgment without deterministic fallback checks.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with T8/T9.
  - **Parallel Group**: Wave 2
  - **Blocks**: T11, T12, T15
  - **Blocked By**: T8

  **References**:
  - `server/services/midformCompressionService.js:1794` - `buildColdOpenCallbackMetadata()`.
  - `server/services/midformCompressionService.js:2325` - `buildSlotFillsPrompt()`.

  **Acceptance Criteria**:
  - [ ] Context reset cannot fully paraphrase/spoil teaser without warning/failure.
  - [ ] Callback relation is machine-readable.

  **QA Scenarios**:
  ```text
  Scenario: Spoiler leakage flagged
    Tool: Bash
    Steps:
      1. Run context reset QC fixture where narration repeats teaser answer.
      2. Assert `spoiler_leakage` warning/failure is emitted.
    Expected Result: Reset does not consume teaser tension silently.
    Evidence: .sisyphus/evidence/task-10-spoiler-leakage.txt

  Scenario: Callback relation is explicit
    Tool: Bash
    Steps:
      1. Inspect generated edit plan/script metadata.
      2. Assert callback relation and reused conflict axis are present.
    Expected Result: Callback is auditable.
    Evidence: .sisyphus/evidence/task-10-callback-relation.txt
  ```

- [ ] 11. Propagate editorial role/linkage metadata through bootstrap and manifests

  **What to do**:
  - Carry `editorial_role`, `source_beat_id`, `teaser_slot_id`, `callback_slot_id`, `callback_relation`, and `reused_conflict_axis` from edit plan to slot map/script/edit manifest where feasible.
  - Preserve current line-level segment IDs.

  **Must NOT do**:
  - Do not break `slot_map_mode false` bootstrap behavior.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with T12/T14 after dependencies.
  - **Parallel Group**: Wave 3
  - **Blocks**: T12, T15
  - **Blocked By**: T7, T10

  **References**:
  - `server/services/midformBootstrapAdapterService.js:172` - `buildBootstrapSlotMapAndScript()`.
  - `scripts/capcut_draft.py:9748` - manifest entry construction.

  **Acceptance Criteria**:
  - [ ] Manifest/review artifacts expose teaser/callback lineage.
  - [ ] Existing preflight gates still pass.

  **QA Scenarios**:
  ```text
  Scenario: Metadata survives to manifest
    Tool: Bash
    Steps:
      1. Generate bootstrap fixture artifacts.
      2. Inspect script/edit_manifest entries for editorial role and linkage fields.
    Expected Result: Linkage visible after render conversion.
    Evidence: .sisyphus/evidence/task-11-manifest-linkage.txt

  Scenario: slot_map_mode remains false
    Tool: Bash
    Steps:
      1. Run bootstrap preflight.
      2. Assert `capcut_slot_map_mode_false` passes.
    Expected Result: Metadata propagation does not re-enable incompatible gate.
    Evidence: .sisyphus/evidence/task-11-slot-map-mode.txt
  ```

- [ ] 12. Generate compact human editorial review artifact

  **What to do**:
  - Add a concise review artifact separate from final SRT showing editorial roles, scene type, beat IDs, speakers, risk scores, source lines, and callback linkage.
  - Include artifact path in bootstrap/pipeline state if appropriate.

  **Must NOT do**:
  - Do not replace current `bootstrap_review_draft.md` unless compatibility is preserved.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with T13/T14.
  - **Parallel Group**: Wave 3
  - **Blocks**: T15
  - **Blocked By**: T4, T11

  **References**:
  - `server/services/midformBootstrapAdapterService.js:67` - current markdown review draft builder.

  **Acceptance Criteria**:
  - [ ] One artifact lets a reviewer see “why this teaser/callback was chosen”.
  - [ ] Artifact uses source line IDs and risk scores.

  **QA Scenarios**:
  ```text
  Scenario: Review artifact summary is complete
    Tool: Bash
    Steps:
      1. Generate/inspect review artifact.
      2. Assert each active slot has role, beat, risk, source lines, and linkage fields.
    Expected Result: Artifact supports editorial QA without raw JSON spelunking.
    Evidence: .sisyphus/evidence/task-12-review-artifact.txt

  Scenario: Review artifact does not leak into SRT
    Tool: Bash
    Steps:
      1. Grep final SRT for review-only fields.
    Expected Result: No review metadata in viewer subtitles.
    Evidence: .sisyphus/evidence/task-12-srt-isolation.txt
  ```

- [ ] 13. Validate final CapCut text material color state

  **What to do**:
  - Implement artifact validator that compares `edit_manifest.caption_color` with `draft_content.json` cloned text material fill RGB.
  - Validate `useLetterColor`, `use_effect_default_color`, and absence/removal of overriding effect refs for colored captions.
  - Wire validator into tests and, if stable, `npm run verify` or a fixture verify step.

  **Must NOT do**:
  - Do not rely on screenshot/manual inspection.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with T12/T14.
  - **Parallel Group**: Wave 3
  - **Blocks**: T15, T17
  - **Blocked By**: T3, T14

  **References**:
  - `scripts/capcut_draft.py:191` - actual material color mutation.
  - `scripts/capcut_draft.py:2648` - template rebuild path.
  - `server/output/drafts/pipeline_1785150227/draft_content.json` - generated draft material state.

  **Acceptance Criteria**:
  - [ ] Validator fails if material fill color differs from manifest hex.
  - [ ] Validator reports exact caption/material identifiers.

  **QA Scenarios**:
  ```text
  Scenario: Material fill equals manifest color
    Tool: Bash
    Steps:
      1. Run material color validator on latest fixture draft.
      2. Assert Jobs/Scully captions match expected fill RGB.
    Expected Result: Material-level validation passes.
    Evidence: .sisyphus/evidence/task-13-material-color-pass.txt

  Scenario: Overriding effect refs fail validation
    Tool: Bash
    Steps:
      1. Run validator on fixture with retained text effect refs.
      2. Assert colored captions fail with effect override warning.
    Expected Result: Renderer integrity issue is caught.
    Evidence: .sisyphus/evidence/task-13-effect-ref-fail.txt
  ```

- [ ] 14. Centralize speaker alias normalization

  **What to do**:
  - Add a single alias normalization path used before color lookup and manifest recording.
  - Ensure JS/bootstrap speaker metadata and Python render lookup stay consistent.

  **Must NOT do**:
  - Do not duplicate alias maps independently in JS and Python without a shared config or generated source.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with T12/T13 after T5.
  - **Parallel Group**: Wave 3
  - **Blocks**: T13, T15
  - **Blocked By**: T5

  **References**:
  - `midform/config/caption_colors.json` - current config.
  - `scripts/capcut_draft.py:159` - Python lookup.
  - `server/services/midformBootstrapAdapterService.js:237` - JS speaker assignment.

  **Acceptance Criteria**:
  - [ ] Alias normalization used consistently before render.
  - [ ] Known aliases resolve identically in tests.

  **QA Scenarios**:
  ```text
  Scenario: Shared alias config used by render path
    Tool: Bash
    Steps:
      1. Run speaker alias tests.
      2. Inspect generated manifest for canonical or consistently mapped speaker names.
    Expected Result: Alias variants no longer cause blank colors.
    Evidence: .sisyphus/evidence/task-14-shared-alias.txt

  Scenario: Korean aliases work
    Tool: Bash
    Steps:
      1. Run fixture with Korean speaker names `잡스`, `스컬리`.
      2. Assert color mapping matches expected roles.
    Expected Result: Korean aliases pass.
    Evidence: .sisyphus/evidence/task-14-korean-alias.txt
  ```

- [ ] 15. Run Steve Jobs/Sculley end-to-end regression

  **What to do**:
  - Regenerate compression refresh/bootstrap render for the Steve Jobs fixture.
  - Verify teaser timing, callback timing, max narration run, exchange metadata, review artifact, SRT cleanliness, and material color validation.

  **Must NOT do**:
  - Do not manually patch fixture output to pass.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with T16/T17/T18 after Wave 3.
  - **Parallel Group**: Wave 4
  - **Blocks**: Final verification
  - **Blocked By**: T11, T13, T14

  **References**:
  - `midform/test_runs/compress_20260727142327_luMBOVwyNzo/` - fixture.
  - `server/output/drafts/pipeline_1785150227/` - current latest draft baseline.

  **Acceptance Criteria**:
  - [ ] Hook dialogue starts within first 5s.
  - [ ] Callback dialogue block starts 20-35s.
  - [ ] Max narration run <=25s.
  - [ ] Material color validation passes for Jobs/Scully.

  **QA Scenarios**:
  ```text
  Scenario: Steve Jobs e2e editorial QA
    Tool: Bash
    Steps:
      1. Run `node -r dotenv/config scripts/midform.js compress-refresh compress_20260727142327_luMBOVwyNzo`.
      2. Run `node -r dotenv/config scripts/midform.js bootstrap compress_20260727142327_luMBOVwyNzo`.
      3. Inspect latest `edit_manifest.json` with artifact helper.
    Expected Result: Hook/callback/max narration constraints pass.
    Evidence: .sisyphus/evidence/task-15-steve-editorial-qa.txt

  Scenario: Steve Jobs e2e render color QA
    Tool: Bash
    Steps:
      1. Run final material color validator on latest draft.
      2. Assert Jobs and Scully material colors match expected hex/RGB.
    Expected Result: Manifest and material colors agree.
    Evidence: .sisyphus/evidence/task-15-steve-color-qa.txt
  ```

- [ ] 16. Add non-confrontation scene-type regression coverage

  **What to do**:
  - Add or select at least one emotional confession scene and one comedic/visual setpiece fixture.
  - Verify scene-type-aware opening policy does not overfit confrontation behavior.

  **Must NOT do**:
  - Do not require real external API calls in tests.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with T15/T17/T18.
  - **Parallel Group**: Wave 4
  - **Blocks**: Final verification
  - **Blocked By**: T9

  **References**:
  - `midform/test_runs/run_013_tVxYCeRXzGo_e2e/` - existing verify fixture.
  - `removed_ottugi_20260715/midform/test_runs_archive/` - archived runs only for reference; do not reintroduce archived paths.

  **Acceptance Criteria**:
  - [ ] Non-confrontation fixture can pass without callback pattern.
  - [ ] Confrontation-specific gates do not trigger on unrelated scene types.

  **QA Scenarios**:
  ```text
  Scenario: Confession scene opening policy
    Tool: Bash
    Steps:
      1. Run fixture-level selector test.
      2. Assert valid opening strategy is scene-type appropriate.
    Expected Result: Not forced into confrontation callback.
    Evidence: .sisyphus/evidence/task-16-confession.txt

  Scenario: Comedy/visual setpiece policy
    Tool: Bash
    Steps:
      1. Run fixture-level selector test.
      2. Assert narration/visual hook remains allowed.
    Expected Result: No overfit.
    Evidence: .sisyphus/evidence/task-16-comedy.txt
  ```

- [ ] 17. Wire tests/validators into project verification safely

  **What to do**:
  - Add stable, API-free tests to `npm run test:unit` or existing verify fixture scripts.
  - Keep `npm run verify` API-free and avoid browser UI/client build requirements.

  **Must NOT do**:
  - Do not add flaky external API/network steps to verify.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with T15/T16/T18.
  - **Parallel Group**: Wave 4
  - **Blocks**: Final verification
  - **Blocked By**: T13

  **References**:
  - `package.json` - `npm run verify`, `test:unit`.
  - `AGENTS.md` - required verification rules.

  **Acceptance Criteria**:
  - [ ] `npm run verify` remains API-free.
  - [ ] New tests run deterministically on local fixtures.

  **QA Scenarios**:
  ```text
  Scenario: Full verify remains API-free
    Tool: Bash
    Steps:
      1. Run `npm run verify`.
      2. Confirm no network/API credentials are required.
    Expected Result: Verify passes offline.
    Evidence: .sisyphus/evidence/task-17-npm-verify.txt

  Scenario: Unit tests include new validators
    Tool: Bash
    Steps:
      1. Run `node --test tests/*.test.js`.
      2. Confirm editorial and render validators are covered.
    Expected Result: Tests pass and include new coverage.
    Evidence: .sisyphus/evidence/task-17-unit-tests.txt
  ```

- [ ] 18. Backward compatibility and failure-mode audit

  **What to do**:
  - Re-run the failure modes from the audit against new behavior.
  - Confirm older artifacts degrade gracefully.
  - Update audit/review notes only if needed.

  **Must NOT do**:
  - Do not mask failures by weakening assertions.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with T15/T16/T17.
  - **Parallel Group**: Wave 4
  - **Blocks**: Final verification
  - **Blocked By**: T8-T14

  **References**:
  - `docs/raw/current-state-audit-2026-07-27-midform-pipeline.md:381` - failure/gap table.

  **Acceptance Criteria**:
  - [ ] Each listed high/medium failure mode has a test, validator, or documented non-scope rationale.
  - [ ] No new failure mode violates project guardrails.

  **QA Scenarios**:
  ```text
  Scenario: Audit failure-mode checklist
    Tool: Bash
    Steps:
      1. Run audit checklist script/test.
      2. Map each failure mode to pass/fail evidence.
    Expected Result: Coverage matrix is complete.
    Evidence: .sisyphus/evidence/task-18-failure-mode-matrix.txt

  Scenario: Legacy artifact compatibility
    Tool: Bash
    Steps:
      1. Run tests against older fixture artifact without new metadata.
      2. Assert parser/validator reports graceful defaults, not crashes.
    Expected Result: Backward compatibility preserved.
    Evidence: .sisyphus/evidence/task-18-legacy-compat.txt
  ```

---

## Final Verification Wave

> Run after all implementation tasks. All four reviews must approve before completion.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read this plan and changed files. Verify every Must Have and Must NOT Have. Confirm no scene-specific hardcoding and no archived Ottugi/shortform reintroduction.

  **Required Output**: `Must Have [N/N] | Must NOT Have [N/N] | Evidence [N/N] | VERDICT: APPROVE/REJECT`

  **QA Evidence**: `.sisyphus/evidence/final-compliance-audit.md`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `npm run verify`, inspect changed JS/Python/JSON for encoding safety, brittle tests, excessive comments, and unused/dead code.

  **Required Output**: `Verify [PASS/FAIL] | Encoding [PASS/FAIL] | Tests [N pass/N fail] | Files Reviewed [N] | VERDICT: APPROVE/REJECT`

  **QA Evidence**: `.sisyphus/evidence/final-code-quality.md`

- [ ] F3. **Artifact QA Replay** — `unspecified-high`
  Execute fixture QA for Steve Jobs/Sculley plus non-confrontation fixtures. Validate hook/callback timing, QC actions, review artifact, SRT cleanliness, and material color state.

  **Required Output**: `Scenarios [N/N pass] | Steve Fixture [PASS/FAIL] | Non-Confrontation [PASS/FAIL] | Material Colors [PASS/FAIL] | VERDICT: APPROVE/REJECT`

  **QA Evidence**: `.sisyphus/evidence/final-artifact-qa/`

- [ ] F4. **Scope Fidelity Check** — `deep`
  Compare final diff against this plan. Reject one-off copy tweaks, manual CapCut edits, or skipped render-material validation.

  **Required Output**: `Tasks [N/N compliant] | Scope Creep [NONE/N issues] | Missing Work [NONE/N issues] | VERDICT: APPROVE/REJECT`

  **QA Evidence**: `.sisyphus/evidence/final-scope-fidelity.md`

---

## Commit Strategy

- `test(midform): cover editorial generalization contracts` — Wave 1 tests/fixtures.
- `feat(midform): generalize teaser and exchange selection` — Wave 2 selector/QC.
- `feat(midform): propagate editorial linkage and validate render colors` — Wave 3 bootstrap/render.
- `test(midform): add e2e fixture coverage for scene policies` — Wave 4 fixtures/verify.

---

## Success Criteria

### Verification Commands

```bash
node --test tests/*.test.js
npm run verify
node -r dotenv/config scripts/midform.js bootstrap compress_20260727142327_luMBOVwyNzo --preflight-only
```

### Final Checklist

- [ ] Confrontation scenes prefer `cold_open_callback` unless teaser suitability fails.
- [ ] Teaser selection accounts for comprehension and accusation/response balance, not hook strength alone.
- [ ] Micro-exchange metadata exists while line-level subtitle sync remains intact.
- [ ] QC risk fields cause correction/gating actions.
- [ ] Context reset and callback linkage are machine-readable and human-reviewable.
- [ ] Final rendered text material colors match manifest colors for speaker-specific captions.
- [ ] `npm run verify` passes and remains API-free.
