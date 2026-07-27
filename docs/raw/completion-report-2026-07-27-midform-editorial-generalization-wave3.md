# Midform Editorial Generalization Wave 3 Completion Report

Date: 2026-07-27  
Mode: offline-only, cached Steve Jobs/Sculley fixture inputs

## Result

Wave 3 now connects Wave 2 selector/QC/editorial metadata to human-visible draft output.

The slot-fill prompt now includes a compact **Editorial control map** derived from `edit_plan.json`, so the writer sees the fields that matter for copy decisions:

- `scene_type`
- `editorial_pattern`
- `hook_teaser`
- `context_reset`
- `callback_dialogue`
- per-slot `editorial_role`, `dialogue_unit`, `required_support_action`, `qc_action`, `callback_relation`, and `reused_conflict_axis`

This keeps the Wave 2 metadata out of viewer subtitles while making it available to the Korean copywriter step.

## Newly written AFTER artifact set

Wave 3 run:

- `midform/test_runs/offline_wave3_20260727_steve_sculley/`

Final CapCut draft:

- `server/output/drafts/pipeline_1785165961/`

Key artifacts:

| artifact | path |
| --- | --- |
| refreshed edit plan | `midform/test_runs/offline_wave3_20260727_steve_sculley/edit_plan.json` |
| fresh offline slot fills | `midform/test_runs/offline_wave3_20260727_steve_sculley/compression_slot_fills.json` |
| regenerated slot map | `midform/test_runs/offline_wave3_20260727_steve_sculley/slot_map.json` |
| regenerated script | `midform/test_runs/offline_wave3_20260727_steve_sculley/script.json` |
| regenerated draft input | `midform/test_runs/offline_wave3_20260727_steve_sculley/draft_input.json` |
| final manifest copy | `midform/test_runs/offline_wave3_20260727_steve_sculley/edit_manifest.json` |
| final draft content copy | `midform/test_runs/offline_wave3_20260727_steve_sculley/draft_content.json` |
| before/after copy comparison | `midform/test_runs/offline_wave3_20260727_steve_sculley/wave3_copy_comparison.json` |
| human QA note | `midform/test_runs/offline_wave3_20260727_steve_sculley/wave3_human_qa.md` |
| speaker-color proof | `midform/test_runs/offline_wave3_20260727_steve_sculley/wave3_visual_color_proof.json` |

## Human-visible copy changes

Fresh Korean dialogue captions were rewritten for six visible dialogue slots while keeping narration text unchanged for offline TTS reuse:

- `slot_01` hook teaser
- `slot_03` early conflict continuation
- `slot_04` callback/ad-money payoff
- `slot_05` board-decision payoff
- `slot_06` Jobs/Sculley identity clash
- `slot_07` final truth/end-me exchange

Representative hook change:

Before:

- `탄산음료 하나로 뭘 하겠냐는 식이었지.`
- `그 광고를 죽인 건 내가 아니야, 스티브. 방송에 나간 건 전부 나 때문이야.`

After:

- `탄산음료나 팔던 사람이, 뭘 알겠냐는 거였지.`
- `난 그 광고를 죽이지 않았어, 스티브. 방송까지 간 건 나 때문이야.`

This better expresses the merged `question_answer` hook as a connected attack/rebuttal exchange instead of two isolated translated lines.

Representative callback change:

Before:

- `광고가 상영되고 나서, 이사회는 그 돈을 돌려받길 원했어.`
- `그 돈을 회수하려고 광고 시간을 팔라고 했지.`
- `마지막 광고 자리만 너무 열심히 팔지 않으면, 난 불만 없겠다고 했어.`
- `그 광고를 지킨 건 나였어.`

After:

- `상영 뒤 이사회는 광고비를 회수하라 했어.`
- `그래서 남은 광고 시간을 팔라고 했지.`
- `마지막 자리만 너무 열심히 팔지 말라 했고,`
- `그 광고를 지킨 건 나였어.`

This makes the callback payoff shorter and clearer on screen.

## Offline render / timing proof

`python midform/scripts/assemble_slot_draft_input.py ... --reuse-tts-manifest ...` produced:

```json
{"captionUnits":62,"ttsFiles":8,"reused":8,"regenerated":0}
```

`python scripts/capcut_draft.py midform/test_runs/offline_wave3_20260727_steve_sculley/draft_input.json` produced:

- `server/output/drafts/pipeline_1785165961/`
- total duration: `93.87s`
- first dialogue: `0s`
- callback dialogue: `22.095s`
- max continuous narration run: `19.096s`

The opening therefore remains: dialogue hook -> context reset -> callback payoff.

## Speaker-color proof

Artifact-level color proof is stored in:

- `midform/test_runs/offline_wave3_20260727_steve_sculley/wave3_visual_color_proof.json`

Result:

```json
{
  "checked": 43,
  "passed": 43,
  "failed": 0,
  "speaker_color_evidence": {
    "Scully": ["#37FF3D"],
    "Jobs": ["#00A9F7"]
  }
}
```

Scope note: this proves CapCut `draft_content.json` text-material fill colors, not exported-video pixels. No CapCut video export was performed in this offline pass.

## Regression coverage

Added regression coverage in `tests/dialogueSelectionTiming.test.js`:

- prompt exposes editorial metadata for hook, context reset, and callback writing;
- non-confrontation scenes preserve their `scene_type` and do not inherit callback metadata.

Focused test result:

```text
node --test tests/dialogueSelectionTiming.test.js
tests 11, pass 11, fail 0
```

Full verification was run after writing this report with `npm run verify`.

## Changed code

- `server/services/midformCompressionService.js`
  - Added `buildSlotFillEditorialGuide()` and compact dialogue-unit extraction.
  - Inserted the guide into `buildSlotFillsPrompt()`.
  - Added explicit prompt rules for `dialogue_confrontation` + `cold_open_callback`, hook support actions, callback payoff, and non-confrontation no-overfit behavior.
- `tests/dialogueSelectionTiming.test.js`
  - Added Wave 3 prompt/metadata regression and non-confrontation guard.
- `scripts/offline_wave3_steve_sculley.js`
  - Repeatable offline artifact regeneration utility for this fixture.
- `scripts/offline_wave3_steve_sculley_proof.js`
  - Repeatable proof artifact generator for final draft timing, copy QA, and material color validation.
