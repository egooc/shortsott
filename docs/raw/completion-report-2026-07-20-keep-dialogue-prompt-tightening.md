# Completion Report — KEEP_DIALOGUE Prompt Tightening

Date: 2026-07-20

## Request handled

Strengthened the **edit-plan prompt** so fresh automatic Codex runs prefer identity-defining dialogue only, and verified the result on a fresh Twilight compression run.

Goal was to remove side-branch dialogue such as:

- `Eggshells, carrot tops`
- `radioactive spiders`
- `No, our bus is full`
- `I can keep a secret`

while preserving identity lines such as:

- `if you were smart, you'd stay away from me`
- `what if I'm the bad guy?`
- `What are they really?`

## Files changed

- `server/services/midformCompressionService.js`

## What changed

### 1. Prompt strengthened

In `buildEditPlanPrompt()` the `KEEP_DIALOGUE` rules were tightened to explicitly require:

- only identity dialogue,
- exclusion of environment / transition / cushion / side-branch lines,
- `dialogue_focus_quotes` limited to **3–5 lines**,
- highest hook / reveal lines chosen first,
- explicit KEEP vs DROP examples embedded in the prompt.

### 2. Validation tightened

In `validateEditPlan()`:

- every `KEEP_DIALOGUE` slot must include `dialogue_focus_quotes`
- `dialogue_focus_quotes.length` must be `<= 5`

### 3. Post-processing now honors Codex focus

`finalizeEditPlan()` previously recalculated dialogue focus from the whole beat, which meant Codex's selection could be lost.

It now:

- uses `item.dialogue_focus_quotes` when present,
- aligns transcript trimming against those quotes,
- preserves Codex-selected focus instead of re-expanding to the whole beat.

## Fresh validation run

Fresh run completed:

- `midform/test_runs/compress_20260720191645_ngYmFVO_bzM`

Artifacts:

- `midform/test_runs/compress_20260720191645_ngYmFVO_bzM/compress_state.json`
- `midform/test_runs/compress_20260720191645_ngYmFVO_bzM/edit_plan.json`
- `midform/test_runs/compress_20260720191645_ngYmFVO_bzM/compression_slot_fills.json`

## Result review

## Good news

The prompt tightening **did remove the obvious side-branch lines** from the fresh automatic path.

### Previously bad examples that disappeared

#### Greenhouse chatter removed

Old noisy line:

- `Eggshells, carrot tops. Compost is cool.`

Fresh result: **gone** from preserved dialogue.

#### Bus-exit clutter removed

Old noisy line:

- `No, our bus is full`

Fresh result: **gone** from preserved dialogue.

#### `radioactive spiders` removed

Old noisy line:

- `radioactive spiders`

Fresh result: **gone** from preserved dialogue.

## Where the fresh automatic path now lands

### `slot_05` (former greenhouse keep block)

Fresh `edit_plan.json` keeps only:

- `What's in Jacksonville?`
- `How did you know about that?`
- `How did you stop the van?`

This is a clear improvement.

### `slot_08` (bad-guy confrontation replay block)

Fresh `edit_plan.json` keeps:

- `your mood swings are kind of giving me whiplash.`
- `I only said it'd be better if we weren't friends.`
- `It means if you were smart, you'd stay away from me.`
- `Would you tell me the truth?`

This is cleaner than before, but still **not ideal** for your stated editorial target because:

- `what if I'm the bad guy?`
  is no longer in the selected 3–5 lines,
- while weaker lines still survive.

### `slot_10` (payoff block)

Fresh `edit_plan.json` keeps:

- `What did your friends mean about, you know, the Cullins don't come here?`
- `I'm not really supposed to say anything about it.`
- `it's just like an old scary story.`
- `What are they really?`

This is **cleaner than before**, but still not aligned with the desired payoff identity set.

Specifically, it still keeps cushion/setup lines:

- `I'm not really supposed to say anything about it.`
- `it's just like an old scary story.`

and it dropped stronger identity lines you explicitly want preserved:

- `descended from wolves`
- `we made a treaty with them`

## compress-apply result

After running:

```bash
node scripts/midform.js compress-apply compress_20260720191645_ngYmFVO_bzM
```

Generated file:

- `midform/test_runs/compress_20260720191645_ngYmFVO_bzM/compression_slot_fills.json`

The slot-fill output reflects the new edit plan:

- cold-open hook narration is generated cleanly
- side-branch dialogue is no longer leaking into narration text
- but the **payoff dialogue identity selection is still not the one you want**

## Final judgment

### What succeeded

- The prompt tightening works.
- The worst side-branch clutter is gone automatically in fresh runs.
- The pipeline is now following Codex-selected dialogue focus instead of re-expanding beats afterward.

### What is still wrong

The automatic Codex path still optimizes for *cleaner* dialogue, not yet for your exact **identity hierarchy**.

Most importantly:

- `slot_08` should prioritize `bad guy` more strongly.
- `slot_10` should prioritize:
  - `descended from wolves`
  - `we made a treaty with them`
  - `What are they really?`
  - `It's just a story`

and demote:

- `I'm not really supposed to say anything about it.`
- `it's just like an old scary story.`

## Conclusion

This pass is a **partial success**:

- **automatic side-branch cleanup improved materially**,
- but **identity-priority dialogue ranking still needs one more tightening pass**.

The next edit should target ranking logic in the prompt itself so Codex favors:

1. reveal / threat / boundary / identity lines,
2. then direct question lines,
3. and only last the cushion/setup lines.
