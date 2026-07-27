# Wave 2 Selector Offline Regeneration Report

Date: 2026-07-27  
Fixture: Steve Jobs / Sculley  
Mode: offline-only regeneration from cached artifacts

## A. Executive summary

Wave 2 now has a **newly materialized AFTER artifact set on disk**.

Regenerated artifact set:

- `midform/test_runs/offline_wave2_20260727_steve_sculley/`

Final CapCut draft generated from that set:

- `server/output/drafts/pipeline_1785163998/`

Main result:

- Compared with the older pre-Wave-2 render baseline `pipeline_1785135546`, the regenerated AFTER output keeps the major structural improvement: preserved dialogue starts at `0s` instead of `46.89s`, and callback dialogue lands at `22.095s`.
- Compared with the latest saved baseline `pipeline_1785150227`, the regenerated AFTER output is visually/timing-equivalent at final render level, but it now carries improved Wave 2 selector metadata downstream through `edit_plan.json`, `slot_map.json`, and `script.json`.
- The hook-level QC inconsistency is resolved: `dialogue_selection_scores.required_support_action` and `qc_action.action` are both `merge_adjacent_lines` for the hook slot in the regenerated `edit_plan.json`.

## B. Newly written AFTER artifact set

| artifact | path | status |
| --- | --- | --- |
| refreshed edit plan | `midform/test_runs/offline_wave2_20260727_steve_sculley/edit_plan.json` | written |
| regenerated slot map | `midform/test_runs/offline_wave2_20260727_steve_sculley/slot_map.json` | written |
| regenerated script | `midform/test_runs/offline_wave2_20260727_steve_sculley/script.json` | written |
| regenerated draft input | `midform/test_runs/offline_wave2_20260727_steve_sculley/draft_input.json` | written |
| regenerated final manifest copy | `midform/test_runs/offline_wave2_20260727_steve_sculley/edit_manifest.json` | written |
| regenerated final draft content copy | `midform/test_runs/offline_wave2_20260727_steve_sculley/draft_content.json` | written |
| generated CapCut draft | `server/output/drafts/pipeline_1785163998/` | written |
| comparison summary | `midform/test_runs/offline_wave2_20260727_steve_sculley/offline_regeneration_comparison.json` | written |
| regeneration manifest | `midform/test_runs/offline_wave2_20260727_steve_sculley/offline_regeneration_manifest.json` | written |

TTS was offline-reused:

```json
{"captionUnits": 64, "ttsFiles": 8, "reused": 8, "regenerated": 0}
```

## C. Artifact provenance table

| fixture | before artifact path | after artifact path | comparison level | notes |
| --- | --- | --- | --- | --- |
| Steve Jobs/Sculley | `server/output/drafts/pipeline_1785135546/edit_manifest.json` | `midform/test_runs/offline_wave2_20260727_steve_sculley/edit_manifest.json` | final render / edit_manifest | Older render baseline versus regenerated Wave 2 AFTER. |
| Steve Jobs/Sculley | `server/output/drafts/pipeline_1785150227/edit_manifest.json` | `midform/test_runs/offline_wave2_20260727_steve_sculley/edit_manifest.json` | final render / edit_manifest | Latest saved baseline versus regenerated Wave 2 AFTER. Shows no meaningful timing/color regression. |
| Steve Jobs/Sculley | `midform/test_runs/compress_20260727142327_luMBOVwyNzo/edit_plan.json` | `midform/test_runs/offline_wave2_20260727_steve_sculley/edit_plan.json` | edit_plan | Shows Wave 2 selector metadata materialized on disk. |
| Steve Jobs/Sculley | `midform/test_runs/run_20260727_200332_Steve_vs._Scully_Full_Scene_Steve_Jobs/slot_map.json`, `script.json` | `midform/test_runs/offline_wave2_20260727_steve_sculley/slot_map.json`, `script.json` | slot_map / script | Shows hook source text and editorial metadata propagation. |
| Steve Jobs/Sculley | `server/output/drafts/pipeline_1785150227/draft_content.json` | `midform/test_runs/offline_wave2_20260727_steve_sculley/draft_content.json` | material color | Both validate `45/45` material-colored dialogue captions. |

## D. Before/After comparison table

| field | before | after | observed impact |
| --- | --- | --- | --- |
| editorial_pattern | Older render `pipeline_1785135546` behaves narration-led; first preserved dialogue is late. Cached compression `edit_plan.json` already says `cold_open_callback` but lacks full Wave 2 fields. | Regenerated `edit_plan.json`: `editorial_pattern: "cold_open_callback"`. | Current Wave 2 code writes explicit callback metadata on disk. |
| first_dialogue_start_sec | `46.89` in `pipeline_1785135546`; `0` in latest baseline `pipeline_1785150227`. | `0` in regenerated `edit_manifest.json`. | Regenerated AFTER preserves immediate dialogue entry. |
| teaser text | Cached `edit_plan.json`: `what to do with a can of soda I didn't` + `I didn't kill the ad Steve...` | Regenerated `edit_plan.json`: `what to do with a can of soda I didn't kill the ad Steve I'm the only reason` + `I didn't kill the ad Steve...` | Hook line 1 is extended/merged; this is now reflected in regenerated `slot_map.json` and `script.json`. |
| teaser source lines | Cached latest baseline: `slot_01_L01`, `slot_01_L02`. | Regenerated AFTER: `slot_01_L01`, `slot_01_L02`. | Source ids remain the same; source text and metadata change. |
| dialogue_unit | Missing from cached baseline hook. | Regenerated hook: `dialogue_unit.relation_type: "question_answer"`, `source_line_ids: ["slot_01_L01", "slot_01_L02"]`. | Wave 2 unit metadata now propagates to edit plan and script. |
| required_support_action | Cached hook had partial old scoring without `required_support_action`. | Regenerated hook: `dialogue_selection_scores.required_support_action: "merge_adjacent_lines"`. | Selector support action is materialized. |
| qc_action | Cached hook had no aligned hook-level `qc_action`. | Regenerated hook: `qc_action.action: "merge_adjacent_lines"`, `reason: "merge_exchange"`, `source: "dialogue_slot_annotation"`. | The inconsistency is resolved for the regenerated AFTER artifact. |
| context_reset duration | Older render max narration run before first dialogue: `46.89s`; latest baseline context reset: `19.096s`. | Regenerated final manifest context reset: `2.999s-22.095s`; max narration run `19.096s`. | First 30 seconds remain teaser → context reset → callback. |
| callback start sec | `54.831s` in old render; `22.085s` in latest baseline. | `22.095s` in regenerated final manifest. | Callback remains inside the 20-35s target window. |
| callback relation | Cached edit plan: `relation_to_teaser: "same_line_callback"`; callback slot lacked richer downstream metadata. | Regenerated top-level callback: `same_line_callback`; regenerated callback slot metadata includes `callback_relation: "same_conflict_axis"` and `reused_conflict_axis`. | Callback linkage is richer downstream, though top-level and slot-level labels differ in granularity. |
| speaker color status | Old render: `colored_segments: 0`; latest baseline: `45/45` material color validation passed. | Regenerated AFTER: `colored_segments: 45`, `removed_effect_refs: 135`, material validation `45/45` passed. | Color state remains correct in regenerated draft. |

## E. First-30-seconds timeline comparison

### Old render baseline — `server/output/drafts/pipeline_1785135546/edit_manifest.json`

- `0.000-4.624s`: recap — “세상을 바꾼 발표 직전…”
- `4.624-21.055s`: recap — Jobs/NeXT/Sculley setup
- `21.055-36.754s`: recap — argument and 1984 ad summarized
- First preserved dialogue appears at `46.89s`

Assessment: first 30 seconds are narration-only. The conflict is explained, but the original dialogue hook is delayed too long.

### Latest saved baseline — `server/output/drafts/pipeline_1785150227/edit_manifest.json`

- `0.000-2.989s`: Scully dialogue teaser
- `2.989-22.085s`: context reset narration
- `22.085s+`: callback dialogue begins

Assessment: already has the desired opening structure.

### Regenerated Wave 2 AFTER — `midform/test_runs/offline_wave2_20260727_steve_sculley/edit_manifest.json`

- `0.000-2.999s`: Scully dialogue teaser, `#37FF3D`
- `2.999-22.095s`: context reset narration
- `22.095s+`: callback dialogue begins, Scully `#37FF3D`

Assessment: final render timing is effectively equivalent to the latest saved baseline, while edit-plan/script metadata is richer and QC-aligned.

## F. Selector outcome comparison

### Cached compression baseline

Path: `midform/test_runs/compress_20260727142327_luMBOVwyNzo/edit_plan.json`

Hook slot:

```json
{
  "slot_id": "slot_01",
  "beat_id": "B003",
  "decision": "KEEP_DIALOGUE",
  "dialogue_focus_lines": [
    "what to do with a can of soda I didn't",
    "I didn't kill the ad Steve I'm the only reason that made it on the air"
  ],
  "dialogue_selection_scores": {
    "teaser_hook_strength": 5,
    "callback_payoff_strength": 5,
    "curiosity_gap": 5,
    "replay_value": 5,
    "context_dependency": "medium"
  },
  "context_strategy": "bridge_narration"
}
```

### Regenerated Wave 2 AFTER

Path: `midform/test_runs/offline_wave2_20260727_steve_sculley/edit_plan.json`

Hook slot:

```json
{
  "slot_id": "slot_01",
  "beat_id": "B003",
  "decision": "KEEP_DIALOGUE",
  "dialogue_focus_lines": [
    "what to do with a can of soda I didn't kill the ad Steve I'm the only reason",
    "I didn't kill the ad Steve I'm the only reason that made it on the air"
  ],
  "dialogue_unit": {
    "unit_id": "exchange_001",
    "relation_type": "question_answer",
    "source_line_ids": ["slot_01_L01", "slot_01_L02"],
    "start_sec": 161.07,
    "end_sec": 164.069
  },
  "dialogue_selection_scores": {
    "required_support_action": "merge_adjacent_lines",
    "standalone_comprehension": 3,
    "pronoun_dependency_risk": true,
    "accusation_response_balance": 3,
    "total": 193.8
  },
  "qc_action": {
    "action": "merge_adjacent_lines",
    "reason": "merge_exchange",
    "source": "dialogue_slot_annotation"
  },
  "context_strategy": "merge_exchange"
}
```

Observed selector impact:

- The selected beat did **not** change: still `B003`.
- The selected source ids did **not** change: still `slot_01_L01`, `slot_01_L02`.
- The selected unit changed semantically from a loosely reported two-line hook to an explicit `question_answer` exchange with `merge_adjacent_lines` support.
- Hook-level `qc_action` now matches the support action.

## G. Slot map / script propagation

### Latest saved baseline script

Path: `midform/test_runs/run_20260727_200332_Steve_vs._Scully_Full_Scene_Steve_Jobs/script.json`

First hook segment:

```json
{
  "segment_id": "slot_01_L01",
  "dialogue_original": "what to do with a can of soda I didn't",
  "speaker": "Scully"
}
```

### Regenerated Wave 2 AFTER script

Path: `midform/test_runs/offline_wave2_20260727_steve_sculley/script.json`

First hook segment:

```json
{
  "segment_id": "slot_01_L01",
  "dialogue_original": "what to do with a can of soda I didn't kill the ad Steve I'm the only reason",
  "speaker": "Scully",
  "editorial_role": "hook_teaser",
  "dialogue_unit": {
    "relation_type": "question_answer",
    "source_line_ids": ["slot_01_L01", "slot_01_L02"]
  }
}
```

Observed propagation:

- `slot_map.json` and `script.json` now carry the extended hook text.
- `script.json` now carries `editorial_role` and `dialogue_unit` metadata for the hook and callback segments.
- Final Korean caption text did not materially change because cached `compression_slot_fills.json` was reused; this is expected in an offline pass that does not regenerate slot fills through an LLM.

## H. Final material color validation

Regenerated AFTER final draft:

- Draft: `server/output/drafts/pipeline_1785163998/`
- Manifest copy: `midform/test_runs/offline_wave2_20260727_steve_sculley/edit_manifest.json`
- Draft content copy: `midform/test_runs/offline_wave2_20260727_steve_sculley/draft_content.json`

Material validation result:

```json
{
  "checked": 45,
  "passed": 45,
  "failed": 0
}
```

Manifest/render evidence:

- `caption_track_template_rebuild.colored_segments: 45`
- `caption_track_template_rebuild.removed_effect_refs: 135`
- Scully color evidence: `#37FF3D`
- Jobs color evidence: `#00A9F7`

Interpretation:

- Offline artifacts prove manifest-level and `draft_content.json` material-level color correctness.
- They still do not prove exported video pixels; that would require a rendered video or screenshot from CapCut.

## I. Evidence-backed conclusions

1. A real offline-regenerated AFTER artifact set now exists on disk.  
   Evidence: `midform/test_runs/offline_wave2_20260727_steve_sculley/` contains `edit_plan.json`, `slot_map.json`, `script.json`, `draft_input.json`, `edit_manifest.json`, and `draft_content.json`.

2. The old narration-led opening problem is fixed in the regenerated AFTER render.  
   Evidence: old `pipeline_1785135546` first dialogue `46.89s`; regenerated AFTER first dialogue `0s`.

3. Compared with the latest saved baseline, Wave 2 does not materially change final first-30-second timing.  
   Evidence: latest baseline callback `22.085s`; regenerated AFTER callback `22.095s`.

4. Wave 2 does change downstream edit-plan and script artifacts.  
   Evidence: regenerated `script.json` first hook line changes from `what to do with a can of soda I didn't` to `what to do with a can of soda I didn't kill the ad Steve I'm the only reason`, and carries `dialogue_unit.relation_type: "question_answer"`.

5. The QC-action inconsistency is resolved in the regenerated artifact.  
   Evidence: regenerated hook has both `dialogue_selection_scores.required_support_action: "merge_adjacent_lines"` and `qc_action.action: "merge_adjacent_lines"`.

6. Final material color state remains correct after regeneration.  
   Evidence: regenerated material validation `checked: 45`, `passed: 45`, `failed: 0`.

## J. Remaining gaps

- This offline pass reused cached `compression_slot_fills.json`, so Korean slot-fill copy did not go through a fresh LLM regeneration. Therefore, text-level Korean hook copy may remain effectively unchanged even when source dialogue metadata changes.
- The selected beat/source ids did not change on this fixture. Wave 2 changed unit metadata and source text expansion, not the chosen beat.
- Full visual correctness still cannot be proven without opening/exporting the CapCut draft or inspecting rendered pixels.
