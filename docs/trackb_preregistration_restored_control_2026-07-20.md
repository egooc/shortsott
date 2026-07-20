# Track B preregistration — restored control definition (2026-07-20)

Status: active before any further Track B pair collection under the restored control definition.

## Scope

This preregistration applies to Track B duration A/B collection from this timestamp forward. It is written into the repository before additional pair collection so post-hoc reinterpretation of the control arm is blocked.

## Hypothesis

For this channel's own highlight output, the 7-day success multiple is higher for 3–5s cuts than for 6–10s cuts.

- Treatment arm `T`: 3–5s cut
- Control arm `C`: 6–10s cut
- Outcome: `success_multiple_at_7d = view_count_at_7d / channel_median_at_7d`

Directional hypothesis:

```text
median(T) > median(C)
```

## Treatment definition

### T arm (registered treatment)

`T` is defined as a 3–5s highlight cut that completes one visible loop cycle.

- duration must remain inside `[3, 5]`
- anchor must be an observed `IMPACT`
- the chosen window must be RESET-complete: `RESET -> IMPACT -> RESET`
- seam loop preference is not optional for `T`; it is part of the treatment definition

### C arm (registered control)

`C` is defined as a 6–10s cut from the same source video.

- duration must remain inside `[6, 10]`
- anchor must come from the same detected candidate search pass used to evaluate `T`
- RESET-complete closure is **not** required for `C`
- this restores the original control meaning: a longer cut from the same source, not a second loop-complete treatment variant

## Pair eligibility

One source video is eligible only if both of the following can be produced from the same source:

1. one valid `T` window under the treatment definition above
2. one valid `C` window under the control definition above

If no valid `T` window exists, the source is ineligible even if a 6–10s cut exists.

## Exclusion rules

- Do not relax the `T` RESET-complete requirement.
- Do not relax the 3–5s or 6–10s duration bounds.
- Do not widen anchor tolerance to rescue borderline cases.
- If either member of a collected pair is dropped before usable outcome collection, treat that pair as incomplete in the confirmatory analysis set.

## Confirmatory decision rule for this preregistration

Primary registered test for this restored-definition collection:

```text
U = Mann-Whitney U(T, C)
```

Decision threshold:

- `p < 0.05`
- and `median(T) / median(C) >= 1.5`

Both conditions must hold to declare confirmation.

## Sample size

- target sample: 30 per arm
- operationally: 30 valid `T` edits and 30 valid `C` edits collected under this preregistered definition

## Rationale for this preregistration

Track B's design-of-record states that the claim under test is the duration effect itself: `3–5s` versus `6–10s`. It also states that loop-complete window selection is specific to the `SHORT/T` arm. This preregistration freezes that interpretation before more restored-definition data is gathered.
