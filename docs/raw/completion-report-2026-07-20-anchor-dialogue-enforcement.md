# Completion Report — Anchor Dialogue Enforcement

Date: 2026-07-20

## Request handled

Changed the automatic compression path so `KEEP_DIALOGUE` no longer depends on free-form prompt discretion alone.

New direction implemented:

1. each beat now carries explicit `anchor_dialogue` lines,
2. every `KEEP_DIALOGUE` slot must include those anchors,
3. Codex can still choose supporting lines, but it cannot drop the anchors.

## Files changed

- `midform/schemas/midform_compression_beats_schema.json`
- `server/services/midformCompressionService.js`

## What changed

### 1. Beats contract extended

Added `anchor_dialogue` to the beats schema:

- `midform/schemas/midform_compression_beats_schema.json`

`anchor_dialogue` is now required for each beat.

### 2. Beats prompt updated

`buildBeatsPrompt()` now explicitly tells Codex:

- choose `1-2` identity-defining anchor lines from `key_dialogue`
- use anchors for later `KEEP_DIALOGUE` enforcement
- prefer hooks / reveals / boundary lines
- avoid cushion lines

Embedded examples:

- KEEP examples:
  - `if you were smart, you'd stay away from me`
  - `what if I'm the bad guy?`
  - `descended from wolves`
  - `we made a treaty with them`
  - `What are they really?`
- DROP examples:
  - `Eggshells, carrot tops`
  - `radioactive spiders`
  - `No, our bus is full`
  - `I can keep a secret`
  - `old scary story`

### 3. Beat anchors normalized in code

Added deterministic normalization in `server/services/midformCompressionService.js`:

- `scoreAnchorLine()`
- `selectBeatAnchors()`
- `normalizeBeatAnchors()`

This means even if the model under-specifies anchors, the beat object is normalized into a usable anchor set.

### 4. KEEP_DIALOGUE validation now enforces anchors

Added:

- `validateEditPlanAgainstBeats()`

Rule:

- if a slot is `KEEP_DIALOGUE`, its `dialogue_focus_quotes` **must include every anchor** from the corresponding beat.

### 5. Final transcript trimming now honors anchors

`finalizeEditPlan()` now merges:

- beat anchors
- Codex-selected `dialogue_focus_quotes`

before transcript matching.

So the post-processor can no longer silently expand or replace the identity lines with unrelated lines.

## Fresh validation run

Fresh run used for validation:

- `midform/test_runs/compress_20260720200808_ngYmFVO_bzM`

Artifacts:

- `midform/test_runs/compress_20260720200808_ngYmFVO_bzM/narrative_beats.json`
- `midform/test_runs/compress_20260720200808_ngYmFVO_bzM/edit_plan.json`
- `midform/test_runs/compress_20260720200808_ngYmFVO_bzM/compression_slot_fills.json`

## Validation against the requested checks

### A. `slot_08` equivalent bad-guy beat must include `what if I'm the bad guy?`

In this fresh run, the numbering shifted:

- the bad-guy confrontation is `S07` in `edit_plan.json`

Observed anchors in `narrative_beats.json` for `B06`:

- `It means if you were smart, you'd stay away from me.`
- `what if I'm not the hero? What if I'm the bad guy?`

Observed `dialogue_focus_quotes` in `edit_plan.json` for `S07`:

- `It means if you were smart, you'd stay away from me.`
- `what if I'm not the hero? What if I'm the bad guy?`
- plus supporting lines

### Result

**PASS** — the anchor line is now automatically present.

### B. payoff beat must include wolves / treaty / “What are they really?”

In this fresh run, the payoff block is:

- `S09`

Observed anchors in `narrative_beats.json` for `B08`:

- `did you know kuutes are supposedly descended from wolves?`
- `What are they really?`

Observed `dialogue_focus_quotes` in `edit_plan.json` for `S09`:

- `did you know kuutes are supposedly descended from wolves?`
- `What are they really?`
- `What did your friends mean about, you know, the Cullins don't come here?`
- `I'm not really supposed to say anything about it.`

### Result

**PARTIAL PASS**

- `descended from wolves` ✅ included
- `What are they really?` ✅ included
- `we made a treaty` ❌ not included
- cushion line `I'm not really supposed to say anything about it.` ❌ still survives

This means the anchor system works, but because `anchor_dialogue` is capped at `1-2` lines, the treaty line is not currently guaranteed.

### C. cushion lines should disappear or be demoted

Observed improvements:

- `Eggshells, carrot tops` is gone from fresh `KEEP_DIALOGUE`
- `radioactive spiders` is gone from fresh `KEEP_DIALOGUE`
- `No, our bus is full` is gone from fresh `KEEP_DIALOGUE`

But in payoff:

- `I'm not really supposed to say anything about it.` still remains

### Result

**Improved, but not fully solved**.

## compress-apply check

Ran:

```bash
node scripts/midform.js compress-apply compress_20260720200808_ngYmFVO_bzM
```

Generated:

- `midform/test_runs/compress_20260720200808_ngYmFVO_bzM/compression_slot_fills.json`

The slot fills confirm:

- the pipeline accepted the fresh anchored edit plan,
- but several later slots became narration-only in the generated slot fills,
- so the most useful place to judge anchor enforcement remains the fresh `edit_plan.json`.

## Final judgment

### What now works automatically

- identity anchors are now a first-class beat contract
- `KEEP_DIALOGUE` slots must include anchors
- the `bad guy` line is automatically preserved
- obvious side-branch clutter is reduced substantially

### What still needs one more pass

The payoff identity set is still not strict enough.

Specifically, if you want all three to be mandatory:

- `descended from wolves`
- `we made a treaty`
- `What are they really?`

then the current `anchor_dialogue` limit of `1-2` lines is too narrow.

## Recommended next change

Increase payoff-anchor capacity or role-specific anchor rules, e.g.:

- normal beats: `1-2` anchors
- payoff beats: `2-3` anchors

Then require `we made a treaty` to join the guaranteed anchor set for the payoff beat.
