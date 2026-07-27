# Midform Editorial Generalization Wave 4 — Production Quality Hardening Report

Date: 2026-07-28  
Mode: offline production-quality hardening with local fixtures, local CapCut draft generation, material validation, and preview-frame proof

## 1. Executive summary

Wave 4 moved the work from metadata propagation into production-facing quality gates and multi-fixture visible-output evidence.

Implemented:

- automatic editorial acceptance gates in `server/services/midformEditorialAcceptanceService.js`
- multi-fixture offline regeneration in `scripts/wave4_regenerate_fixtures.js`
- preview-frame visual proof in `scripts/wave4_visual_preview.py`
- speaker color aliases for Fences and Catch the Bullet speakers in `midform/config/caption_colors.json`
- focused gate regressions in `tests/editorialAcceptanceGates.test.js`

Generated Wave 4 artifact root:

- `midform/test_runs/offline_wave4_20260728_production_quality/`

Validated fixture scene types:

| fixture | scene type | output draft | copy changes | material color | preview frames | gates |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Steve Jobs / Sculley | `dialogue_confrontation` | `server/output/drafts/pipeline_1785170688` | 5 | 44/44 | 8/8 | passed |
| Catch the Bullet | `dialogue_reveal` | `server/output/drafts/pipeline_1785170907` | 6 | 6/6 | 4/4 | passed |
| Twilight baseball | `comedic_setpiece` | `server/output/drafts/pipeline_1785171001` | 6 | 8/8 | 6/6 | passed |
| Fences father/son | `emotional_confession` | `server/output/drafts/pipeline_1785171484` | 8 | 6/6 | 4/4 | passed |

Important scope note: Wave 4 produces **local preview-frame proof** and CapCut `draft_content.json` material proof. It does **not** prove final exported video pixels from the CapCut app, and offline narration audio uses silent placeholder MP3s so text/timing/render proof can be generated without live TTS/network access.

## 2. Files changed

- `server/services/midformEditorialAcceptanceService.js`
  - Added automatic pass/fail/warning gates for weak openers, callback timing, long pre-engagement narration, subtitle readability, high-context teaser recovery, rendered/material speaker-color mismatch, and first-30-second clarity.
- `tests/editorialAcceptanceGates.test.js`
  - Added rejection/passing/warning/color-mismatch regressions.
- `scripts/wave4_regenerate_fixtures.js`
  - Regenerates four fixture scripts, builds offline draft inputs, creates silent placeholder narration audio, renders CapCut drafts, copies proof artifacts, runs acceptance gates, and writes QA summaries.
- `scripts/wave4_visual_preview.py`
  - Samples real source-video frames and overlays generated subtitle text in resolved speaker color for preview-level visual evidence.
- `midform/config/caption_colors.json`
  - Added Fences and Catch speaker aliases (`Troy`, `Cory`, `Britt`, `Jed`, `Chaska`, etc.).
- `package.json`
  - Extended `verify:js` and `verify:py` to syntax-check new Wave 3/4 utility files and acceptance service.
- generated artifacts under `midform/test_runs/offline_wave4_20260728_production_quality/`
- generated drafts under `server/output/drafts/pipeline_1785170688`, `pipeline_1785170907`, `pipeline_1785171001`, `pipeline_1785171484`

## 3. Workstream results (A–E)

### A. Fresh full-copy regeneration

For each fixture, Wave 4 writes a fresh `script.json`, `draft_input.json`, `copy_comparison.json`, and rendered draft.

The regeneration is deterministic/offline rather than LLM-backed because live LLM/TTS access is not reliable in this environment. Still, it changes full visible Korean output, including narration slots where clarity was weak or too long.

Examples:

- Steve/Sculley context reset rewritten to explicitly connect NeXT, Jobs/Sculley, 1984 ad blame, and the truth question.
- Catch rewrites the hook and bridge so “미끼” is tied to the father/son hostage pursuit without inventing mastermind causation.
- Twilight rewrites narration so the scene stays a setpiece first, then escalates into a predator threat without forcing confrontation callback behavior.
- Fences compresses the overlong bridge into a clearer love-versus-duty emotional axis.

### B. Multi-fixture validation

Four scene types were validated locally:

1. `dialogue_confrontation` — Steve Jobs / Sculley
2. `emotional_confession` — Fences father/son
3. `comedic_setpiece` — Twilight baseball
4. `dialogue_reveal` — Catch the Bullet

Each fixture has:

- `copy_comparison.json`
- `human_qa_review.md`
- `acceptance_gates.json`
- `material_color_proof.json`
- `preview_frame_proof.json`
- `preview_frames/*.png`
- final `edit_manifest.json` and `draft_content.json` copies

### C. Human-facing clarity QA

Each fixture has a human-readable QA file:

- `midform/test_runs/offline_wave4_20260728_production_quality/dialogue_confrontation_steve_sculley/human_qa_review.md`
- `midform/test_runs/offline_wave4_20260728_production_quality/dialogue_reveal_catch_bullet/human_qa_review.md`
- `midform/test_runs/offline_wave4_20260728_production_quality/comedic_setpiece_twilight_baseball/human_qa_review.md`
- `midform/test_runs/offline_wave4_20260728_production_quality/emotional_confession_fences/human_qa_review.md`

QA covers:

1. first-5-second hook clarity
2. first-20-second context recovery
3. callback/recognizable payoff behavior
4. conflict readability
5. subtitle readability / density
6. emotional rhythm / pacing coherence
7. meaningful teaser quality
8. context reset balance

### D. Export-level visual proof

Wave 4 adds preview-frame proof PNGs for every fixture. These are generated from actual source frames at dialogue sample timestamps with the generated Korean subtitle and resolved speaker color overlaid.

Examples:

- Twilight:
  - `.../comedic_setpiece_twilight_baseball/preview_frames/01_slot_01_L01.png` — James `#37FF3D`, “간식을 데려왔네.”
  - `.../comedic_setpiece_twilight_baseball/preview_frames/02_slot_01_L02.png` — Edward `#00A9F7`, “그 애는 우리와 함께 왔어.”
- Steve/Sculley:
  - `.../dialogue_confrontation_steve_sculley/preview_frames/01_slot_01_L01.png`
  - `.../dialogue_confrontation_steve_sculley/preview_frames/02_slot_01_L02.png`

Preview-frame proof summary:

| fixture | preview frames passed |
| --- | ---: |
| Steve/Sculley | 8/8 |
| Catch | 4/4 |
| Twilight | 6/6 |
| Fences | 4/4 |

Material color proof also passes:

| fixture | material color proof |
| --- | ---: |
| Steve/Sculley | 44/44 |
| Catch | 6/6 |
| Twilight | 8/8 |
| Fences | 6/6 |

Scope limitation: this is stronger than manifest-only proof because it produces visual PNG artifacts tied to source frames and generated subtitle colors, but it is still not a CapCut-app exported MP4 pixel validation.

### E. Editorial acceptance gates

New gate IDs:

- `rebuttal_only_opener`
- `callback_strength`
- `dramatic_engagement_timing`
- `subtitle_readability`
- `high_context_teaser_recovery`
- `rendered_speaker_color_match`
- `first_30_conflict_clarity`

Gate outputs are real status objects, not descriptive notes. They can return:

- `passed`
- `passed_with_warnings`
- `failed`

Per-fixture gate result: all four regenerated Wave 4 fixtures passed.

Focused tests:

```text
node --test tests/editorialAcceptanceGates.test.js
tests 4, pass 4, fail 0
```

## 4. Before/after evidence by fixture

### Steve Jobs / Sculley — `dialogue_confrontation`

Path: `midform/test_runs/offline_wave4_20260728_production_quality/dialogue_confrontation_steve_sculley/copy_comparison.json`

Representative changes:

- Before: `애플에서 쫓겨난 잡스는 NeXT 발표 직전, 자신을 밀어낸 전 CEO 스컬리와 다시 마주합니다...`
- After: `NeXT 발표 직전, 잡스는 자신을 회사 밖으로 밀어낸 남자와 마주합니다. 두 사람의 싸움은 해고보다 먼저, 1984 광고의 책임에서 다시 불붙죠...`

Result: improved context reset clarity around meeting, ad-blame axis, and truth question. Confrontation behavior did not regress; gates passed and speaker colors passed 44/44.

### Catch the Bullet — `dialogue_reveal`

Path: `midform/test_runs/offline_wave4_20260728_production_quality/dialogue_reveal_catch_bullet/copy_comparison.json`

Representative changes:

- Before: `쫓던 자들이 미끼가 된 이유`
- After: `쫓던 보안관 일행은, 왜 갑자기 미끼가 됐을까?`
- Before dialogue captions were empty in the bootstrap script.
- After: `제드, 얌전히 나와라.`, `계획이 바뀌었어. 인질은 셋이다.`, `우리가 미끼였어.`

Result: improved artifact depth because previously empty dialogue captions now render Korean viewer text with speaker color proof.

### Twilight baseball — `comedic_setpiece`

Path: `midform/test_runs/offline_wave4_20260728_production_quality/comedic_setpiece_twilight_baseball/copy_comparison.json`

Representative changes:

- Before: `인간 소녀 벨라는 뱀파이어 남자친구 에드워드의 가족과 특별한 데이트를 즐기고 있었습니다...`
- After: `벨라는 에드워드의 가족과 폭풍 속 야구 경기를 구경합니다. 천둥이 칠 때만 가능한, 말도 안 되는 힘의 놀이였죠.`
- Before: `간식거리를 데려왔네.`
- After: `간식을 데려왔네.`

Result: setpiece remains setpiece-first. It escalates into threat without importing confrontation-specific callback behavior.

### Fences father/son — `emotional_confession`

Path: `midform/test_runs/offline_wave4_20260728_production_quality/emotional_confession_fences/copy_comparison.json`

Representative changes:

- Before: `트로이는 그 질문을 사랑의 확인이 아니라 자기 권위에 대한 도전으로 받아들였습니다...` (long bridge)
- After: `하지만 트로이는 그 질문을 상처가 아니라 도전으로 받아들입니다. 밥과 집과 옷을 누가 줬는지 따지며, 사랑의 문제를 책임의 장부로 바꿔 버리죠.`

Result: shorter, clearer emotional axis. The “love vs responsibility” payoff is easier to follow.

## 5. Human-facing QA findings

All four fixtures received `human_qa_review.md` files. Summary:

- Steve/Sculley: improved context reset and ad-truth callback readability.
- Catch: improved reveal path from pursuit/hostage setup to bait payoff.
- Twilight: preserved non-confrontation setpiece tone and avoided overfitting callback logic.
- Fences: improved emotional clarity by reducing long explanatory narration.

## 6. Visual render validation evidence

Evidence levels now available:

1. final CapCut draft artifacts (`edit_manifest.json`, `draft_content.json`)
2. material-level speaker-color validation (`material_color_proof.json`)
3. preview-level PNG frame proof (`preview_frame_proof.json`, `preview_frames/*.png`)

The preview PNGs are tied to exact source sample seconds and generated subtitle/speaker colors. Example proof object from Twilight:

```json
{
  "segment_id": "slot_01_L02",
  "speaker": "Edward",
  "caption_color": "#00A9F7",
  "text": "그 애는 우리와 함께 왔어.",
  "sample_sec": 413.129,
  "preview_path": "midform/test_runs/offline_wave4_20260728_production_quality/comedic_setpiece_twilight_baseball/preview_frames/02_slot_01_L02.png",
  "status": "passed"
}
```

## 7. Acceptance gate results

All regenerated fixtures passed automatic gates.

The tests prove gates can fail bad drafts:

- rebuttal-only opener + missing callback is rejected
- overlong/dense subtitles produce review warnings
- material/render speaker-color mismatch fails

## 8. Remaining gaps

Not production-complete yet:

1. True CapCut-app exported MP4 pixel validation is still not automated. Wave 4 generates preview-frame PNGs, not an actual CapCut export.
2. Fresh narration audio is not real TTS in this offline wave. Silent placeholder MP3s are used so draft rendering and subtitle/color proof can run without network.
3. The deterministic offline copy rewrites prove the pipeline/gates/artifact path, but they are not a substitute for live LLM full-copy regeneration across arbitrary new scenes.
4. Some timing metrics in placeholder-audio drafts are useful for structure/gates but should be reconfirmed once real TTS durations are available.

## 9. Recommended next wave or production-ready conclusion

Recommendation: one final production-readiness wave should connect this Wave 4 gate/proof harness to live LLM + real TTS + exported MP4 validation.

Production checklist before calling the pipeline fully ready:

- run Wave 4 harness with live slot-fill generation, not deterministic offline rewrites
- generate real TTS for changed narration
- export actual MP4 or CapCut preview render
- sample exported pixels to verify subtitle color and placement
- require `acceptance_gates.status === "passed"` before approving drafts
- keep preview-frame proof as a fast local pre-export check

Wave 4 is therefore a successful production-hardening step, but not a final production sign-off because exported-video pixel proof and real regenerated narration audio remain outside the offline evidence boundary.
