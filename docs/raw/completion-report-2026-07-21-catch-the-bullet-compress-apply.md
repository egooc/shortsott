# Completion Report — Catch the Bullet compress-apply (`compress_20260720213249_3e-5BAhZQ5w`)

Date: 2026-07-21

## Request handled

Ran:

```bash
node scripts/midform.js compress-apply compress_20260720213249_3e-5BAhZQ5w
```

Phase 1 artifacts (transcript, heatmap, narrative_beats, edit_plan) already existed from the prior validation run; this step only generates Korean narration slot_fills against the existing edit plan and evaluates whether the fallback cold-open narration holds up, since heatmap was unavailable for this source.

## Result

Command succeeded. Artifacts written:

- `midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/compression_slot_fills.json`
- `midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/compress_apply_state.json`
  - `status: slot_fills_generated_pipeline_not_connected`
  - `pipeline_bootstrap_connected: false` (Phase 1 scope; pipeline bootstrap intentionally not wired up)

## Fallback cold-open selection (from edit_plan.json)

Heatmap was `unavailable`, so cold-open beat selection fell back to max `hook_potential`, then `dramatic_weight`:

- Selected beat: `beat_04` — the trap realization ("Five Sioux… We're bait")
- Teaser visual: intentionally decoupled from the story beat — muted visual from `beat_01`, 87.47–91.04s
- Spoiler policy: withhold the Sioux/bait answer in the teaser; save it for `body_peak`

## Generated cold-open narration (slot_01)

```
쫓던 쪽은 보안관 일행이었는데, 잠시 뒤 이 추격은 누군가 설계한 함정처럼 뒤집힙니다.
```

- caption_units: "쫓던 쪽은 보안관 일행이었는데" / "잠시 뒤 추격이 함정처럼 뒤집힙니다"
- caption_kr: "추격은 왜 함정이 됐을까"

## Quality assessment

**Rules followed:**

- Spoiler policy respected — does not reveal "Five Sioux" or "bait"
- Plants a question, withholds the answer ("왜 함정이 됐을까")
- Narration matches the story beat's mystery (beat_04) rather than the literal teaser shot dialogue (beat_01) — correct per the decoupling rule in the slot-fills prompt
- Self-reported `quality_check`: 0 forbidden endings, 0 translationese risk, 0 budget violations

**Issue found — the actual fallback gap:**

`slot_01.estimated_duration_sec` is `3.57`s, but the generated Korean narration is long enough to need roughly 6–7s of TTS playback. This is close to the validator's hard ceiling (6.5s) and, more importantly, longer than the muted teaser visual window it's paired with (87.47–91.04s = 3.57s). In narration-led cold-open playback, this produces a visual/narration length mismatch — the narration will run past the available muted visual.

This is the concrete manifestation of "폴백 콜드오픈 품질이 미검증 구멍" — not a rule violation, but a duration mismatch between generated narration length and the fallback-selected teaser visual window.

**Not a bug:** slots 03–08 (except 06) and slot_10 are `KEEP_DIALOGUE`/`DROP` per the edit plan, so empty narration/captions there are expected. Bridge (slot_02) is filled correctly ("포위전 → 인질 거래" rewind framing).

## Recommendation / next step

1. Either shorten the generated cold-open narration to fit ~3.5s, or extend the muted teaser visual window to match narration length (~6–7s), and re-run `compress-apply` (or `compress-refresh` first if the visual window needs to move).
2. Consider adding a validation check in `runCompressionApply` or `validateEditPlan` that flags when a NARRATE slot's narration length (estimated via character count or TTS heuristic) exceeds its paired visual window — this fallback-cold-open path currently has no such check.

## Blocked — next task

User asked to move to heatmap check for a new video (ID starting `8yix...`), but no matching video ID or URL exists anywhere in this repo. Need the full YouTube URL or 11-character video ID to proceed with `node scripts/midform.js compress --source <url> --target <sec>`.
