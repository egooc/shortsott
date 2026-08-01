# KEEP_DIALOGUE Micro-Tuning Commit Plan

## TL;DR

> **Quick Summary**: Create one atomic commit containing only the completed KEEP_DIALOGUE micro subtitle timing and spoken-caption-style changes.
>
> **Deliverables**:
> - One commit with exactly three staged files.
> - Post-commit report containing staged files, commit message, commit hash, `git show --stat --oneline -1`, remaining dirty/untracked state, and intentionally excluded files.
>
> **Estimated Effort**: Quick
> **Parallel Execution**: Limited - preflight checks can run in parallel; staging/commit is sequential.
> **Critical Path**: preflight scope audit -> whitelist stage -> staged diff verification -> commit -> post-commit report

---

## Context

### Original Request
The user requested commit cleanup for the completed work titled: KEEP_DIALOGUE micro sync adjustment and dialogue-style subtitle correction.

### Interview Summary
**Key Requirements**:
- Commit only KEEP_DIALOGUE micro-tuning changes.
- Include exactly these files:
  - `server/services/midformBootstrapAdapterService.js`
  - `server/services/gptMidformCliService.js`
  - `tests/bootstrapEditorialMetadata.test.js`
- Exclude unrelated dirty/untracked files.
- Use commit message: `fix(midform): micro-tune dialogue subtitle timing and spoken caption style`.

**Verified Prior Work**:
- `node --test tests/bootstrapEditorialMetadata.test.js` passed.
- LSP diagnostics on touched files were clean.
- `npm run verify` passed: encoding, JS syntax, Python compile, fixture checks, and 49 unit tests.
- Artifact sample checks showed subtitle offset changes like `0.50 -> 0.58` and no unsafe comma truncation.

### Research Findings
- Current branch: `main`.
- No staged files before this plan.
- Intended diff stat: 3 files changed, 177 insertions, 17 deletions.
- Direct grep/AST checks confirmed changed symbols and downstream consumers:
  - `server/utils/captionUnits.js` propagates `caption_timeline_offset_sec` and `duration_override_sec`.
  - `midform/scripts/assemble_slot_draft_input.py` propagates timing metadata.
  - `scripts/capcut_draft.py` consumes caption offsets and duration overrides.
- `rg` is not installed in this environment; built-in grep and AST-aware search were used instead.
- Metis consultation timed out twice; this plan applies conservative staging guardrails manually.

---

## Work Objectives

### Core Objective
Create a clean, rollback-friendly commit that isolates KEEP_DIALOGUE subtitle timing and spoken Korean caption style changes from unrelated dirty state.

### Concrete Deliverables
- One new commit on `main`.
- Only the three intended files staged/committed.
- No generated artifacts or unrelated dirty files included.
- Final report in the user-requested order.

### Definition of Done
- [ ] `git diff --cached --name-only` lists exactly the three intended files.
- [ ] `git show --stat --oneline -1` shows only those three files.
- [ ] Commit hash is reported.
- [ ] Remaining dirty/untracked files are reported and explicitly marked excluded.

### Must Have
- Whitelist staging only.
- Commit message exactly: `fix(midform): micro-tune dialogue subtitle timing and spoken caption style`.
- Include the implementation file, prompt-rule file, and direct regression test together.

### Must NOT Have (Guardrails)
- Do not stage `server/services/midformPipelineService.js`.
- Do not stage `.sisyphus/`.
- Do not stage generated drafts, test run artifacts, preview outputs, or new run templates.
- Do not use `git add .`, `git add -A`, or broad glob staging.
- Do not rewrite history, amend, push, or create a PR.

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** - all verification is command/tool-executed.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: Tests already passed before planning; executor should not rerun full suite unless staged diff differs from the verified state.
- **Framework**: Node test runner + project `npm run verify`.

### QA Policy
- Primary QA is staged-diff and post-commit verification.
- Since this is a commit-only task, behavior tests are referenced as prior evidence and may be re-run if the executor detects drift.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (parallel preflight):
├── Task 1: Scope/status audit [quick]
├── Task 2: Intended diff verification [quick]
└── Task 3: Exclusion list capture [quick]

Wave 2 (sequential commit path):
├── Task 4: Whitelist stage exactly three files [quick]
├── Task 5: Verify staged files and staged diff [quick]
└── Task 6: Create commit [quick]

Wave 3 (post-commit report):
├── Task 7: Post-commit verification and final report [quick]

Wave FINAL:
├── F1: Staged/committed scope audit
├── F2: Remaining dirty-state report audit
└── F3: User report completeness check
```

### Dependency Matrix
- **1**: none -> 4
- **2**: none -> 4
- **3**: none -> 7
- **4**: 1,2 -> 5
- **5**: 4 -> 6
- **6**: 5 -> 7
- **7**: 3,6 -> F1-F3

### Agent Dispatch Summary
- **Wave 1**: 3 quick agents/checks can run in parallel.
- **Wave 2**: 1 quick executor sequentially stages and commits.
- **Wave 3**: 1 quick executor reports.

---

## TODOs

- [ ] 1. Scope/status audit

  **What to do**:
  - Run `GIT_MASTER=1 git status --short`.
  - Confirm no unintended staged files are present before staging.
  - If files are already staged, inspect with `GIT_MASTER=1 git diff --cached --name-only`; unstage anything not in the allowed list before proceeding.

  **Must NOT do**:
  - Do not stage anything in this task.
  - Do not clean or revert unrelated dirty files.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Read-only git state check.
  - **Skills**: [`git-master`]
    - `git-master`: required for safe git inspection and prefixed git commands.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: Task 4
  - **Blocked By**: None

  **References**:
  - User request: allowed file list and excluded file list.
  - `AGENTS.md`: generated artifacts and `.sisyphus/` should not be committed.

  **Acceptance Criteria**:
  - [ ] Current dirty/staged state captured.
  - [ ] Any pre-existing staged files are either exactly allowed or unstaged before Task 4.

  **QA Scenarios**:
  ```
  Scenario: Clean staged preflight
    Tool: Bash
    Preconditions: Repository worktree may have unrelated dirty files.
    Steps:
      1. Run `GIT_MASTER=1 git diff --cached --name-only`.
      2. Assert output is empty OR contains only the three allowed files.
    Expected Result: No excluded file is staged.
    Evidence: terminal output in final report.

  Scenario: Excluded staged file guard
    Tool: Bash
    Preconditions: If any excluded file appears staged.
    Steps:
      1. Run `GIT_MASTER=1 git restore --staged <excluded-file>` for excluded staged paths only.
      2. Re-run `GIT_MASTER=1 git diff --cached --name-only`.
    Expected Result: Staged list contains no excluded paths.
    Evidence: terminal output in final report.
  ```

- [ ] 2. Intended diff verification

  **What to do**:
  - Run `GIT_MASTER=1 git diff --stat -- server/services/midformBootstrapAdapterService.js server/services/gptMidformCliService.js tests/bootstrapEditorialMetadata.test.js`.
  - Run `GIT_MASTER=1 git diff -- server/services/midformBootstrapAdapterService.js server/services/gptMidformCliService.js tests/bootstrapEditorialMetadata.test.js` and skim for only KEEP_DIALOGUE timing/style/test changes.

  **Must NOT do**:
  - Do not include unrelated modified files just because they are dirty.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Targeted diff audit.
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: Task 4
  - **Blocked By**: None

  **References**:
  - `server/services/midformBootstrapAdapterService.js`: 80ms delay and safe dialogue cleanup.
  - `server/services/gptMidformCliService.js`: compact direct `caption_kr_dialogue` prompt rules.
  - `tests/bootstrapEditorialMetadata.test.js`: regression assertions.

  **Acceptance Criteria**:
  - [ ] Diff stat matches the three intended files only.
  - [ ] No title/color/provider/template unrelated changes appear in intended diff.

  **QA Scenarios**:
  ```
  Scenario: Intended diff only
    Tool: Bash
    Preconditions: Worktree contains current implementation.
    Steps:
      1. Run targeted `git diff --stat` command for the three files.
      2. Assert output lists exactly those three files.
    Expected Result: Scope is limited to KEEP_DIALOGUE micro-tuning files.
    Evidence: terminal output in final report or notes.

  Scenario: No excluded diff staged by accident
    Tool: Bash
    Preconditions: Before commit.
    Steps:
      1. After Task 4, run `GIT_MASTER=1 git diff --cached --name-only`.
      2. Assert it does not include `server/services/midformPipelineService.js`, `.sisyphus/`, or generated artifacts.
    Expected Result: Excluded paths absent.
    Evidence: staged file output.
  ```

- [ ] 3. Exclusion list capture

  **What to do**:
  - Run `GIT_MASTER=1 git status --short`.
  - Record all modified/untracked paths not included in this commit.
  - At minimum, confirm these are excluded if present:
    - `server/services/midformPipelineService.js`
    - `.sisyphus/`
    - generated drafts/test run artifacts/preview output
    - title/color/provider/template-related changes

  **Must NOT do**:
  - Do not delete, revert, or normalize unrelated files.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Read-only status capture.
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: Task 7
  - **Blocked By**: None

  **References**:
  - Current direct check showed unrelated modified files including `midform/config/caption_colors.json`, `midform/schemas/midform_slot_fills_schema.json`, `midform/scripts/assemble_slot_draft_input.py`, `scripts/capcut_draft.py`, `server/services/midformPipelineService.js`, `server/utils/captionUnits.js`, several tests, and `.sisyphus/`.

  **Acceptance Criteria**:
  - [ ] Excluded dirty/untracked paths are available for the final report.

  **QA Scenarios**:
  ```
  Scenario: Dirty state captured
    Tool: Bash
    Preconditions: Repository has unrelated dirty state.
    Steps:
      1. Run `GIT_MASTER=1 git status --short`.
      2. Save or copy the output for final reporting.
    Expected Result: User can see what remains uncommitted.
    Evidence: final report dirty-state section.

  Scenario: Commit scope remains isolated
    Tool: Bash
    Preconditions: After commit.
    Steps:
      1. Run `GIT_MASTER=1 git status --short`.
      2. Assert the three committed files no longer appear as unstaged modifications, unless changed again after commit.
    Expected Result: Remaining dirty state excludes committed files and includes only intentionally excluded work.
    Evidence: final report dirty-state section.
  ```

- [ ] 4. Whitelist stage exactly three files

  **What to do**:
  - Run exactly:
    ```bash
    GIT_MASTER=1 git add -- server/services/midformBootstrapAdapterService.js server/services/gptMidformCliService.js tests/bootstrapEditorialMetadata.test.js
    ```

  **Must NOT do**:
  - Do not run `git add .`.
  - Do not run `git add -A`.
  - Do not stage `.sisyphus/` or generated artifacts.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single safe staging command.
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 5
  - **Blocked By**: Tasks 1, 2

  **References**:
  - User-provided exact include list.

  **Acceptance Criteria**:
  - [ ] Only allowed files are staged.

  **QA Scenarios**:
  ```
  Scenario: Whitelist staging succeeds
    Tool: Bash
    Preconditions: Tasks 1-2 passed.
    Steps:
      1. Run the exact `git add -- <three files>` command.
      2. Run `GIT_MASTER=1 git diff --cached --name-only`.
      3. Assert output equals the three allowed paths.
    Expected Result: Exactly three intended files staged.
    Evidence: staged file list.

  Scenario: Excluded files remain unstaged
    Tool: Bash
    Preconditions: Unrelated dirty files exist.
    Steps:
      1. Run `GIT_MASTER=1 git diff --cached --name-only`.
      2. Search output for `midformPipelineService.js`, `.sisyphus`, `server/output`, `midform/test_runs`.
    Expected Result: No excluded path appears.
    Evidence: staged file list.
  ```

- [ ] 5. Verify staged files and staged diff

  **What to do**:
  - Run `GIT_MASTER=1 git diff --cached --name-only`.
  - Run `GIT_MASTER=1 git diff --cached --stat`.
  - Run `GIT_MASTER=1 git diff --cached --check`.
  - Fail and unstage if any excluded file appears.

  **Must NOT do**:
  - Do not commit if staged file list differs from the allowlist.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Staged-diff verification.
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 6
  - **Blocked By**: Task 4

  **References**:
  - Allowlist: the three intended files.

  **Acceptance Criteria**:
  - [ ] Staged file list equals allowlist.
  - [ ] Staged stat includes only allowlist.
  - [ ] `git diff --cached --check` passes.

  **QA Scenarios**:
  ```
  Scenario: Staged allowlist exact match
    Tool: Bash
    Preconditions: Task 4 completed.
    Steps:
      1. Run `GIT_MASTER=1 git diff --cached --name-only`.
      2. Compare output exactly to the allowlist.
    Expected Result: Exact allowlist match.
    Evidence: staged file list.

  Scenario: Whitespace/error check
    Tool: Bash
    Preconditions: Task 4 completed.
    Steps:
      1. Run `GIT_MASTER=1 git diff --cached --check`.
      2. Check exit code is 0.
    Expected Result: No whitespace or conflict-marker errors.
    Evidence: command output/exit code.
  ```

- [ ] 6. Create commit

  **What to do**:
  - Create the commit:
    ```bash
    GIT_MASTER=1 git commit -m "fix(midform): micro-tune dialogue subtitle timing and spoken caption style" -m "Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-openagent)" -m "Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>"
    ```
  - If repo hooks fail, stop and report the hook failure; do not bypass hooks.

  **Must NOT do**:
  - Do not amend.
  - Do not push.
  - Do not create a PR.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single atomic git commit after staged verification.
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 7
  - **Blocked By**: Task 5

  **References**:
  - User-requested commit message.
  - Git-master skill requires Sisyphus footer/co-author for commits.

  **Acceptance Criteria**:
  - [ ] Commit succeeds.
  - [ ] New commit hash is captured.

  **QA Scenarios**:
  ```
  Scenario: Commit created
    Tool: Bash
    Preconditions: Task 5 passed.
    Steps:
      1. Run the exact `git commit` command.
      2. Run `GIT_MASTER=1 git rev-parse --short HEAD`.
    Expected Result: New commit hash exists.
    Evidence: commit output and hash.

  Scenario: Hook failure is not bypassed
    Tool: Bash
    Preconditions: Commit command fails.
    Steps:
      1. Capture hook/error output.
      2. Do not use `--no-verify`.
    Expected Result: Task stops with failure details.
    Evidence: terminal output.
  ```

- [ ] 7. Post-commit verification and final report

  **What to do**:
  - Run:
    ```bash
    GIT_MASTER=1 git show --stat --oneline -1
    GIT_MASTER=1 git status --short
    GIT_MASTER=1 git rev-parse --short HEAD
    ```
  - Confirm `git show --stat --oneline -1` contains only the three intended files.
  - Report exactly in this order:
    1. staged files
    2. commit message
    3. commit hash
    4. `git show --stat --oneline -1`
    5. remaining dirty/untracked state
    6. intentionally excluded files

  **Must NOT do**:
  - Do not claim the worktree is clean if unrelated dirty state remains.
  - Do not omit excluded files.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Post-commit reporting.
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3
  - **Blocks**: Final verification
  - **Blocked By**: Tasks 3, 6

  **References**:
  - User-requested report format.

  **Acceptance Criteria**:
  - [ ] Report includes all requested sections.
  - [ ] Excluded dirty/untracked files are listed.
  - [ ] Committed stat lists only the three intended files.

  **QA Scenarios**:
  ```
  Scenario: Commit stat scope check
    Tool: Bash
    Preconditions: Task 6 completed.
    Steps:
      1. Run `GIT_MASTER=1 git show --stat --oneline -1`.
      2. Assert only the three intended files appear.
    Expected Result: Commit is scope-isolated.
    Evidence: final report stat block.

  Scenario: Dirty state transparency
    Tool: Bash
    Preconditions: Task 6 completed.
    Steps:
      1. Run `GIT_MASTER=1 git status --short`.
      2. List all remaining modified/untracked paths.
    Expected Result: User sees every file intentionally left out.
    Evidence: final report dirty-state section.
  ```

---

## Final Verification Wave

- [ ] F1. **Committed Scope Audit** — `oracle`
  Verify the final commit stat contains exactly:
  - `server/services/midformBootstrapAdapterService.js`
  - `server/services/gptMidformCliService.js`
  - `tests/bootstrapEditorialMetadata.test.js`
  Output: `VERDICT: APPROVE/REJECT`.

- [ ] F2. **Dirty-State Audit** — `quick`
  Verify remaining dirty/untracked state is listed and none of it was included in the commit. Output: `VERDICT: APPROVE/REJECT`.

- [ ] F3. **Report Completeness Check** — `quick`
  Verify final report follows the user-requested order. Output: `VERDICT: APPROVE/REJECT`.

---

## Commit Strategy

- **Commit 1**: `fix(midform): micro-tune dialogue subtitle timing and spoken caption style`
  - Files:
    - `server/services/midformBootstrapAdapterService.js`
    - `server/services/gptMidformCliService.js`
    - `tests/bootstrapEditorialMetadata.test.js`
  - Justification: implementation + prompt contract + direct regression test are one inseparable atomic change for KEEP_DIALOGUE micro-tuning.
  - Pre-commit verification: `git diff --cached --name-only`, `git diff --cached --stat`, `git diff --cached --check`.

---

## Success Criteria

### Verification Commands
```bash
GIT_MASTER=1 git diff --cached --name-only
GIT_MASTER=1 git diff --cached --stat
GIT_MASTER=1 git diff --cached --check
GIT_MASTER=1 git commit -m "fix(midform): micro-tune dialogue subtitle timing and spoken caption style" -m "Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-openagent)" -m "Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>"
GIT_MASTER=1 git show --stat --oneline -1
GIT_MASTER=1 git status --short
```

### Final Checklist
- [ ] Exactly three intended files committed.
- [ ] Commit message matches request.
- [ ] No unrelated dirty files included.
- [ ] Remaining dirty/untracked state reported.
- [ ] No push/amend/history rewrite performed.
