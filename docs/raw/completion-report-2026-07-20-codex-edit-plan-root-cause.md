# Completion Report — Codex Edit-Plan Root Cause

Date: 2026-07-20

## Request handled

Investigated the Codex edit-plan failure to determine the real cause rather than treating it as opaque.

## Root cause

The actual failure was **schema rejection before generation**, not a vague provider fault.

### Confirmed error

When the edit-plan prompt was executed with Codex JSON event output, the CLI returned:

```text
invalid_json_schema
Invalid schema for response_format 'codex_output_schema':
In context=('properties', 'cold_open_selection'),
'required' is required to be supplied and to be an array including every key in properties.
Missing 'teaser_visual_mode'.
```

This came from the updated file:

- `midform/schemas/midform_compression_edit_plan_schema.json`

We had added new properties to:

- `cold_open_selection.properties`
- `timeline.items.properties`

but did **not** add them to the corresponding `required` arrays.

Codex's structured response mode rejects that schema up front.

## Why earlier direct tests were misleading

There was a second issue in our local test path:

- `server/services/gptMidformCliService.js`
  - `safeOutputSchemaPath()` previously normalized the incoming schema path as a raw string.
  - If a relative path was passed, it silently failed the allow-list and fell back to the default schema.

That made some isolated replay tests accidentally use the wrong schema and appear to succeed.

## Fixes applied

### 1. Fixed the edit-plan schema contract

Updated:

- `midform/schemas/midform_compression_edit_plan_schema.json`

Added the new fields to `required` so the schema is valid for Codex structured output.

### 2. Fixed schema path resolution

Updated:

- `server/services/gptMidformCliService.js`

`safeOutputSchemaPath()` now resolves relative schema paths against `PROJECT_ROOT` before allow-list checking.

## Token / output budget evidence

### Actual input token count

After fixing the schema, ran the corrected edit-plan prompt through:

```text
codex exec --json --output-schema midform/schemas/midform_compression_edit_plan_schema.json -
```

Observed usage:

- `input_tokens`: `30438`
- `cached_input_tokens`: `1408`
- `output_tokens`: `2593`
- `reasoning_output_tokens`: `352`

### max_output_tokens setting

Confirmed from the Codex CLI invocation path:

- `server/services/gptMidformCliService.js`
  - `buildCodexArgs()` does **not** pass any explicit `max_output_tokens` override
  - `codex exec --help` also shows no direct `--max-output-tokens` flag in the current CLI usage surface

So the effective value is:

- **unset / provider default**

## Fresh normal-path validation

Fresh `compress` now completes again on the normal Codex path.

Successful fresh run:

- `midform/test_runs/compress_20260720185513_ngYmFVO_bzM`

Key manifest:

- `midform/test_runs/compress_20260720185513_ngYmFVO_bzM/compress_state.json`

Important fields:

- `status: phase1_review_ready`
- `heatmapStatus: available`
- `editPlanSource: codex`

That confirms the fix restored the intended route instead of falling back.

Generated artifacts:

- `midform/test_runs/compress_20260720185513_ngYmFVO_bzM/source_info.json`
- `midform/test_runs/compress_20260720185513_ngYmFVO_bzM/transcript_timed.json`
- `midform/test_runs/compress_20260720185513_ngYmFVO_bzM/heatmap.json`
- `midform/test_runs/compress_20260720185513_ngYmFVO_bzM/narrative_beats.json`
- `midform/test_runs/compress_20260720185513_ngYmFVO_bzM/edit_plan.json`
- `midform/test_runs/compress_20260720185513_ngYmFVO_bzM/narrative_beats.md`

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

Note: the repo's fixture report still prints the existing `caption_balance` JSON with `"status": "failed"`, but the verify command exits successfully as currently designed.

## Final conclusion

The Codex edit-plan failure was **not opaque**.

It was caused by:

1. an **invalid structured-output schema** in `midform_compression_edit_plan_schema.json`, and
2. a **relative-schema path resolution bug** in `safeOutputSchemaPath()` that confused some isolated repro attempts.

After fixing both, a fresh `compress` run completed successfully on the **normal Codex edit-plan path**.
