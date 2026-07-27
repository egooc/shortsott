# Wave 2 Selector Integration Offline Evidence Report

Date: 2026-07-27  
Fixture: Steve Jobs / Sculley  
Scope: cached/local artifacts only, no network/OAuth dependency

## A. Executive summary

Wave 2 selector integration is **not yet proven as a full regenerated final-render artifact**. No saved post-Wave-2 draft exists offline.

What is proven offline:

- Cached final drafts show a major same-fixture improvement from older narration-led opening to latest cold-open dialogue structure.
  - `pipeline_1785135546`: first dialogue at `46.89s`
  - `pipeline_1785150227`: first dialogue at `0s`, callback at `22.085s`
- Reapplying current Wave 2 selector code in-memory to the cached Steve Jobs/Sculley compression artifacts changes the **edit-plan-level hook focus and metadata**, but not the selected beat.
  - same beat: `B003`
  - same source ids: `slot_01_L01`, `slot_01_L02`
  - hook line text becomes a more merged exchange-like unit
  - `dialogue_unit` and `required_support_action: "merge_adjacent_lines"` appear
- Final speaker-color proof is strong for `pipeline_1785150227`: `45/45` colored dialogue captions match material-level `draft_content.json` fill state.

## B. Artifact provenance table

| fixture | before artifact path | after artifact path | comparison level | notes |
| --- | --- | --- | --- | --- |
| Steve Jobs/Sculley | `server/output/drafts/pipeline_1785135546/edit_manifest.json` | `server/output/drafts/pipeline_1785150227/edit_manifest.json` | final render / edit_manifest | Best full offline before/after pair. Shows narration-led opening to dialogue-at-0s callback structure. |
| Steve Jobs/Sculley | `midform/test_runs/run_20260727_155842_Steve_vs._Scully_Full_Scene_Steve_Jobs/slot_map.json`, `script.json` | `midform/test_runs/run_20260727_200332_Steve_vs._Scully_Full_Scene_Steve_Jobs/slot_map.json`, `script.json` | slot_map / script | Shows original dialogue source-line changes upstream of final draft. |
| Steve Jobs/Sculley | `midform/test_runs/compress_20260727142327_luMBOVwyNzo/edit_plan.json` | current in-memory `finalizeEditPlan()` applied to same `edit_plan.json`, `narrative_beats.json`, `transcript_timed.json` | reconstructed edit_plan | Only available offline proof specific to current Wave 2 selector code. No file was written. |
| Steve Jobs/Sculley | `server/output/drafts/pipeline_1785135546/draft_content.json` | `server/output/drafts/pipeline_1785150227/draft_content.json` | material color | Before has no colored dialogue captions to validate; after validates material-level colors. |

## C. Before/After comparison table

| field | before | after | observed impact |
| --- | --- | --- | --- |
| editorial_pattern | Final render behaves narration-led; first 4 active slots are recap in `pipeline_1785135546`. | `edit_plan.json` has `editorial_pattern: "cold_open_callback"`; final render `pipeline_1785150227` starts with dialogue. | Opening structure changes from narration-first to cold-open teaser + context reset + callback. |
| first_dialogue_start_sec | `46.89` in `pipeline_1785135546/edit_manifest.json` | `0` in `pipeline_1785150227/edit_manifest.json` | Preserved dialogue enters immediately instead of after about 47s. |
| teaser text | No dialogue teaser; first segment is recap: “세상을 바꾼 발표 직전…” | `slot_01_L01/L02`: “what to do with a can of soda I didn't” + “I didn't kill the ad Steve…” | Latest artifact opens with Scully’s ad rebuttal rather than narration. |
| teaser source lines | None in first 30s; first dialogue source is `slot_05_L01/L02`. | `slot_01_L01`, `slot_01_L02` | Source-line position moves from late payoff/body to first slot. |
| dialogue_unit | Not present in before final render manifest. | In current Wave 2 in-memory edit plan: `dialogue_unit.relation_type: "question_answer"`, ids `slot_01_L01/L02`. | Wave 2 adds unit metadata at edit-plan level; not yet saved downstream. |
| required_support_action | Not present in before render artifacts. | Current Wave 2 in-memory `dialogue_selection_scores.required_support_action: "merge_adjacent_lines"`. | Selector scoring recognizes the teaser needs merged-line support. |
| qc_action | Before render has no selector QC action. | Current Wave 2 in-memory hook has inconsistent evidence: `dialogue_selection_scores.required_support_action: "merge_adjacent_lines"` but final hook `qc_action.action: "none"`. Callback slot has `qc_action.action: "merge_adjacent_lines"`. | QC visibly affects callback/merged slots, but hook-level `qc_action` is not fully aligned with selector score offline. |
| context_reset duration | Before max narration run before dialogue: `46.89s`. | Latest final render context reset: `2.989s-22.085s` = `19.096s`; current in-memory edit plan says `18.801s`. | Context reset is short enough to preserve callback timing. |
| callback start sec | `54.831s` as second dialogue block in old final render. | `22.085s` in latest final render; current in-memory edit plan `20.86s`. | Callback lands inside target 20-35s window. |
| callback relation | Not represented in before render metadata. | Cached edit plan: `relation_to_teaser: "same_line_callback"`; current in-memory: `callback_relation: "same_line_callback"`. | Callback is explicitly tied to the teaser conflict axis. |
| speaker color status | `pipeline_1785135546`: `colored_segments: 0`, Jobs/Sculley color evidence empty. | `pipeline_1785150227`: Scully `#37FF3D`, Jobs `#00A9F7`; material validation `45/45` passed. | Latest render has both manifest and material-level color evidence. |

## D. First-30-seconds timeline comparison

### BEFORE — `pipeline_1785135546/edit_manifest.json`

- `0.000-4.624s`: recap — “세상을 바꾼 발표 직전…”
- `4.624-21.055s`: recap — Jobs/NeXT/Sculley setup
- `21.055-36.754s`: recap — argument and 1984 ad summarized
- First preserved dialogue does **not** appear until `46.89s`
- First dialogue: `slot_05_L01`, Sculley, “그럴 순 없어.”

Result: first 30 seconds are narration-only. The viewer receives context, but no original-audio hook or callback rhythm.

### AFTER — `pipeline_1785150227/edit_manifest.json`

- `0.000-2.989s`: dialogue teaser — Scully, `#37FF3D`
  - “탄산음료 하나로…”
  - “그 광고를 죽인 건 내가 아니야, 스티브…”
- `2.989-22.085s`: context reset recap
  - Jobs was ousted from Apple
  - meets former CEO Sculley before NeXT
  - unresolved blame around firing and the 1984 ad
- `22.085s+`: callback dialogue
  - ad/board-money explanation begins
  - Scully remains speaker, `#37FF3D`

Result: first 30 seconds follow teaser → context reset → callback.

## E. Evidence-backed conclusions

1. The latest saved final render clearly improves opening timing versus the older saved render.  
   Evidence: `pipeline_1785135546/edit_manifest.json` first dialogue `46.89s`; `pipeline_1785150227/edit_manifest.json` first dialogue `0s`.

2. The latest saved final render changes the opening from narration-only to preserved dialogue.  
   Evidence: `pipeline_1785135546` first segment is recap `slot_01`; `pipeline_1785150227` first segment is `slot_01_L01`, `segment_type: "dialogue_quote"`.

3. The latest saved render has a real callback structure.  
   Evidence: `pipeline_1785150227` second dialogue block starts at `22.085s`; cached `edit_plan.json` has `callback_dialogue.enabled: true` and `relation_to_teaser: "same_line_callback"`.

4. Current Wave 2 selector logic changes the cached edit plan when reapplied offline, but only at edit-plan level.  
   Evidence: in-memory `finalizeEditPlan()` adds hook `dialogue_unit.relation_type: "question_answer"` and `dialogue_selection_scores.required_support_action: "merge_adjacent_lines"` for `slot_01`.

5. The real fixture does **not** prove a full single-line → micro-exchange final-render change.  
   Evidence: cached latest final render already uses two teaser source lines `slot_01_L01/L02`; current Wave 2 in-memory result keeps the same source ids, though it enriches/merges the text and metadata.

6. QC action is not fully proven as an output-changing hook mechanism on this real fixture.  
   Evidence: current in-memory hook has `required_support_action: "merge_adjacent_lines"` but hook `qc_action.action: "none"`; callback slot does show `qc_action.action: "merge_adjacent_lines"`.

7. Speaker color is proven offline for the latest final draft at material level.  
   Evidence: `pipeline_1785150227/edit_manifest.json` has Scully `#37FF3D`, Jobs `#00A9F7`; `draft_content.json` validation checked `45` colored dialogue captions and passed `45`, with `useLetterColor: true` and `use_effect_default_color: false`.

## F. Remaining gaps

- No saved post-Wave-2 regenerated final draft exists offline. The Wave 2-specific evidence is reconstructed edit-plan-level only.
- The Steve Jobs/Sculley cached fixture does not prove a dramatic real-artifact unit switch from single-line to micro-exchange; it already had a two-line teaser in the latest saved render.
- Hook-level `qc_action` still cannot be claimed as fully output-changing from offline evidence because `required_support_action` and final hook `qc_action` disagree in the current in-memory result.
- Offline artifacts prove CapCut draft material color state, but not the human-visible exported video pixels. A real CapCut render/export screenshot or video inspection would be needed later for absolute visual proof.

## G. Commands/evidence extraction used

All analysis was local-only. The key derived values came from:

- `tests/artifactQaHelpers.js`
  - `activeSegmentsFromManifest()`
  - `firstDialogueStartSec()`
  - `callbackDialogueStartSec()`
  - `maxContinuousNarrationRunSec()`
  - `colorEvidenceBySpeaker()`
  - `validateManifestMaterialColors()`
- cached artifacts under:
  - `midform/test_runs/compress_20260727142327_luMBOVwyNzo/`
  - `midform/test_runs/run_20260727_155842_Steve_vs._Scully_Full_Scene_Steve_Jobs/`
  - `midform/test_runs/run_20260727_200332_Steve_vs._Scully_Full_Scene_Steve_Jobs/`
  - `server/output/drafts/pipeline_1785135546/`
  - `server/output/drafts/pipeline_1785150227/`
