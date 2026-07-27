# Completion Report — Payoff Anchor 3-Line Enforcement

Date: 2026-07-20

## Request handled

Adjusted anchor rules so reveal/payoff-heavy beats can keep **3 anchors** while ordinary beats remain capped at **1-2**.

Goal:

- ensure payoff blocks like the wolf legend do not lose the treaty line,
- keep cushion lines out of anchor selection,
- verify on a fresh Twilight compression run.

## Files changed

- `server/services/midformCompressionService.js`

## What changed

### 1. Role-aware anchor capacity

Added logic so:

- ordinary beats: max `1-2` anchors
- reveal/payoff-heavy beats: max `3` anchors

Implementation additions:

- `REVEAL_BEAT_MAX_ANCHOR_LINES = 3`
- `isRevealHeavyBeat()`
- `maxAnchorsForBeat()`

### 2. Anchor scoring preserved payoff facts

Anchor scoring already strongly rewarded:

- `bad guy`
- `stay away`
- `descended from wolves`
- `made a treaty`
- `What are they really?`

and penalized cushion/setup lines:

- `I can keep a secret`
- `old scary story`
- `Eggshells, carrot tops`
- `radioactive spiders`
- `No, our bus is full`

With 3-anchor allowance for reveal-heavy beats, the payoff beat can now keep:

- wolves
- treaty
- direct identity question

## Fresh validation run

Fresh run:

- `midform/test_runs/compress_20260720203412_ngYmFVO_bzM`

Relevant files:

- `midform/test_runs/compress_20260720203412_ngYmFVO_bzM/narrative_beats.json`
- `midform/test_runs/compress_20260720203412_ngYmFVO_bzM/edit_plan.json`
- `midform/test_runs/compress_20260720203412_ngYmFVO_bzM/compression_slot_fills.json`

## Verification outcome

### Beat anchors

In `narrative_beats.json`, payoff beat `beat_07` now has:

```json
"anchor_dialogue": [
  "kuutes are supposedly descended from wolves?",
  "we made a treaty with them.",
  "What are they really?"
]
```

This is the exact 3-line reveal set we wanted.

### Fresh edit-plan inclusion

In the fresh `edit_plan.json`, the payoff block is `slot_08` (the local fallback planner renumbered slots in this run).

Observed `dialogue_focus_quotes`:

```json
[
  "kuutes are supposedly descended from wolves?",
  "we made a treaty with them.",
  "What are they really?"
]
```

### Cushion-line status

The following cushion lines are **not** in the payoff focus list:

- `I'm not really supposed to say anything about it.`
- `old scary story`

So the payoff focus is now clean.

## Requested checks

### 1. `bad guy` anchor preserved automatically?

Yes.

In the fresh run, the confrontation block includes:

- `if you were smart, you'd stay away from me.`
- `what if I'm not the hero? What if I'm the bad guy?`
- `It's a mask.`

### 2. Payoff includes all 3 required lines automatically?

Yes.

Observed in fresh `edit_plan.json` payoff block:

- `descended from wolves` ✅
- `we made a treaty` ✅
- `What are they really?` ✅

### 3. Cushion lines removed from payoff focus?

Yes.

Not present in payoff `dialogue_focus_quotes`:

- `I'm not really supposed to say anything about it.` ❌ removed
- `old scary story` ❌ removed

## Important note about slot numbering

You asked to verify `S09`, but in this fresh run the payoff block became `slot_08` because the run used the local fallback planner path and renumbered the timeline differently.

Functionally, the payoff block is still the same legend/reveal section, and the required anchor enforcement worked there.

## Final judgment

This pass is a **success** for the requested payoff-anchor behavior.

The system now automatically guarantees:

- `bad guy` survives in the confrontation block,
- payoff/reveal can preserve **3** anchor facts,
- treaty is no longer dropped,
- cushion lines are excluded from payoff focus.
