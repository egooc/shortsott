# Midform Run CLI Skill

Run the full midform recap pipeline from a single markdown template contract.

## Command

```bash
midform run --template midform/skills/midform-run/templates/production_default_ko.md --source https://youtu.be/xxxx
```

You can also run it directly from the repo without installing the bin globally:

```bash
node scripts/midform.js run --template midform/skills/midform-run/templates/production_default_ko.md --source https://youtu.be/xxxx
```

## Standard operator template

Use this as the default production entrypoint unless you intentionally need a different contract:

```bash
midform run --template midform/skills/midform-run/templates/production_default_ko.md --source https://youtu.be/xxxx
```

Template roles:

- `base.md` — minimal viable contract only
- `standard.md` — example production-style contract
- `advanced.md` — stricter audit-oriented example
- `production_default_ko.md` — **recommended day-to-day operator default**

## Supported options

```bash
midform run --template <file>
midform run --template <file> --profile production
midform run --template <file> --profile audit
midform run --template <file> --source https://youtu.be/xxxx
midform run --template <file> --resume slot_fill
midform run --template midform/skills/midform-run/templates/production_default_ko.md --source https://youtu.be/xxxx
```

## Required template fields

Only these are required in YAML front matter:

- `source.url`
- `output.target_length_sec`

The markdown body is optional and acts as additional author guidance.

In practice, operators should usually keep the template fixed and only override `--source`.

## Profiles

- `fast` — lighter proof generation, preview proof written as skipped
- `production` — full draft + acceptance gates + preview proof
- `audit` — full draft + stricter proof emphasis + higher preview sample count

## Resume stages

- `ingest`
- `analysis`
- `slot_fill`
- `bootstrap`
- `draft`

Resume uses a stable workspace derived from the normalized request contract, so the same template + overrides can continue from prior artifacts.

## Stable output artifacts

Each run workspace writes these root artifacts:

- `normalized_request.json`
- `narrative_beats.json`
- `story_beatmap.json`
- `edit_plan.json`
- `slot_map.json`
- `script.json`
- `draft_input.json`
- `edit_manifest.json`
- `draft_content.json`
- `acceptance_gates.json`
- `human_qa_review.md`
- `preview_frame_proof.json`
- `run_summary.json`

## Failure behavior

If bootstrap preflight, pipeline execution, or acceptance gates fail, the CLI returns a structured machine-readable failure summary in `run_summary.json` and on stdout.
