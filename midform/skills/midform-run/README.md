# Midform Run CLI Skill

Run the sealed local midform movie-recap pipeline from a neutral scaffold or from URL-specific auto-generated template bodies.

## Default operator command

Use this command for normal batch production work. The runner generates URL-specific KO/JA template bodies from each URL's evidence and does not require a video-specific template:

```bash
node scripts/midform.js batch --manifest midform/batches/production_batch_001.json
```

For a single full-auto URL run:

```bash
node scripts/midform.js run --source https://youtu.be/xxxx --mode full_auto
```

If a scaffold is explicitly needed, use the neutral scaffold only:

```bash
node scripts/midform.js run --template midform/skills/midform-run/templates/production_base.md --source https://youtu.be/xxxx
```

Do not use a completed scene-specific template as a common batch default. `now_you_see_me_interrogation_ko.md` is a specific Now You See Me FBI interrogation scene brief and must only be selected intentionally for that source.

## What the command produces

The production template is designed for 60-180 second Korean movie-recap drafts. The active workflow is:

```text
source video + yt-dlp metadata
-> timed YouTube subtitle transcript
-> compression-first scene analysis
-> optional auto multimodal escalation
-> movie research / story beatmap / slot map
-> GPT/Codex slot fill
-> TTS and caption-unit assembly
-> CapCut draft generation
-> acceptance gates, preview proof, run summary
```

## Analysis modes

`analysis_mode` defaults to `auto` in the production template and in the runner.

- `compression` — use the local compression-first path only.
- `auto` — start with compression-first, then escalate to multimodal Vertex only when the draft shows context, clarity, callback, transcript, source, or grounding problems.
- `multimodal` — start directly with the full multimodal Vertex path.

Default compression uses Vertex JSON generation unless `MIDFORM_COMPRESS_LLM=codex` is set as an explicit local fallback.

Auto escalation is intentionally narrow. These hard gate failures trigger escalation:

- `high_context_teaser_recovery` -> `high_context`
- `callback_strength` -> `weak_callback_recovery`
- `first_30_conflict_clarity` -> `weak_clarity`

Quality warnings also trigger escalation when their text/code matches context, clarity, callback, ground, transcript, or source problems.

These issues do **not** trigger multimodal escalation by themselves:

- `rebuttal_only_opener`
- `dramatic_engagement_timing`
- `rendered_speaker_color_match`
- `subtitle_readability`

Treat those as editorial, caption, or CapCut QA problems rather than evidence that the source needs multimodal re-analysis.

## Provider environment

For the default Vertex path, local/dev/prod must provide:

- `GOOGLE_CLOUD_PROJECT` or `GCLOUD_PROJECT` — required project id.
- Application Default Credentials with the `cloud-platform` scope — required for Vertex access tokens.

Optional Vertex settings:

- `GOOGLE_CLOUD_LOCATION` — defaults to `global`.
- `VERTEX_GEMINI_MODEL` — multimodal model override.
- `VERTEX_COMPRESS_MODEL` — compression JSON model override, defaults to `gemini-2.5-pro`.
- `GEMINI_VERTEX_ENDPOINT_OVERRIDE` — endpoint override for diagnostics only.

If the project env var is missing, runs fail before compression with `GOOGLE_CLOUD_PROJECT_REQUIRED`. For local API-free debugging, `MIDFORM_COMPRESS_LLM=codex` can exercise the compression path, but this is an opt-in fallback and still depends on a working Codex CLI account.

## Subtitle policy

Current production template runs require a usable timed YouTube subtitle track. If yt-dlp cannot fetch an English VTT, compression fails with `SUBTITLE_NOT_FOUND` and does not run STT fallback.

Recommended policy for now: exclude subtitle-less sources from normal production runs. If STT fallback is needed later, add it behind an explicit profile or flag rather than enabling it silently, because it adds provider cost, latency, and a second transcript-quality failure mode.

## Supported options

```bash
midform run --template <file>
midform run --template <file> --profile production
midform run --template <file> --profile audit
midform run --template <file> --source https://youtu.be/xxxx
midform run --template <file> --analysis-mode compression
midform run --template <file> --analysis-mode auto
midform run --template <file> --analysis-mode multimodal
midform run --template <file> --resume slot_fill
```

## Template roles

- `base.md` — minimal viable contract only.
- `standard.md` — example production-style contract.
- `advanced.md` — stricter audit-oriented example.
- `production_base.md` — neutral production scaffold with structure, generation rules, validation rules, and schema only.
- `now_you_see_me_interrogation_ko.md` — scene-specific Now You See Me interrogation template; not a reusable default.

## Required template fields

Only these YAML frontmatter fields are required:

- `source.url`
- `output.target_length_sec`

The markdown body is optional and acts as author guidance. In full-auto and batch mode, URL-specific template bodies are generated from that URL's evidence pack and written as `template_body.ko.md` and `template_body.ja.md` in the run workspace.

## Profiles

- `fast` — lighter proof generation, preview proof written as skipped.
- `production` — full draft, acceptance gates, and preview proof.
- `audit` — full draft with stricter proof emphasis and a higher preview sample count.

## Resume stages

- `ingest`
- `analysis`
- `slot_fill`
- `bootstrap`
- `draft`

Resume uses a stable workspace derived from the normalized request contract, so the same template plus overrides can continue from prior artifacts.

## Stable output artifacts

Each run workspace writes these root artifacts when the corresponding stage completes:

- `normalized_request.json`
- `generated_context.md`
- `narrative_beats.json`
- `story_beatmap.json`
- `edit_plan.json`
- `slot_map.json`
- `slot_qc_report.json`
- `script.json`
- `draft_input.json`
- `edit_manifest.json`
- `draft_content.json`
- `acceptance_gates.json`
- `human_qa_review.md`
- `preview_frame_proof.json`
- `run_summary.json`

`run_summary.json` includes `analysis_mode` and `analysis_run`. In `auto`, check `analysis_run.auto_escalation.reason_codes` to see why the runner stayed compression-first or moved to multimodal.

## CapCut render policy

- Use CapCut template mode by default.
- Use absolute audio paths by default; relative ZIP mode remains experimental because media can be missing on import.
- Use source clip placement, not archived process-title behavior.
- Preserve speaker-colored dialogue captions from `TEMPLATE_SUBTITLE`, including `text_effect` and `bloom` references.
- Keep the reusable 9:16 text layout preset: fixed title/subtitle overlays stay locked, caption units stay in the lower-third caption position.

## Failure behavior

If bootstrap preflight, pipeline execution, or acceptance gates fail, the CLI returns a structured machine-readable failure summary in `run_summary.json` and on stdout.

Do not patch around grounding failures by inventing story context. If auto escalates because source context is weak, use the multimodal result or reject the source material.

## Local verification

After changing runner code, templates, CapCut draft generation, or validation behavior, run:

```bash
npm run verify
```

This is API-free and covers encoding checks, JavaScript syntax checks, Python syntax checks, fixture validation, and unit tests.
