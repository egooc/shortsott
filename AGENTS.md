# Project Guardrails for Codex Agents

This repository is now a **midform-only movie-recap pipeline**. The previous 3분 오뚝이영상/Ottugi UI, process queue, YouTube upload, Virlo, and shortform-highlight paths were archived under `removed_ottugi_20260715/` during Phase 3 cleanup. Do not reintroduce those paths unless the user explicitly asks to restore them from the archive.

## Mandatory Encoding Rules

1. Save all source files as UTF-8.
2. Do not overwrite Korean/Japanese source files with PowerShell `Set-Content`, `Out-File`, or shell redirection.
3. For files containing Korean/Japanese text, edit with one of these only:
   - `apply_patch`
   - Node.js `fs.writeFileSync(file, text, 'utf8')`
   - Python `Path.write_text(text, encoding='utf-8')`
4. JSON writes must use `JSON.stringify(data, null, 2)` and `fs.writeFileSync(path, json + '\n', 'utf8')`.
5. If mojibake, replacement characters, or mass question-mark replacement appears in source, the task is incomplete.
6. Never hide broken Korean/Japanese text. Fix the source string or the encoding path.

## Required Verification Before Completion

After any code change, run:

```bash
npm run verify
```

`npm run verify` is API-free. It must include:

1. `npm run check:encoding`
2. `npm run verify:js`
3. `npm run verify:py`
4. `npm run verify:fixture`

If any command fails, keep fixing before reporting completion.

## Current Midform Pipeline

The active pipeline is a sealed local workflow for 60-180 second Korean movie-recap drafts:

```text
source video + yt-dlp metadata
-> STT transcript
-> preflight material gate
-> Gemini/Vertex midform scene analysis
-> Pass 0 movie research
-> slot map generation
-> GPT/Codex slot fill
-> TTS / caption-unit assembly
-> CapCut draft generation
-> fixture validation and reports
```

## Active Server Entrypoints

`server/index.js` is API-only. The registered routes are:

- `/api/health`
- `/output` static draft output
- `/api/settings`
- `/api/midform/gemini`
- `/api/midform/gpt`
- `/api/capcut`

`/api/midform/claude` remains on disk but is intentionally not registered. GPT/Codex is the primary script-generation path.

## Core Files

- `server/routes/gpt_midform.js`
- `server/routes/gemini_midform.js`
- `server/routes/capcut.js`
- `server/routes/settings.js`
- `server/services/gptMidformCliService.js`
- `server/services/geminiMidformService.js`
- `server/services/movieResearchService.js`
- `server/services/capcutService.js`
- `server/services/elevenlabsService.js`
- `server/services/srtGenerator.js`
- `server/services/midformSceneCondensationService.js`
- `server/utils/captionUnits.js`
- `server/utils/ffprobe.js`
- `server/utils/toolPaths.js`
- `scripts/capcut_draft.py`

## Midform Scripts

- `midform/scripts/preflight_material_gate.py`
- `midform/scripts/build_slot_map.py`
- `midform/scripts/assemble_slot_draft_input.py`
- `midform/scripts/validate_slot_draft.py`
- `midform/scripts/report_caption_balance.py`
- `midform/scripts/report_ending_distribution.py`
- `midform/scripts/report_slot_chunk_quality.py`
- `midform/scripts/report_slot_style_repair.py`

## Prompts, Schemas, and Fixtures

Prompts:

- `midform/prompts/gemini_analysis_midform.md`
- `midform/prompts/claude_script_midform.md`
- `midform/prompts/movie_midform_recap_review.md`

Schemas:

- `midform/schemas/gemini_response_schema.json`
- `midform/schemas/midform_script_schema.json`
- `midform/schemas/midform_slot_fills_schema.json`
- `midform/schemas/midform_story_outline_schema.json`
- `midform/schemas/midform_naturalization_validation_schema.json`

Fixtures to keep:

- `midform/test_runs/run_013_tVxYCeRXzGo_e2e/`
- `midform/test_runs/run_010_H9GPm8uG8Es_bucky_wakanda_raw/`
- `server/output/drafts/pipeline_1784045533/`

Archived older runs live under:

- `removed_ottugi_20260715/midform/test_runs_archive/`

## Gates and Validation

Key gates:

1. Preflight gate rejects unsuitable source material before Gemini.
2. Slot map material-fit gate checks usable range, dialogue density, selected quotes, and target duration.
3. GPT validators enforce grounded Korean narration, natural endings, no English fallback, source reference validity, and required dialogue-quote handling.
4. Draft validation checks slot order, caption order, warnings, excluded-range hits, speed bounds, and dialogue subranges.
5. Caption and ending reports are generated from the run_013 fixture during `npm run verify`.

## Do Not Reintroduce

1. Browser UI/client build as a required verify step.
2. `check:shortform-highlight` in `npm run verify`.
3. Process queue, Virlo, YouTube upload, highlight-pattern, or old generic Gemini/Claude/ElevenLabs routes in `server/index.js`.
4. Startup recovery for archived process/highlight jobs.
5. English fallback captions for Korean/Japanese draft generation.
6. `TEMPLATE_PROCESS_TITLE` or `process_title` text track behavior.
