# Completion Report — compress-apply Review for `compress_20260720185513_ngYmFVO_bzM`

Date: 2026-07-20

## Request handled

Ran `compress-apply` on the fresh run `compress_20260720185513_ngYmFVO_bzM` and checked two things together:

1. whether the cold-open hook narration comes out automatically in `slot_fills`, and
2. whether side-branch dialogue still remains in the preserved dialogue plan.

## Command run

```bash
node scripts/midform.js compress-apply compress_20260720185513_ngYmFVO_bzM
```

## Generated artifacts

- Slot fills:
  - `midform/test_runs/compress_20260720185513_ngYmFVO_bzM/compression_slot_fills.json`
- Apply state:
  - `midform/test_runs/compress_20260720185513_ngYmFVO_bzM/compress_apply_state.json`
- Phase 1 plan used for review:
  - `midform/test_runs/compress_20260720185513_ngYmFVO_bzM/edit_plan.json`

## Result A — cold-open hook narration

### Verdict

**Yes — the cold-open hook is being generated automatically.**

### Evidence

From `compression_slot_fills.json`, `slot_01`:

```text
벨라는 아직 모른다. 에드워드가 밀어내는 이유가 정말 후회 때문인지, 아니면 누군가 절대 가까이 가면 안 되는 선을 넘고 있어서인지.
```

Caption units:

- `벨라는 아직 모른다.`
- `에드워드가 밀어내는 이유가 정말 후회 때문인지,`
- `아니면 누군가 절대 가까이 가면 안 되는 선을 넘고 있어서인지.`

### Assessment

This is functioning as a real hook:

- it asks an unresolved question,
- it avoids explaining the Cullen secret,
- and it matches the cold-open intent in the fresh Codex edit plan.

So for item A, the answer is **pass**.

## Result B — side-branch dialogue leakage

### Verdict

**Yes — side-branch dialogue still remains in the current fresh plan.**

It is not showing up as bad narration in `slot_fills`, but it is still visible in the preserved `KEEP_DIALOGUE` choices in `edit_plan.json`.

### Where it remains

#### `slot_04` / `beat_03`

Still contains a side-branch line in dialogue focus:

- `Eggshells, carrot tops. Compost is cool.`

That is exactly the kind of greenhouse/process chatter that should not survive if the goal is to keep only the identity-defining confrontation.

#### `slot_05` / `beat_04`

Still keeps an off-axis tail line:

- `>> No, our bus is full.`

That line is a scene-exit interruption, not the identity of the emotional conflict.

#### `slot_07` / `beat_06`

Still preserves lines that are weaker than the core identity lines:

- `No, probably not.`
- `I have considered radioactive spiders and kryptonite.`

The true identity lines are stronger:

- `if you were smart, you'd stay away from me.`
- `What if I'm not the hero? What if I'm the bad guy?`

#### `slot_09` / `beat_08`

Still over-preserves the payoff block. It keeps:

- `I'm not really supposed to say anything about it.`
- `Hey, I can keep a secret.`
- `it's just like an old scary story.`

Those are setup/cushion lines, not the identity-defining legend core.

The lines that matter most are still:

- `kuutes are supposedly descended from wolves?`
- `we made a treaty with them.`
- `What are they really?`
- `It's just a story, Bella.`

## Overall assessment

### What is working

- `compress-apply` completed successfully
- cold-open hook narration is generated automatically
- narration-only slots (`slot_01`, `slot_02`, `slot_03`, `slot_06`, `slot_08`) are coherent and on-brief

### What is still not solved

The **dialogue-selection policy is still too permissive** on the fresh Codex path.

It continues to preserve:

- environmental chatter,
- transition lines,
- soft setup lines,
- and non-identity dialogue inside blocks that should be more aggressively reduced.

## Recommendation

Before Phase 2 bootstrap, the next correction should be:

1. tighten `KEEP_DIALOGUE` selection rules,
2. rank lines by **identity value**, not just beat inclusion,
3. demote side-branch lines even when they are technically inside the same beat.

In this run, the target editorial rule should be:

- keep `bad guy` (`slot_07`) as a must-have dialogue anchor,
- keep the wolf/treaty/"What are they really?" payoff in `slot_09`,
- trim everything else much harder.

## Final answer to the two checks

### 1. Cold-open hook auto-generated?

**Yes.**

### 2. Side-branch dialogue still left?

**Yes.**

It remains mainly in `edit_plan.json` dialogue focus for:

- `slot_04`
- `slot_05`
- `slot_07`
- `slot_09`

and should be tightened before Phase 2.
