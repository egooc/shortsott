# Current State Audit — Midform Recap Pipeline

Date: 2026-07-27  
Scope: current repository behavior and current Steve Jobs/Sculley artifacts.  
No fixes are proposed as implementation steps here; this is an evidence-based structural audit.

## A. Executive summary

The current midform recap pipeline is a two-layer system:

1. **Compression/editorial layer** in `server/services/midformCompressionService.js` creates `narrative_beats.json`, `edit_plan.json`, `compression_slot_fills.json`, `slot_qc_report.json`, and `compression_manifest.json`.
2. **Bootstrap/render layer** in `server/services/midformBootstrapAdapterService.js`, `server/services/midformPipelineService.js`, `server/services/capcutService.js`, and `scripts/capcut_draft.py` converts compression artifacts into `slot_map.json`, `script.json`, `draft_input.json`, `edit_manifest.json`, SRT, and a CapCut draft ZIP.

As of the current working tree, the system **does explicitly support** `cold_open_callback` for dialogue-driven confrontation scenes. This is not just an inferred pattern: `edit_plan.json` now contains `editorial_pattern: "cold_open_callback"`, `hook_teaser`, `context_reset`, `callback_dialogue`, and `dialogue_timing_qc` keys. The current Steve Jobs/Sculley fixture opens with preserved dialogue at `0s`, uses narration reset, and returns to callback dialogue at `22.085s` in the final `edit_manifest.json`.

The current `KEEP_DIALOGUE` cut unit is **not a full beat at render time**. Planning is beat/slot-based, but bootstrap conversion splits each `KEEP_DIALOGUE` slot into **one dialogue segment per resolved source line** using `edit_plan.timeline[].dialogue_line_windows[]`. CapCut then may split a single Korean caption further into caption units for display, which means final manifest rows are sometimes smaller than source dialogue lines.

Speaker color handling is metadata-driven and mostly deterministic: speaker names come from `compression_slot_fills.json` (`speaker` / `speakers`), are copied into bootstrap `script.json`, mapped through `midform/config/caption_colors.json`, recorded in `edit_manifest.json`, and applied during template subtitle rebuild in `scripts/capcut_draft.py`. However, **manifest color correctness alone does not fully guarantee rendered visual color**, because the actual render depends on nested CapCut text material fill state, `use_effect_default_color`, and effect-layer removal. The current latest draft shows `caption_track_template_rebuild.colored_segments: 45` and `removed_effect_refs: 135`, which is strong evidence that the renderer attempted to enforce colors, but the final authority is the generated `draft_content.json` material state or visual inspection in CapCut.

## B. Stage-by-stage pipeline map

### 1. Source, transcript, heatmap, narrative beats

Primary code:

- `server/services/midformCompressionService.js`
  - `runCompression()` — line ~2652
  - `buildBeatsPrompt()` — line ~2249
  - `validateBeats()` / `normalizeBeatAnchors()` — line ~2441 and ~896

Behavior:

- `runCompression()` creates or reuses source metadata, transcript, heatmap, narrative beats, and edit plan artifacts.
- `buildBeatsPrompt()` asks for story-sized beats, `key_dialogue`, `anchor_dialogue`, `dramatic_weight`, `dialogue_quality`, and `hook_potential`.
- `validateBeats()` enforces beat IDs, transcript-range validity, and anchor dialogue count.
- `normalizeBeatAnchors()` can select fallback anchors from `key_dialogue` using `scoreAnchorLine()`.

Real artifact evidence:

- `midform/test_runs/compress_20260727142327_luMBOVwyNzo/narrative_beats.json`
  - `B001`: early accusation axis, anchors `why do people think I fired you`, `you tried to kill it`, hook `4`, quality `high`.
  - `B003`: truth reversal, anchor `I didn't kill the ad Steve I'm the only reason that made it on the air`, hook `5`, quality `high`.
  - `B004`: board decision, anchor `they believe you're no longer necessary to this company`, hook `5`, quality `high`.

### 2. Edit-plan generation and local fallback

Primary code:

- `server/services/midformCompressionService.js`
  - `buildEditPlanPrompt()` — line ~2275
  - `buildFallbackEditPlan()` — line ~737
  - `defaultDecisionForBeat()` — line ~724
  - `selectColdOpenBeat()` — line ~591
  - `finalizeEditPlan()` — line ~1933

Behavior:

- LLM path: `buildEditPlanPrompt()` asks for a cold open, bridge, story-order body, body peak, and payoff.
- Fallback path: `buildFallbackEditPlan()` sorts beats chronologically, selects a cold-open beat, then emits slots with roles such as `cold_open`, `bridge`, `body`, `body_peak`, and `payoff`.
- `defaultDecisionForBeat()` decides:
  - `bridge` → always `NARRATE`.
  - `cold_open` → `KEEP_DIALOGUE` only if `coldOpenDialogueFocusForBeat()` succeeds.
  - `body_peak` / `payoff` with high dialogue quality → `KEEP_DIALOGUE`.
  - high-quality hook beats with short enough focus duration → `KEEP_DIALOGUE`.
  - low hook/weight → `DROP`; otherwise `NARRATE`.

Current explicit cold-open/callback logic:

- `buildColdOpenCallbackMetadata()` — line ~1794
- `bestColdOpenCallbackBeat()` — line ~1832
- `prepareColdOpenCallbackTimeline()` — line ~1840
- `evaluateDialogueTimingQc()` — line ~264

Current behavior:

- For dialogue-driven confrontation scenes, `prepareColdOpenCallbackTimeline()` can rewrite the first slot into a `KEEP_DIALOGUE` hook teaser from the best hook beat, then mark a later slot from the same beat as callback/body peak.
- `buildColdOpenCallbackMetadata()` emits:
  - `editorial_pattern`
  - `hook_teaser`
  - `context_reset`
  - `callback_dialogue`
- `evaluateDialogueTimingQc()` treats `cold_open_callback` differently from old “first dialogue in 20-30s” behavior:
  - hook teaser must be preserved dialogue within first 5 seconds.
  - callback dialogue must start between 20 and 35 seconds.
  - max narration run threshold remains 25 seconds.

### 3. Dialogue focus, context dependency, and QC

Primary code:

- `server/services/midformCompressionService.js`
  - `collectDialogueFocus()` — around line ~884 by call sites
  - `resolveDialogueLineWindows()` — around line ~1386 by comment and callers
  - `enrichDialogueFocusForCoherence()` — around line ~1209
  - `limitDialogueFocusLines()` — around line ~1098 by call sites
  - `buildSlotQcReport()` — line ~216

Behavior:

- Selection begins as beat/slot-based, then narrows to dialogue focus lines.
- `resolveDialogueLineWindows()` resolves each focus line to source coordinates; these are stored in `dialogue_line_windows`.
- `buildSlotQcReport()` records mode, source line IDs, time ranges, speaker, translation mode, semantic risk, pronoun ambiguity risk, standalone comprehension, boundary continuity, and applied fix.
- Context/pronoun checks exist through fields such as:
  - `requires_context`
  - `context_strategy`
  - `semantic_risk`
  - `pronoun_risk`
  - `standalone_score`
  - `boundary_score`
  - `coherence_checks`

### 4. Compress-apply / slot fill generation

Primary code:

- `server/services/midformCompressionService.js`
  - `runCompressionApply()` — line ~2724
  - `buildSlotFillsPrompt()` — line ~2325
  - `validateSlotFillsDialogueCaptions()` — line ~2433
  - `recalculateNarrationDurations()` — line ~1712

Behavior:

- `runCompressionApply()` reads `narrative_beats.json`, `edit_plan.json`, and `transcript_timed.json`, finalizes the edit plan, asks for Korean slot fills, validates dialogue captions, writes `compression_slot_fills.json`, recalculates narration durations, and writes `slot_qc_report.json`.
- `buildSlotFillsPrompt()` enforces that `KEEP_DIALOGUE` slots use `caption_kr_dialogue` and `translation_mode: "faithful_dialogue"`.
- `validateSlotFillsDialogueCaptions()` requires `caption_kr_dialogue.length === dialogue_focus_lines.length` for `KEEP_DIALOGUE` slots.
- `recalculateNarrationDurations()` uses actual Korean narration text length to update NARRATE duration estimates after slot fills exist.

### 5. Bootstrap conversion

Primary code:

- `server/services/midformBootstrapAdapterService.js`
  - top-level comments lines 1-8: compression artifacts are converted to transcript / slot map / script.
  - `buildBootstrapTranscript()` — line ~86
  - `buildBootstrapSlotMapAndScript()` — line ~172
  - `runBootstrapFromCompression()` — line ~617 by comments/call sites

Behavior:

- `buildBootstrapTranscript()` creates one utterance per `KEEP_DIALOGUE` line from `edit_plan.timeline[].dialogue_line_windows[]`.
- Original VTT cues that overlap dialogue windows are excluded to avoid reserved-range gate failures.
- `buildBootstrapSlotMapAndScript()` builds `slot_map.json` and `script.json` together from the same coordinates.
- Important behavior: `script.json` intentionally gets **no top-level `slot_map` key**, keeping CapCut `slot_map_mode` false and avoiding incompatible monotonicity gates.
- For `KEEP_DIALOGUE`, bootstrap emits **one slot and one script segment per source line**:
  - segment IDs like `slot_01_L01`, `slot_01_L02`.
  - `segment_type: "dialogue_quote"`.
  - `tts_enabled: false`.
  - `speaker` from `compression_slot_fills.json` `speakers[]` / `speaker`.
- For `NARRATE`, bootstrap emits recap segments with explicit non-overlapping b-roll windows.

### 6. Main pipeline and draft input

Primary code:

- `server/services/midformPipelineService.js`
  - step definitions lines 40-50
  - stores `source_transcript.json`, `slot_map.json`, `script.json`, `draft_input.json`, TTS, and CapCut artifacts.
- `server/services/gptMidformCliService.js`
  - `normalizeSlotFillsToScript()` — line ~1577 for the non-bootstrap slot-map path.

Behavior:

- The active bootstrap path seeds the normal pipeline with prebuilt transcript, slot map, and script.
- `dialogue_quote` segments do not generate TTS; they retain original source audio and subtitle-only captions.
- NARRATE segments generate TTS and caption units.

### 7. CapCut draft generation and manifest

Primary code:

- `scripts/capcut_draft.py`
  - `caption_color_for_speaker()` — line ~159
  - caption manifest/edit manifest entries — line ~9748 onward
  - `rebuild_midform_caption_track_from_template()` — line ~2648
  - final template rebuild call — line ~10798

Behavior:

- For each caption unit or subtitle-only dialogue caption, CapCut code records `speaker` and `caption_color` in `caption_timeline_entries`, `caption_manifest_entries`, and `edit_manifest_entries`.
- If a CapCut template is loaded, subtitles are rebuilt from `TEMPLATE_SUBTITLE` by cloning its text material/segment.
- `caption_color` is applied to cloned text material via `apply_text_material_fill_color()`.
- If color is applied, the script removes effect references that can override colors using `remove_text_effect_layers_for_colored_caption()`.

## C. Steve Jobs/Sculley fixture trace

Fixture paths:

- Compression run: `midform/test_runs/compress_20260727142327_luMBOVwyNzo/`
- Latest rendered pipeline run: `midform/test_runs/run_20260727_200332_Steve_vs._Scully_Full_Scene_Steve_Jobs/`
- Latest draft: `server/output/drafts/pipeline_1785150227/`
- Latest ZIP: `server/output/drafts/pipeline_1785150227.zip`

### Source transcript / beats

Relevant source beats from `narrative_beats.json`:

| Beat | Source range | Role in current plan | Evidence |
| --- | ---: | --- | --- |
| `B001` | `1.91-61.99` | context reset source / early conflict setup | anchors: `why do people think I fired you`, `you tried to kill it`; hook `4`; quality `high` |
| `B003` | `161.08-239.869` | hook teaser and callback conflict axis | anchor: `I didn't kill the ad Steve I'm the only reason that made it on the air`; hook `5`; quality `high` |
| `B004` | `241.67-345.909` | payoff dialogue | anchor: `they believe you're no longer necessary to this company`; hook `5`; quality `high` |
| `B005` | `345.919-420.11` | body dialogue | Jobs/Scully identity clash |
| `B006` | `420.12-515.719` | body/closing material | board unanimity / truth / ending exchange |

### Edit plan

`midform/test_runs/compress_20260727142327_luMBOVwyNzo/edit_plan.json` currently contains:

```json
{
  "editorial_pattern": "cold_open_callback",
  "hook_teaser": {
    "enabled": true,
    "source_lines": [
      "what to do with a can of soda I didn't",
      "I didn't kill the ad Steve I'm the only reason that made it on the air"
    ],
    "time_range": [161.08, 163.129],
    "hook_score": 151.5,
    "context_dependency": "medium"
  },
  "context_reset": {
    "enabled": true,
    "target_duration_sec": 18.022
  },
  "callback_dialogue": {
    "enabled": true,
    "source_lines": [
      "screened it the board wanted that money",
      "the board wanted that money back and they asked me to sell off the spots",
      "if he didn't try very hard to sell the last spot I wouldn't be unhappy",
      "I was the only thing protecting it"
    ],
    "relation_to_teaser": "same_line_callback"
  }
}
```

`dialogue_timing_qc` for that plan reports:

- `status: "passed"`
- `first_dialogue_start_sec: 0`
- `callback_dialogue_start_sec: 20.071`
- `max_narration_run_sec: 18.022`
- no warnings or violations.

### Slot plan to script

Bootstrap output in `run_20260727_200332.../slot_map.json` and `script.json` shows:

- `slot_01_L01` and `slot_01_L02` are per-line dialogue teaser segments from B003.
- `slot_02` is a recap/NARRATE context reset with source b-roll `00:00:03.470-00:00:33.470`.
- `slot_04_L01` to `slot_04_L04` are callback dialogue segments from B003.
- `script.json` has `segment_count: 20`.

The first script segments are:

| Segment | Type | Runtime purpose | Source range | Speaker |
| --- | --- | --- | --- | --- |
| `slot_01_L01` | `dialogue_quote` | hook teaser | `00:02:41.080-00:02:42.869` | Scully |
| `slot_01_L02` | `dialogue_quote` | hook teaser | `00:02:42.869-00:02:44.069` | Scully |
| `slot_02` | `recap` | context reset | `00:00:03.470-00:00:33.470` b-roll | none |
| `slot_04_L01...L04` | `dialogue_quote` | callback dialogue | `00:03:08.350+` | Scully |

### Final edit manifest

`server/output/drafts/pipeline_1785150227/edit_manifest.json` shows:

- `duration: 93.859999`
- `caption_units_count: 64`
- `caption_track_template_rebuild.applied: true`
- `caption_track_template_rebuild.colored_segments: 45`
- `caption_track_template_rebuild.removed_effect_refs: 135`

Opening sequence in final runtime:

| Runtime | Segment | Type | Text | Speaker | Color |
| ---: | --- | --- | --- | --- | --- |
| `0.000-0.8945` | `slot_01_L01_cap_001` | dialogue | `탄산음료 하나로` | Scully | `#37FF3D` |
| `0.8945-1.789` | `slot_01_L01_cap_002` | dialogue | `뭘 하겠냐는 식이었지.` | Scully | `#37FF3D` |
| `1.789-2.989` | `slot_01_L02_*` | dialogue | `그 광고를 죽인 건 내가 아니야...` | Scully | `#37FF3D` |
| `2.989-22.085` | `slot_02_sent_*` | recap | Apple exit / NeXT / unresolved blame context | none | none |
| `22.085+` | `slot_04_L01_*` | dialogue | callback to ad/board-money explanation | Scully | `#37FF3D` |

Therefore, the latest fixture follows **cold open teaser + context reset + callback dialogue**, not narration-only opening and not purely chronological progression.

## D. Opening structure audit

| Pattern | Supported now? | Evidence |
| --- | --- | --- |
| Narration-only opening | Yes, fallback/older behavior still exists | `defaultDecisionForBeat()` can return `NARRATE` for `cold_open`; `finalizeEditPlan()` has NARRATE cold-open visual teaser branch lines ~2045-2077. |
| Early dialogue entry | Yes | `enforceEarlyDialogueAnchor()` promotes early confrontation dialogue when first preserved dialogue is too late. |
| Cold open teaser + context reset + callback | Yes, explicitly in current code | `prepareColdOpenCallbackTimeline()`, `buildColdOpenCallbackMetadata()`, and `evaluateDialogueTimingQc(editorialPattern: 'cold_open_callback')`. Latest `edit_plan.json` has `editorial_pattern: "cold_open_callback"`. |
| Pure chronological progression | Partially / not guaranteed | Beats are sorted chronologically in fallback, but cold open intentionally breaks chronology; bootstrap then emits final timeline in edit-plan order. |

## E. Dialogue unit audit

Actual units:

1. **Beat level**: `narrative_beats.json` defines B001-B006 as story beats.
2. **Slot level**: `edit_plan.timeline[]` decides `NARRATE`, `KEEP_DIALOGUE`, or `DROP` per slot.
3. **Focus-line level**: `dialogue_focus_lines` and `dialogue_line_windows` select the concrete source lines within a slot.
4. **Bootstrap line segment level**: `buildBootstrapSlotMapAndScript()` emits one `dialogue_quote` segment per line (`slot_01_L01`, `slot_01_L02`, etc.).
5. **Caption display unit level**: CapCut generation can split a Korean line into multiple caption units in `edit_manifest.json` (`slot_01_L02_cap_001`, etc.).

Can the same conflict be reused twice?

- Yes, currently. `slot_01` uses B003 as `hook_teaser`; `slot_04` uses B003 again as `callback_dialogue` with `replay_of_slot_id: "slot_01"` and `replay_mode: "remaining_dialogue_after_cold_open"`.
- It does not duplicate the exact same line window in the callback; `collectRemainingDialogueFocusAfterColdOpen()` removes the cold-open used lines and selects remaining dialogue from the same beat.

## F. Color/rendering audit

### Speaker metadata assignment

Speaker metadata enters in `compression_slot_fills.json`:

```json
{
  "slot_id": "slot_01",
  "speakers": ["Scully", "Scully"]
}
```

Bootstrap copies this in `server/services/midformBootstrapAdapterService.js` lines ~237-278:

- `speakerList = fill.speakers`
- `speaker = speakerList[index] || fill.speaker`
- `segments.push({ speaker, ... })`

### Color mapping

Color config:

- `midform/config/caption_colors.json`
  - `Jobs`, `Steve Jobs`, `Steve` → `남주` → `#00A9F7`
  - `Sculley`, `Scully`, `John Scully`, `John Sculley` → `남조연` → `#37FF3D`

Color lookup:

- `scripts/capcut_draft.py:159-174`, `caption_color_for_speaker()`
  - reads `speakers[speaker]`
  - if mapped value is a hex color, returns it directly
  - otherwise treats mapped value as role and resolves through `roles`
  - can also resolve direct role names.

### Manifest evidence

Latest `edit_manifest.json` shows:

- Scully dialogue captions: `caption_color: "#37FF3D"`
- Jobs dialogue captions: `caption_color: "#00A9F7"`
- `caption_track_template_rebuild.colored_segments: 45`
- `caption_track_template_rebuild.removed_effect_refs: 135`

### Rendering path

`scripts/capcut_draft.py` creates manifest entries around lines ~9748-9867:

- `speaker = caption_unit.speaker || segment_info.speaker`
- `caption_color = caption_color_for_speaker(speaker, config)` for `dialogue_quote` / `dialogue`
- stores `speaker` and `caption_color` in caption timeline, caption manifest, and edit manifest entries.

Template subtitle rebuild happens in `rebuild_midform_caption_track_from_template()` lines ~2648-2735:

- Finds `TEMPLATE_SUBTITLE`.
- Clones template material and segment per SRT entry.
- Calls `apply_text_material_fill_color(cloned_material, caption_color)`.
- If color is applied, removes text effect layers using `remove_text_effect_layers_for_colored_caption()`.

`apply_text_material_fill_color()` lines ~191-219 modifies nested CapCut material content:

- sets `style_item["useLetterColor"] = true`
- writes `fill.content.solid.color = [r, g, b]`
- writes `material["text_color"]` and disables effect default color later in the same function body.

### Does manifest color guarantee rendered color?

No, not by itself. Repo code proves that rendering color depends on the generated CapCut `draft_content.json` material state, not only the manifest field. The code must apply nested material fill and remove effect refs; otherwise template effects can override the intended color. The librarian check found external pyCapCut examples consistent with RGB float color representation, but the repo code remains the authoritative source for this project.

## G. Failure mode / gap table

| Issue | Observed evidence | Pipeline layer | Severity | Likely fix type |
| --- | --- | --- | --- | --- |
| Late first dialogue in older structure | Older `pipeline_1785135546` tests assert first dialogue > 40s; `evaluateDialogueTimingQc()` has old first-dialogue thresholds. | Planner / selector | High for confrontation scenes | Heuristic + QC |
| Narration dominates first half | Old mode only checked first preserved dialogue timing; NARRATE slots can accumulate until `max_narration_run_exceeded`. Current `dialogue_timing_qc.max_narration_run_threshold_sec` is 25. | Planner / QC | High | Heuristic + QC |
| Teaser as rebuttal without accusation context | Current `hook_teaser.context_dependency: "medium"`, `requires_context: true`, `context_strategy: "bridge_narration"` for `slot_01`. The hook is understandable only with immediate context reset. | Selector / slot fills | Medium | Heuristic + script prompt |
| Context-heavy lines selected | `semantic_risk: "medium/high"`, `pronoun_risk: true`, and `context_strategy` are recorded; risk does not always block selection, it can choose bridge/merge strategies. | Selector / QC | Medium | Heuristic + QC threshold |
| Beat-level choice becomes line-level render | Planning chooses beats/slots, but bootstrap splits per `dialogue_line_windows`; final manifest may split Korean captions further. | Bootstrap / render | Medium | Schema clarity / manifest metadata |
| Human-readable review draft can mix types | `buildReviewDraftMarkdown()` labels `[KEEP_DIALOGUE]` / `[NARRATE]`, but final SRT strips those. Review artifact is clear; final viewer text is not type-labeled by design. | Bootstrap / review artifact | Low | Reporting/UI only |
| Correct manifest color but wrong rendered color | `edit_manifest.caption_color` is metadata. Actual render needs `apply_text_material_fill_color()` and effect-ref removal; template effects can override. | Renderer / template material | High for visual correctness | Renderer + template validation |
| Speaker spelling mismatch | Config needs exact `Scully` / `Sculley` / Korean variants. Missing mapping yields blank color. | Config / renderer | Medium | Config + fallback mapping |
| Callback timing can differ after TTS measurement | `recalculateNarrationDurations()` updates NARRATE durations after slot fills; metadata/QC must be recomputed after that. Current code does recompute in this working tree. | Compress-apply / refresh | High | QC recomputation |
| Chronology intentionally broken | Current cold open uses B003 at source `161s` before B001 context from `3s`; this is expected for `cold_open_callback`, but incompatible with pure chronological assumptions. | Planner / bootstrap / validation gates | Medium | Schema + gate exceptions |

## H. Gap analysis against target behavior

| Target behavior | Current limitation / current state | Exact layer | Fix type if changed later |
| --- | --- | --- | --- |
| Strongest hook can be used as cold open teaser | Currently supported by `prepareColdOpenCallbackTimeline()` / `bestColdOpenCallbackBeat()`. Selection remains heuristic and depends on transcript matching and hook scoring. | Planner / selector | Heuristic tuning |
| Narration can reset context after teaser | Supported: `slot_02` is NARRATE context reset; current `context_reset.target_duration_sec: 18.022`. But content quality still depends on slot fill text. | Slot fills / duration recalculation | Prompt + QC |
| Same conflict axis can reappear later as callback | Supported: B003 appears as `slot_01` hook and `slot_04` callback with `replay_of_slot_id`. Exact duplicate lines are avoided by `collectRemainingDialogueFocusAfterColdOpen()`. | Planner / selector / bootstrap | Schema + heuristic |
| Confrontation scenes should not frontload too much narration | Supported by `evaluateDialogueTimingQc()` max narration run and callback window. Older non-callback path still supports narration-only cold opens. | Planner / QC | Heuristic + gating |
| Speaker colors invariant through final render | Partially supported. Metadata/config/manifest path is correct in latest artifact, and template rebuild applied colors. But manifest field alone is not sufficient proof of final rendered color. | Renderer / template / material | Renderer validation + material inspection |

## I. External context note

The external/librarian check found pyCapCut-style color APIs use RGB float values, consistent with this repo's `fill.content.solid.color = [r, g, b]` path. External documentation did not supersede repo evidence for `use_effect_default_color` or CapCut template effect override behavior. This audit therefore treats `scripts/capcut_draft.py` and generated `draft_content.json` as the authoritative rendering evidence.
