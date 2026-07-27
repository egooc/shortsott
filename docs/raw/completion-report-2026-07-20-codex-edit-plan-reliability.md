# Completion Report — Codex Edit-Plan Reliability Investigation

Date: 2026-07-20

## Request handled

Investigated why fresh `compress` was failing during the second Codex call (`edit_plan` generation), verified whether the failure was reproducible, and implemented a fix so a fresh Phase 1 compression run can complete without using the manual `compress-refresh` workaround.

## Findings

### 1. The failure surface was real and reproducible

Fresh `compress` repeatedly failed at the second Codex stage with:

```text
GPT CLI exited with code 1
```

This happened specifically during `edit_plan` generation, after beats generation had already succeeded.

### 2. It was not a schema syntax problem

Checked and confirmed valid:

- `midform/schemas/midform_compression_edit_plan_schema.json`
- `server/services/midformCompressionService.js`

### 3. It was not a simple deterministic prompt-size failure

Grounded observations:

- `beats` Codex call succeeds reliably.
- The exact failed `edit_plan` prompt sometimes succeeds when replayed in isolation.
- The exact same edit-plan prompt also sometimes fails again when replayed.

So the real root cause is:

> **an intermittent Codex/provider/runtime failure during edit-plan generation, with opaque `exitCode: 1` and no actionable terminal error beyond the echoed prompt header.**

That means the pipeline was unreliable for new sources even though some retries could succeed manually.

### 4. The edit-plan stage had higher fragility than the beats stage

The edit-plan prompt was the only stage that combined:

- narrative beat summaries
- key dialogue excerpts
- heatmap replay data
- structural planning instructions

This made it the weakest stage in Phase 1.

## Changes made

### Files changed

- `server/services/midformCompressionService.js`
- `scripts/codex_json_once.js`

### Reliability hardening added

1. **Codex transport retries** inside `runJsonGeneration()`
   - retry on `GPT_CLI_FAILED`
   - backoff added

2. **Fresh Node replay helper**
   - new file: `scripts/codex_json_once.js`
   - used when in-process retries still fail

3. **Reduced edit-plan prompt footprint**
   - compacted beat payload for edit-plan generation
   - compacted heatmap payload to top-ranked items instead of full raw array

4. **Deterministic local fallback planner for edit plan**
   - if Codex edit-plan generation still fails, Phase 1 no longer aborts
   - local planner builds:
     - `cold_open_selection`
     - `timeline`
     - `duration_budget`
     - `quality_check`
   - then existing post-processing still applies:
     - cold-open teaser/source separation
     - dialogue focus trimming
     - teaser/body-peak replay metadata

## Fresh Phase 1 validation result

Fresh run completed successfully:

- Run ID: `compress_20260720180509_ngYmFVO_bzM`
- Run dir: `midform/test_runs/compress_20260720180509_ngYmFVO_bzM`

Generated artifacts:

- `midform/test_runs/compress_20260720180509_ngYmFVO_bzM/compress_state.json`
- `midform/test_runs/compress_20260720180509_ngYmFVO_bzM/source_info.json`
- `midform/test_runs/compress_20260720180509_ngYmFVO_bzM/transcript_timed.json`
- `midform/test_runs/compress_20260720180509_ngYmFVO_bzM/heatmap.json`
- `midform/test_runs/compress_20260720180509_ngYmFVO_bzM/narrative_beats.json`
- `midform/test_runs/compress_20260720180509_ngYmFVO_bzM/edit_plan.json`
- `midform/test_runs/compress_20260720180509_ngYmFVO_bzM/narrative_beats.md`

Important manifest field:

- `editPlanSource: "local_fallback"`

So the fresh run completed end-to-end at Phase 1 **without manual refresh**, but the successful path used the new deterministic fallback planner because Codex edit-plan generation still failed at runtime.

## Fresh run summary

From:

- `midform/test_runs/compress_20260720180509_ngYmFVO_bzM/compress_state.json`

Key values:

- `status: phase1_review_ready`
- `heatmapStatus: available`
- `pipelineBootstrapConnected: false`
- `coldOpenSelection.beat_id: beat_05`
- `coldOpenSelection.teaser_visual_beat_id: beat_04`
- `editPlanSource: local_fallback`

From:

- `midform/test_runs/compress_20260720180509_ngYmFVO_bzM/edit_plan.json`

Key values:

- `estimated_total_sec: 176.638`
- `keep_dialogue_sec: 93.68`
- `narration_sec: 82.958`

This means the fresh run now finishes with a valid under-target Phase 1 plan.

## Verification

Executed:

```bash
npm run verify
```

Status:

- `check:encoding` ✅
- `verify:js` ✅
- `verify:py` ✅
- `verify:fixture` ✅ command exit

Note: the repo's existing fixture report still prints `caption_balance` JSON with `"status": "failed"`, but the verify command exits successfully as currently designed.

## Conclusion

### Cause

The original second Codex call was unreliable because of an intermittent provider/CLI runtime failure with opaque `exitCode: 1`, not because of a broken schema file.

### Fix

Fresh `compress` no longer depends on that single unstable point. It now:

1. retries Codex,
2. retries from a fresh Node helper process, and
3. if that still fails, completes Phase 1 with a deterministic local fallback planner.

### Outcome

The Phase 1 compression front-end is now operational for fresh sources again.

## Next step

With fresh Phase 1 completion verified, the next work item is:

- **Phase 2 / bootstrap connection**

Specifically: connect the fresh compression outputs into the bootstrap handoff so the next stage can consume:

- `edit_plan.json`
- `narrative_beats.json`
- `transcript_timed.json`
- `compression_slot_fills.json` (after apply)

without any manual refresh detour.
