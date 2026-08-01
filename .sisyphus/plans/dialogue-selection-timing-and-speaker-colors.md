# Dialogue Selection Timing and Speaker Colors Plan

## TL;DR

> **Quick Summary**: Fix the midform pipeline so dialogue-driven confrontation scenes bring preserved source dialogue in early, keep at least one early accusation-response exchange, limit long narration-only runs, and correctly apply speaker-specific subtitle colors in CapCut drafts.
>
> **Deliverables**:
> - TDD regression tests for early `KEEP_DIALOGUE` timing and narration-run limits.
> - TDD regression tests for early accusation-response preservation in the Steve Jobs/Sculley fixture.
> - TDD/regression coverage for speaker-specific caption color propagation into generated CapCut text materials.
> - Selection/scoring/QC implementation updates.
> - Regenerated Steve Jobs/Sculley draft ZIP with earlier dialogue and visible speaker-color metadata/application.
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 3 implementation waves + final verification
> **Critical Path**: T1/T2 tests → T3 selection rules → T5 speaker colors → T7 regenerate draft → final verification

---

## Context

### Original Request
The current Steve Jobs/Sculley draft technically renders, but the edit is weak: first preserved dialogue appears around 46.89s in a 97.1s video, so almost half the video is narration-only even though the source scene is a dialogue-driven confrontation.

The user also asked why speaker-specific text colors did not appear.

### Interview Summary
**Key Discussions**:
- User confirmed the main problem is editorial selection, not basic pipeline execution.
- The scene's strength is the verbal fight; narration should connect context but not delay the fight.
- For 90-110s confrontation cuts, first `KEEP_DIALOGUE` should appear in the 20-30s range.
- First preserved dialogue after 35s should warn; after 40s should fail selection unless explicitly overridden.
- At least one early accusation-response exchange should be preserved before midpoint.
- Continuous `NARRATE` runs should not exceed 20-25s in confrontation scenes.
- User selected **TDD**.
- User confirmed scope includes **Timing + Colors**.

**Research Findings**:
- Current generated Steve Jobs/Sculley run: `midform/test_runs/run_20260727_155842_Steve_vs._Scully_Full_Scene_Steve_Jobs`.
- Current generated CapCut draft: `server/output/drafts/pipeline_1785135546`.
- Current draft runtime: about `97.115s`.
- Current preserved dialogue is concentrated after the narration-led setup.
- Speaker metadata exists in generated artifacts: `speaker: "Jobs"` / `speaker: "Sculley"` in `script.json`, `slot_map.json`, and `draft_input.json`.
- Color handling exists in `scripts/capcut_draft.py`: `CAPTION_COLORS_CONFIG_PATH`, `load_caption_color_config()`, `caption_color_for_speaker()`, `caption_color`, and `apply_text_material_fill_color()`.
- Therefore speaker color failure is likely in config mapping, template-clone style override, or subtitle-only dialogue material path, not in missing speaker names.
- Explore/Metis agents were unreliable/empty/aborted in this session; do not depend on subagents for execution.

### Metis Review
**Identified Gaps** (handled by self-review because subagent aborted):
- Clarify whether the first-dialogue rule is global or scene-type-specific: default to confrontation/dialogue-driven scenes only.
- Clarify fail vs warning threshold: warning/QC failure after 35s, hard selection failure after 40s unless override exists.
- Clarify color scope: verify generated draft/material-level color application, not only metadata presence.
- Avoid scope creep into unrelated template redesign or archived Ottugi/shortform paths.

---

## Work Objectives

### Core Objective
Refactor the dialogue-heavy selection/QC pipeline so confrontation scenes surface preserved dialogue early and visibly distinguish speakers through caption colors in the generated CapCut draft.

### Concrete Deliverables
- Tests that fail on the current Steve Jobs/Sculley late-dialogue behavior.
- Tests that fail if speaker colors do not reach CapCut text materials or equivalent manifest evidence.
- Updated selection/scoring/QC logic enforcing early dialogue anchors and max narration-run constraints.
- Updated speaker-color config/application path, with explicit Jobs/Sculley mapping or deterministic fallback.
- Regenerated Steve Jobs/Sculley run and ZIP.

### Definition of Done
- [x] `node --test tests/*.test.js` passes.
- [x] `npm run verify` passes.
- [x] New Steve Jobs/Sculley regenerated draft has first `KEEP_DIALOGUE` timeline entry within 20-30s, or no later than 35s with documented warning; must not exceed 40s.
- [x] New Steve Jobs/Sculley selection preserves at least one early accusation-response exchange before the board-vote segment.
- [x] No continuous narration-only run exceeds 25s in the confrontation section.
- [x] Speaker-specific color evidence exists in generated CapCut draft materials/manifest for Jobs and Sculley dialogue captions.

### Must Have
- TDD first: write failing tests before implementation.
- Keep original dialogue audio for dialogue segments: `tts_enabled: false` remains for `dialogue_quote`/`KEEP_DIALOGUE`.
- Preserve review tags only in review artifacts, never final SRT visible text.
- Use `npm run verify` as final verification.

### Must NOT Have (Guardrails)
- Do not reintroduce archived Ottugi, shortform-highlight, YouTube upload, Virlo, or old generic routes.
- Do not make all videos obey confrontation-only timing rules; apply to dialogue-driven/confrontation mode only.
- Do not solve late dialogue by deleting necessary context entirely.
- Do not hardcode only this one Steve Jobs transcript line unless also adding generic scoring/rule logic.
- Do not rely on manual CapCut edits as the fix.
- Do not add debug tags like `[KEEP_DIALOGUE]`, source ids, or speaker labels to final SRT unless explicitly intended.

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** - ALL verification is agent-executed. No acceptance criterion requires manual confirmation.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: TDD
- **Framework**: Node built-in test runner via `node --test tests/*.test.js`
- **If TDD**: Each implementation task follows RED (failing test) → GREEN (minimal impl) → REFACTOR.

### QA Policy
Every task includes agent-executed QA scenarios. Evidence should be saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **API/Backend/CLI**: Use Bash/PowerShell command execution for `node --test`, `node -r dotenv/config scripts/midform.js ...`, JSON inspection commands, and `npm run verify`.
- **Library/Module**: Use Node test/REPL checks for exported/internal helper behavior where available.
- **CapCut Draft Artifact**: Verify generated JSON/material files and manifest fields programmatically; do not rely on visual manual inspection.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (TDD foundations, can run in parallel):
├── T1: Add dialogue timing regression tests [quick]
├── T2: Add speaker color regression tests [quick]
└── T3: Add artifact inspection helpers/fixtures for Steve Jobs run [quick]

Wave 2 (Implementation, after Wave 1 tests fail):
├── T4: Implement early dialogue anchor + narration-run QC [deep]
├── T5: Implement dialogue scoring updates for early accusation-response [deep]
└── T6: Fix speaker color config/application path [unspecified-high]

Wave 3 (Integration, after Wave 2):
├── T7: Regenerate Steve Jobs/Sculley compression/apply/bootstrap render [unspecified-high]
├── T8: Verify generated draft artifacts against new timing/color rules [quick]
└── T9: Clean up docs/comments and remove brittle test assumptions [quick]

Wave FINAL:
├── F1: Plan compliance audit
├── F2: Code quality review
├── F3: Artifact QA
└── F4: Scope fidelity check
```

### Dependency Matrix

- **T1**: blocked by none; blocks T4, T5, T7.
- **T2**: blocked by none; blocks T6, T7.
- **T3**: blocked by none; blocks T1, T2, T8.
- **T4**: blocked by T1; blocks T7.
- **T5**: blocked by T1/T3; blocks T7.
- **T6**: blocked by T2; blocks T7.
- **T7**: blocked by T4/T5/T6; blocks T8.
- **T8**: blocked by T7; blocks final verification.
- **T9**: blocked by T4/T5/T6; blocks final verification.

### Agent Dispatch Summary

- **Wave 1**: T1-T3 → `quick`
- **Wave 2**: T4-T5 → `deep`, T6 → `unspecified-high`
- **Wave 3**: T7 → `unspecified-high`, T8-T9 → `quick`
- **FINAL**: F1 → `oracle`, F2/F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. Add failing TDD tests for early dialogue timing rules

  **What to do**:
  - Add/extend a test file under `tests/` that loads a representative Steve Jobs/Sculley selection/edit-plan fixture.
  - Assert that for dialogue-driven confrontation cuts with total runtime 90-110s:
    - first preserved dialogue target is 20-30s;
    - warning/QC failure appears after 35s;
    - selection fails after 40s unless explicit override is set;
    - continuous narration-only run does not exceed 25s.
  - The current behavior should fail before implementation because first dialogue appears around 46.89s.

  **Must NOT do**:
  - Do not encode a test that only checks one exact output filename.
  - Do not make all non-confrontation videos fail this rule.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: focused test addition around existing fixtures/helper functions.
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: no browser UI verification needed.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 with Tasks 2-3
  - **Blocks**: Tasks 4, 5, 7
  - **Blocked By**: None

  **References**:
  - `tests/dialogueCoherenceQc.test.js` - Existing Node test style and Steve Jobs regression pattern.
  - `server/services/midformCompressionService.js` - Selection/finalization helpers and `_test` exports to extend.
  - `midform/test_runs/compress_20260727142327_luMBOVwyNzo/slot_qc_report.json` - Current QC artifact with dialogue slot metadata.
  - `midform/test_runs/run_20260727_155842_Steve_vs._Scully_Full_Scene_Steve_Jobs/pipeline_state.json` - Current rendered timing/duration reference showing late dialogue behavior.

  **Acceptance Criteria**:
  - [ ] A new or updated test fails against the current late-dialogue behavior before implementation.
  - [ ] Test names explicitly mention first dialogue timing and narration-run limit.
  - [ ] Test can be run with `node --test tests/*.test.js`.

  **QA Scenarios**:
  ```
  Scenario: RED test detects late first dialogue
    Tool: Bash
    Preconditions: Tests added before implementation change.
    Steps:
      1. Run `node --test tests/*.test.js`.
      2. Inspect output for the new first-dialogue timing assertion.
    Expected Result: The new test fails before implementation because first KEEP_DIALOGUE is after 40s.
    Failure Indicators: Test passes without implementation, or failure is unrelated syntax/import error.
    Evidence: .sisyphus/evidence/task-1-red-test-output.txt

  Scenario: Non-confrontation content is not incorrectly hard-failed
    Tool: Bash
    Preconditions: Test fixture marks content as not dialogue-driven confrontation.
    Steps:
      1. Run the targeted test file.
      2. Assert the non-confrontation fixture does not trigger the 20-30s rule.
    Expected Result: Only confrontation/dialogue-driven fixtures are subject to early dialogue anchor constraints.
    Evidence: .sisyphus/evidence/task-1-non-confrontation-output.txt
  ```

  **Commit**: YES
  - Message: `test(midform): cover early dialogue timing rules`
  - Files: `tests/*.test.js`
  - Pre-commit: `node --test tests/*.test.js`

- [x] 2. Add failing TDD tests for speaker color propagation

  **What to do**:
  - Add tests proving dialogue segments with `speaker: "Jobs"` and `speaker: "Sculley"` receive distinct caption colors.
  - Verify at least two layers:
    - config lookup / `caption_color_for_speaker()` behavior;
    - generated entry or material-level color evidence after draft generation/helper invocation.
  - If direct function import is not currently possible from `scripts/capcut_draft.py`, plan for a lightweight artifact-based test or Python unit script invoked by Node test.

  **Must NOT do**:
  - Do not only assert `speaker` exists; the regression must prove color application or manifest evidence.
  - Do not rely on visual inspection in CapCut.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: focused regression around existing color path.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 with Tasks 1 and 3
  - **Blocks**: Task 6
  - **Blocked By**: None

  **References**:
  - `scripts/capcut_draft.py:25` - Caption color config path.
  - `scripts/capcut_draft.py:108` - `load_caption_color_config()`.
  - `scripts/capcut_draft.py:159` - `caption_color_for_speaker()`.
  - `scripts/capcut_draft.py:2649-2704` - Template clone subtitle path and color application summary.
  - `scripts/capcut_draft.py:9758-9822` - Speaker/caption_color propagation into caption entries.
  - `midform/test_runs/run_20260727_155842_Steve_vs._Scully_Full_Scene_Steve_Jobs/draft_input.json` - Dialogue segment speaker metadata.

  **Acceptance Criteria**:
  - [ ] Test fails before fix if Jobs/Sculley dialogue captions do not produce distinct color evidence.
  - [ ] Test checks both `speaker` and `caption_color`/material color, not just one.
  - [ ] Test is included in `npm run test:unit` or a command called by `npm run verify`.

  **QA Scenarios**:
  ```
  Scenario: RED test detects missing speaker color application
    Tool: Bash
    Preconditions: Speaker color test added before implementation.
    Steps:
      1. Run `node --test tests/*.test.js`.
      2. Confirm the new color test fails because generated/artifact color evidence is missing or not distinct.
    Expected Result: Failure identifies Jobs/Sculley caption color propagation gap.
    Evidence: .sisyphus/evidence/task-2-red-color-test-output.txt

  Scenario: Missing speaker mapping has deterministic fallback
    Tool: Bash
    Preconditions: Test includes an unknown speaker value.
    Steps:
      1. Run targeted color test.
      2. Assert unknown speaker either uses a documented fallback or intentionally leaves color blank without breaking known speakers.
    Expected Result: Known speakers are colored; unknown speaker behavior is stable and documented.
    Evidence: .sisyphus/evidence/task-2-fallback-output.txt
  ```

  **Commit**: YES
  - Message: `test(capcut): cover speaker caption colors`
  - Files: `tests/*.test.js`, optional test fixtures
  - Pre-commit: `node --test tests/*.test.js`

- [x] 3. Add artifact inspection helpers for timing and color QA

  **What to do**:
  - Add reusable test/helper code to parse generated `pipeline_state.json`, `draft_input.json`, `slot_map.json`, `script.json`, and `edit_manifest.json`.
  - Compute:
    - total timeline duration;
    - first dialogue timeline start;
    - max continuous narration-only run;
    - whether at least one early dialogue pair exists before midpoint;
    - whether Jobs/Sculley color evidence exists.
  - Use helpers in tests rather than duplicating fragile JSON traversal.

  **Must NOT do**:
  - Do not make helper depend on absolute machine paths.
  - Do not parse Korean/Japanese files with unsafe encoding writes.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: fixture/parser utility work.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: Tasks 1, 2, 8
  - **Blocked By**: None

  **References**:
  - `midform/test_runs/run_20260727_155842_Steve_vs._Scully_Full_Scene_Steve_Jobs/pipeline_state.json` - Draft path, runtime, track counts.
  - `server/output/drafts/pipeline_1785135546/edit_manifest.json` - Caption units and template style summary.
  - `server/output/drafts/pipeline_1785135546/capcut_notes.md` - Existing generated summary fields.

  **Acceptance Criteria**:
  - [ ] Helpers work with relative project paths.
  - [ ] Helpers are covered by at least one simple test.
  - [ ] Helpers support both current failing artifacts and regenerated artifacts.

  **QA Scenarios**:
  ```
  Scenario: Helper computes current late dialogue timing
    Tool: Bash
    Preconditions: Existing Steve Jobs run artifacts are present.
    Steps:
      1. Run the helper test.
      2. Assert computed first dialogue start is after 40s for the current artifact.
    Expected Result: Helper reports late dialogue consistently.
    Evidence: .sisyphus/evidence/task-3-helper-current-output.txt

  Scenario: Helper handles missing optional files gracefully
    Tool: Bash
    Preconditions: Test fixture omits optional CapCut notes file.
    Steps:
      1. Run helper test.
      2. Assert it returns a structured missing-file result instead of throwing an unrelated error.
    Expected Result: Graceful, actionable failure message.
    Evidence: .sisyphus/evidence/task-3-helper-missing-output.txt
  ```

  **Commit**: YES
  - Message: `test(midform): add artifact QA helpers`
  - Files: `tests/*`
  - Pre-commit: `node --test tests/*.test.js`

- [x] 4. Implement early dialogue anchor and narration-run QC

  **What to do**:
  - Add selection/QC logic for dialogue-driven confrontation scenes:
    - target first `KEEP_DIALOGUE` within 20-30s for 90-110s cuts;
    - warning/QC issue after 35s;
    - fail selection after 40s unless override is explicitly set;
    - continuous narration-only runs should not exceed 25s.
  - Expose QC fields in generated reports so the executor can inspect why a plan passed or failed.
  - Keep rule scoped to dialogue-driven/confrontation mode.

  **Must NOT do**:
  - Do not simply move all dialogue earlier without considering context.
  - Do not break existing fixtures like `run_013_tVxYCeRXzGo_e2e`.

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: affects selection logic, QC, and generated artifacts.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES, with Task 6 after tests exist; coordinate with Task 5.
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 7
  - **Blocked By**: Tasks 1, 3

  **References**:
  - `server/services/midformCompressionService.js` - edit plan finalization, dialogue QC report, selection/scoring logic.
  - `scripts/midform.js:120-139` - `compress-apply` output should include QC report path.
  - `midform/test_runs/compress_20260727142327_luMBOVwyNzo/slot_qc_report.json` - Existing QC format to extend.

  **Acceptance Criteria**:
  - [ ] RED tests from Task 1 turn GREEN.
  - [ ] QC report includes first-dialogue timing and max-narration-run status.
  - [ ] Late first dialogue after 40s fails or is blocked unless explicit override is set.

  **QA Scenarios**:
  ```
  Scenario: Confrontation scene blocks first dialogue after 40s
    Tool: Bash
    Preconditions: Test fixture has first dialogue after 40s and no override.
    Steps:
      1. Run `node --test tests/*.test.js`.
      2. Inspect assertion for selection failure/QC failure.
    Expected Result: Test passes because late dialogue is rejected.
    Evidence: .sisyphus/evidence/task-4-late-dialogue-fail.txt

  Scenario: Override preserves debuggability
    Tool: Bash
    Preconditions: Test fixture sets explicit override.
    Steps:
      1. Run targeted test.
      2. Assert late dialogue can proceed but emits a warning with reason.
    Expected Result: Override path is explicit and visible in QC output.
    Evidence: .sisyphus/evidence/task-4-override-warning.txt
  ```

  **Commit**: YES
  - Message: `fix(midform): enforce early dialogue anchors`
  - Files: `server/services/midformCompressionService.js`, tests
  - Pre-commit: `node --test tests/*.test.js`

- [x] 5. Implement early accusation-response scoring updates

  **What to do**:
  - Add/update scoring dimensions:
    - `hook_strength`
    - `confrontation_clarity`
    - `quote_value`
    - `standalone_comprehension`
    - `early_engagement_value`
  - Prefer early accusation/rebuttal/truth-reversal lines before midpoint in confrontation scenes.
  - For Steve Jobs/Sculley, ensure at least one early pair like accusation/rebuttal is selected before board-vote/payoff section.
  - Preserve late payoff lines only after early engagement is satisfied.

  **Must NOT do**:
  - Do not overfit exclusively to exact YouTube transcript words.
  - Do not remove all late payoff dialogue; rebalance, do not flatten.

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: requires selection-quality logic, not just threshold checks.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with Task 4, but reconcile conflicts in same service file.
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 7
  - **Blocked By**: Tasks 1, 3

  **References**:
  - `server/services/midformCompressionService.js` - dialogue selection/scoring and edit plan generation.
  - `midform/test_runs/compress_20260727142327_luMBOVwyNzo/bootstrap_review_draft.md` - Current review draft showing preserved late dialogue concentration.
  - User-provided target examples: `you tried to kill it`, `I didn't kill the ad`, `the story of why and how you left Apple isn't true`.

  **Acceptance Criteria**:
  - [ ] Test proves an early accusation-response pair is selected before midpoint for Steve Jobs/Sculley.
  - [ ] Generated QC/scoring artifacts expose why early lines were selected.
  - [ ] Late payoff lines may remain, but not at the cost of delaying all dialogue until ~47s.

  **QA Scenarios**:
  ```
  Scenario: Steve Jobs fixture selects early confrontation pair
    Tool: Bash
    Preconditions: Updated scoring implemented.
    Steps:
      1. Run `node --test tests/*.test.js`.
      2. Inspect test assertion for an early selected pair before midpoint.
    Expected Result: Early pair is selected and tests pass.
    Evidence: .sisyphus/evidence/task-5-early-pair-test.txt

  Scenario: Late payoff still allowed after early hook
    Tool: Bash
    Preconditions: Fixture has both early and late candidate lines.
    Steps:
      1. Run selection test.
      2. Assert at least one late payoff line can remain if early hook rule is already satisfied.
    Expected Result: The result is rebalanced, not simply front-loaded.
    Evidence: .sisyphus/evidence/task-5-late-payoff-retained.txt
  ```

  **Commit**: YES
  - Message: `fix(midform): score early confrontation dialogue`
  - Files: `server/services/midformCompressionService.js`, tests
  - Pre-commit: `node --test tests/*.test.js`

- [x] 6. Fix speaker-specific caption color application

  **What to do**:
  - Verify or create `midform/config/caption_colors.json` with explicit mappings for known speakers and/or role fallback.
  - Ensure names are normalized consistently: `Jobs`, `Sculley`, possible full names, case variants.
  - Ensure dialogue subtitle entries carry `caption_color` through all paths, including subtitle-only original-dialogue captions.
  - Ensure template clone mode applies color to the cloned text material after template style is cloned, not before it is overwritten.
  - Add manifest evidence: count colored segments and list speaker/color mappings used.

  **Must NOT do**:
  - Do not apply speaker colors to narration captions.
  - Do not destroy template font/effect/style while changing fill color.
  - Do not require manual CapCut changes.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: cross-language path from JS artifacts to Python CapCut draft JSON.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with Tasks 4-5 after Task 2.
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 7
  - **Blocked By**: Task 2

  **References**:
  - `scripts/capcut_draft.py:25` - `CAPTION_COLORS_CONFIG_PATH`.
  - `scripts/capcut_draft.py:108-171` - color config loading and speaker lookup.
  - `scripts/capcut_draft.py:2649-2704` - template clone subtitle/color application summary.
  - `scripts/capcut_draft.py:9758-9822` and `10030-10062` - speaker and caption color propagation.
  - `server/output/drafts/pipeline_1785135546/edit_manifest.json` - current manifest style/color evidence.

  **Acceptance Criteria**:
  - [ ] Jobs and Sculley dialogue captions map to distinct configured colors.
  - [ ] Generated draft manifest reports colored dialogue segments > 0.
  - [ ] Final SRT remains clean of debug tags.
  - [ ] Template style is preserved except intended fill color changes.

  **QA Scenarios**:
  ```
  Scenario: Jobs and Sculley colors appear in generated manifest
    Tool: Bash
    Preconditions: Regenerated draft exists after implementation.
    Steps:
      1. Parse `server/output/drafts/<new-pipeline>/edit_manifest.json`.
      2. Assert dialogue captions for Jobs and Sculley have distinct `caption_color` or material fill-color evidence.
      3. Assert `colored_segments` or equivalent summary count is greater than zero.
    Expected Result: Speaker colors are visible in artifact data.
    Evidence: .sisyphus/evidence/task-6-color-manifest.json

  Scenario: Final SRT has no debug tags
    Tool: Bash
    Preconditions: Regenerated draft exists.
    Steps:
      1. Search `subtitles.srt` for `KEEP_DIALOGUE`, `NARRATE`, `slot_`, `faithful_dialogue`.
      2. Assert no matches.
    Expected Result: Color/debug metadata does not leak into viewer-facing subtitles.
    Evidence: .sisyphus/evidence/task-6-srt-clean.txt
  ```

  **Commit**: YES
  - Message: `fix(capcut): apply speaker caption colors`
  - Files: `scripts/capcut_draft.py`, `midform/config/caption_colors.json`, tests
  - Pre-commit: `node --test tests/*.test.js && npm run verify:py`

- [x] 7. Regenerate Steve Jobs/Sculley artifacts and draft ZIP

  **What to do**:
  - Re-run the smallest complete pipeline path for the existing compression run:
    - `node -r dotenv/config scripts/midform.js compress-apply compress_20260727142327_luMBOVwyNzo --context-file midform/test_runs/steve_jobs_next_sculley_context.md` if needed.
    - `node -r dotenv/config scripts/midform.js bootstrap compress_20260727142327_luMBOVwyNzo`.
  - Capture new run id and new `server/output/drafts/pipeline_*.zip`.
  - Ensure first dialogue timing, early pair, narration run, and speaker colors satisfy tests.

  **Must NOT do**:
  - Do not overwrite fixture source files with unsafe encoding commands.
  - Do not accept a render that only passes technically while failing timing/color QA.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: end-to-end generation may take time and has multiple artifacts.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 sequential start
  - **Blocks**: Task 8
  - **Blocked By**: Tasks 4, 5, 6

  **References**:
  - `scripts/midform.js:120-177` - `compress-apply` and `bootstrap` commands.
  - `midform/test_runs/compress_20260727142327_luMBOVwyNzo` - Existing compression run.
  - `midform/test_runs/steve_jobs_next_sculley_context.md` - Steve Jobs context file.

  **Acceptance Criteria**:
  - [ ] New pipeline run status is `completed`.
  - [ ] New ZIP exists under `server/output/drafts/`.
  - [ ] New draft runtime remains within midform guide.
  - [ ] New first dialogue timing is no later than allowed threshold.

  **QA Scenarios**:
  ```
  Scenario: Full bootstrap render completes
    Tool: Bash
    Preconditions: Implementation tests pass.
    Steps:
      1. Run `node -r dotenv/config scripts/midform.js bootstrap compress_20260727142327_luMBOVwyNzo`.
      2. Parse stdout for `pipeline_run_id` and `pipeline_run_dir`.
      3. Parse the new run's `pipeline_state.json` and assert `status: completed`.
    Expected Result: New render completes and points to a new draft ZIP.
    Evidence: .sisyphus/evidence/task-7-bootstrap-output.txt

  Scenario: Generated ZIP exists
    Tool: Bash
    Preconditions: Bootstrap render completed.
    Steps:
      1. Read `pipeline_state.json` artifact `draftZipPath`.
      2. Assert the file exists and has non-zero size.
    Expected Result: ZIP is present and non-empty.
    Evidence: .sisyphus/evidence/task-7-zip-check.txt
  ```

  **Commit**: NO
  - Generated run artifacts may be large; commit only if repo conventions require it.

- [x] 8. Verify regenerated draft artifacts against timing and color rules

  **What to do**:
  - Use the artifact helper from Task 3 to inspect the regenerated run and draft.
  - Confirm:
    - first dialogue timeline start within 20-30s target or at least <=35s;
    - no first dialogue after 40s;
    - no continuous narration-only run >25s;
    - early accusation-response pair before midpoint;
    - Jobs/Sculley speaker colors applied distinctly;
    - final SRT has no debug tags.

  **Must NOT do**:
  - Do not rely on visual/manual judgement only.
  - Do not ignore warnings if thresholds fail.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: artifact verification against explicit criteria.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with Task 9 after Task 7.
  - **Parallel Group**: Wave 3
  - **Blocks**: Final verification
  - **Blocked By**: Task 7

  **References**:
  - New run `pipeline_state.json` from Task 7.
  - New draft `edit_manifest.json` and `subtitles/subtitles.srt` from Task 7.
  - `tests/*` artifact helper from Task 3.

  **Acceptance Criteria**:
  - [ ] Artifact QA output shows all timing/color checks pass.
  - [ ] Evidence files include computed values, not just pass/fail text.

  **QA Scenarios**:
  ```
  Scenario: Timing QA passes on regenerated draft
    Tool: Bash
    Preconditions: New render exists.
    Steps:
      1. Run artifact QA helper against the new `pipeline_state.json`.
      2. Assert first dialogue timing and max narration run are within thresholds.
    Expected Result: Timing QA passes with computed values recorded.
    Evidence: .sisyphus/evidence/task-8-timing-qa.json

  Scenario: Color QA passes on regenerated draft
    Tool: Bash
    Preconditions: New render exists.
    Steps:
      1. Run artifact QA helper against new draft manifest/materials.
      2. Assert Jobs and Sculley have distinct color evidence.
    Expected Result: Color QA passes with mapping values recorded.
    Evidence: .sisyphus/evidence/task-8-color-qa.json
  ```

  **Commit**: YES if helper/test updates required
  - Message: `test(midform): verify regenerated dialogue artifacts`
  - Files: tests only if changed
  - Pre-commit: `node --test tests/*.test.js`

- [x] 9. Clean up comments, brittle assumptions, and run full verification

  **What to do**:
  - Remove temporary debug code.
  - Ensure comments explain rules without over-commenting obvious code.
  - Run full verification:
    - `npm run verify`
  - Note if existing fixture report prints internal JSON `status: failed` while command exit is still 0; do not treat as failure unless exit code fails or project policy changes.

  **Must NOT do**:
  - Do not skip `npm run verify`.
  - Do not leave test-only hacks in production code.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: cleanup and verification.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES with Task 8 after Task 7, but final `npm run verify` should run after all changes.
  - **Parallel Group**: Wave 3
  - **Blocks**: Final verification
  - **Blocked By**: Tasks 4, 5, 6, 7

  **References**:
  - `package.json:14-20` - required verification scripts.
  - `AGENTS.md` - mandatory encoding and `npm run verify` rules.

  **Acceptance Criteria**:
  - [ ] `npm run verify` exits 0.
  - [ ] LSP diagnostics for touched JS files show no errors.
  - [ ] No mojibake/replacement character regressions.

  **QA Scenarios**:
  ```
  Scenario: Full verification passes
    Tool: Bash
    Preconditions: All implementation and artifact QA complete.
    Steps:
      1. Run `npm run verify`.
      2. Record full output and exit code.
    Expected Result: Exit code 0.
    Evidence: .sisyphus/evidence/task-9-npm-verify.txt

  Scenario: LSP diagnostics are clean
    Tool: LSP diagnostics
    Preconditions: Files saved.
    Steps:
      1. Run diagnostics on touched JS service files.
      2. Run diagnostics on relevant test files if supported.
    Expected Result: No error-level diagnostics.
    Evidence: .sisyphus/evidence/task-9-lsp-diagnostics.txt
  ```

  **Commit**: YES
  - Message: `chore(midform): verify dialogue timing and colors`
  - Files: only intended source/test/config files
  - Pre-commit: `npm run verify`

---

## Final Verification Wave

> 4 review agents or equivalent review passes run after all implementation tasks. All must approve before completion.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Verify every Must Have and Must NOT Have against the diff and generated artifacts. Confirm first dialogue timing, early pair, narration-run limit, speaker color evidence, clean SRT, and `npm run verify` evidence.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Review changed source/tests/config for brittle fixture hardcoding, unsafe encoding writes, overbroad global rules, unused imports, and AI-slop comments.
  Output: `Build [PASS/FAIL] | Tests [PASS/FAIL] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Artifact QA** — `unspecified-high`
  Programmatically inspect regenerated run/draft artifacts. Check timing/color values and evidence files.
  Output: `Timing [PASS/FAIL] | Colors [PASS/FAIL] | SRT Clean [PASS/FAIL] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  Ensure changes are limited to midform selection/QC, CapCut speaker color path, tests, and necessary config. Reject any reintroduction of archived paths or unrelated UI/template redesign.
  Output: `Scope [CLEAN/ISSUES] | Unrelated Changes [N] | VERDICT`

---

## Commit Strategy

- **1**: `test(midform): cover early dialogue timing rules` - timing tests/helpers
- **2**: `test(capcut): cover speaker caption colors` - color tests/helpers
- **3**: `fix(midform): enforce early confrontation dialogue` - selection/QC/scoring updates
- **4**: `fix(capcut): apply speaker caption colors` - color config/application path
- **5**: `chore(midform): verify regenerated dialogue draft` - verification/test cleanup if needed

---

## Success Criteria

### Verification Commands
```bash
node --test tests/*.test.js
npm run verify
node -r dotenv/config scripts/midform.js bootstrap compress_20260727142327_luMBOVwyNzo
```

### Final Checklist
- [ ] TDD tests were red before implementation and green after.
- [ ] First preserved dialogue appears early enough for the Steve Jobs/Sculley confrontation cut.
- [ ] At least one early accusation-response exchange is preserved before midpoint.
- [ ] No narration-only run exceeds the configured confrontation threshold.
- [ ] Speaker colors are applied to Jobs/Sculley dialogue captions in generated draft artifacts.
- [ ] Final SRT contains no debug/review tags.
- [x] `npm run verify` passes.
- [ ] No archived Ottugi/shortform/Virlo/YouTube upload paths reintroduced.
