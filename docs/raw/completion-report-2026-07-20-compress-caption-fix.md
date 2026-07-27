# Completion Report — Compress Caption Fix

Date: 2026-07-20

## Request handled

Applied the three caption-review corrections in the compression flow before Phase 2:

1. Separate cold-open teaser visual source from the story/dialogue source.
2. Trim `KEEP_DIALOGUE` sections to key-dialogue-focused windows instead of whole-beat dialogue.
3. Make cold-open vs body-peak replay behavior explicit in the edit plan.

## Files changed

- `server/services/midformCompressionService.js`
- `midform/schemas/midform_compression_edit_plan_schema.json`
- `scripts/midform.js`

## What changed

### 1. Cold-open source separation

- Cold open is now allowed to be narration-led even when the triggering story beat comes from a heatmap peak.
- A separate teaser visual source is recorded in the edit plan.
- For the refreshed Twilight compression run:
  - `cold_open_selection.beat_id`: `beat_05`
  - `cold_open_selection.teaser_visual_beat_id`: `beat_04`
  - `cold_open_selection.teaser_visual_mode`: `mute_visual_teaser`
  - `teaser_visual_start_sec`: `230.975`
  - `teaser_visual_end_sec`: `233.975`

### 2. Key-dialogue trimming for `KEEP_DIALOGUE`

- Added dialogue-focus extraction based on `key_dialogue` matches.
- `KEEP_DIALOGUE` slots now store:
  - `dialogue_focus_source`
  - `dialogue_focus_quotes`
  - `dialogue_focus_lines`
- The visible review/report layer now shows cleaned key lines instead of noisy cumulative VTT carry-over.

### 3. Cold-open vs body-peak replay distinction

- Cold open remains teaser-short.
- Body peak explicitly references the replay relationship:
  - `replay_of_slot_id: "slot_01"`
  - `replay_mode: "full_context_replay"`

## Refreshed artifacts

Used the existing compression run and refreshed it under the new rules:

- Run directory:
  - `midform/test_runs/compress_20260720113615_ngYmFVO_bzM`
- Refreshed plan:
  - `midform/test_runs/compress_20260720113615_ngYmFVO_bzM/edit_plan.json`
- Refreshed review markdown:
  - `midform/test_runs/compress_20260720113615_ngYmFVO_bzM/narrative_beats.md`
- Regenerated slot fills:
  - `midform/test_runs/compress_20260720113615_ngYmFVO_bzM/compression_slot_fills.json`

## Updated output summary

### Cold open

- `slot_01` changed from `KEEP_DIALOGUE` to `NARRATE`.
- It now uses narration over a separated teaser visual instead of inheriting unrelated 326s chatter.

### Dialogue focus windows

- `slot_04` trimmed to `143.59–170.24`
- `slot_05` trimmed to `187.509–239.849`
- `slot_07` trimmed to `336.31–399.289`
- `slot_09` trimmed to `501.11–588.41`

## Remaining issue

The structural caption problems are fixed, but the refreshed edit plan is still too long for the 180-second target.

- `estimated_total_sec`: `272.269`

Main long sections still remaining:

- `slot_05`: `52.34s`
- `slot_07`: `62.979s`
- `slot_09`: `87.3s`

## Verification

Executed:

```bash
npm run verify
```

Verification status:

- `check:encoding` ✅
- `verify:js` ✅
- `verify:py` ✅
- `verify:fixture` ✅ command exit

Note: the fixture report still prints the existing `caption_balance` JSON with `"status": "failed"`, but the repo's current verify command exits successfully as designed.

## Next recommended step

Before Phase 2, run a second compression pass that further reduces runtime by converting one or more long `KEEP_DIALOGUE` sections into shorter quote windows or narration.
