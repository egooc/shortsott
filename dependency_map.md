# Midform Dependency Map — Phase 1/2 Audit

Generated: 2026-07-15  
Scope: dependency tracing and safety classification only. No files were deleted or moved.

## Executive summary

This repository currently contains two overlapping products:

1. **Midform movie-recap pipeline** — the active path used by the recent `run_013` work.
2. **Ottugi / process-shortform pipeline** — still registered in `server/index.js` and heavily represented in `client/`, `server/services/process*`, `queue/`, templates, reports, and verification scripts.

Important distinction:

- **Midform-only execution path** does not need most Ottugi process routes/services.
- **Current server startup path** still loads Ottugi modules because `server/index.js` requires and registers all routes up front, and also calls process/highlight recovery on startup.

Therefore, many files are **not safe to delete yet** even if they are not part of the intended midform-only product. They first need `server/index.js`, `client`, and `npm run verify` to be re-scoped in Phase 3.

## Method used

- Static trace from the requested entrypoints:
  - `server/index.js`
  - `server/routes/gpt_midform.js`
  - `server/routes/gemini_midform.js`
  - `server/routes/claude_midform.js`
  - `server/services/gptMidformCliService.js`
  - `server/services/geminiMidformService.js`
  - `server/services/movieResearchService.js`
  - `server/services/claudeMidformService.js`
  - `midform/scripts/*.{py,js}`
  - `scripts/capcut_draft.py`
- AST/grep checks for `require(...)`, Python imports, subprocess calls, route registrations, and client API calls.
- Runtime artifact check from final run:
  - `server/output/drafts/pipeline_1784045533/edit_manifest.json`
  - `midform/test_runs/run_013_tVxYCeRXzGo_e2e/draft_input_signature_quotes.json`
  - `midform/test_runs/run_013_tVxYCeRXzGo_e2e/*signature*` reports.
- Package/config check:
  - root `package.json`
  - `server/package.json`
  - `client/package.json`
  - `config/`
  - `server/config/`
  - `.env` / `.env.example` presence only; secret values were not copied into this report.

Background agents were launched as requested. The two local `explore` agents completed but returned no usable assistant/tool output, so this map is grounded in direct inspection.

## Phase 1-A: midform entrypoint trace

### Server entrypoint as currently implemented

`server/index.js` currently registers both midform and Ottugi routes:

| Route mount | File | Classification | Reason |
|---|---|---|---|
| `/api/health` | `server/index.js` | USED | Health check required for local server validation. |
| `/output` static | `server/output/` | SHARED | Midform draft downloads and legacy outputs both use this tree. |
| `/api/midform/gemini` | `server/routes/gemini_midform.js` | USED | Midform Gemini entrypoint. |
| `/api/midform/claude` | `server/routes/claude_midform.js` | USED-OPTIONAL | Midform Claude route exists; GPT/Codex route is the active recent path. |
| `/api/midform/gpt` | `server/routes/gpt_midform.js` | USED | Active run_013-style script/TTS/draft path. |
| `/api/capcut` | `server/routes/capcut.js` | SHARED | Direct draft route wraps `capcutService`; midform uses `capcutService` too. |
| `/api/settings` | `server/routes/settings.js` | SHARED | Settings include midform-relevant API/tool settings, but also legacy Virlo/YouTube/Ottugi settings. |
| `/api/gemini` | `server/routes/gemini.js` | UNUSED for midform-only | Legacy Gemini route used by old client pages, not `run_013` midform path. |
| `/api/claude` | `server/routes/claude.js` | UNUSED for active GPT-midform | Old Claude route and template flow. |
| `/api/elevenlabs` | `server/routes/elevenlabs.js` | SHARED/LEGACY | `gpt_midform.js` reuses `elevenlabsService`, but active standalone route is old UI path. |
| `/api/virlo` | `server/routes/virlo.js` | UNUSED for midform-only | Virlo discovery is outside the current midform run path. |
| `/api/process-queue` | `server/routes/processQueue.js` | Ottugi/current-app SHARED until re-scope | This is the 3분 오뚝이영상 batch pipeline, not midform-only. Still loaded at startup. |
| `/api/youtube` | `server/routes/youtube.js` | Ottugi/current-app SHARED until re-scope | Phase 1 source discovery for Ottugi/current app, not midform-only. |
| `/api/youtube-upload` | `server/routes/youtubeUpload.js` | Ottugi/current-app SHARED until re-scope | Phase 3 upload path for current app, not midform-only. |
| `/api/highlight-patterns` | `server/routes/highlightPatterns.js` | UNUSED for midform-only | Highlight pattern research/AB flow; loaded at startup. |

Startup side effects:

- `ensureProjectFolders()` from `server/services/pipelinePaths.js` runs on startup.
- `recoverProcessJobsOnStartup()` from `server/services/processJobService.js` runs when the server starts.
- `recoverHighlightPatternsOnStartup()` from `server/services/highlightPatternService.js` runs when the server starts.

So in the **current app**, process/highlight services are runtime-loaded even if the user only wants midform.

### Active GPT-midform route graph

Entrypoint: `server/routes/gpt_midform.js`

Direct local dependencies:

- `server/middleware/auth.js`
- `server/services/gptMidformCliService.js`
- `server/services/elevenlabsService.js`
- `server/services/srtGenerator.js`
- `server/utils/captionUnits.js`
- `server/services/capcutService.js`
- `server/services/movieResearchService.js`

Indirect local dependencies:

- `server/services/errorService.js`
- `server/services/midformSceneCondensationService.js`
- `server/utils/ffprobe.js`
- `server/utils/toolPaths.js`
- `scripts/capcut_draft.py`
- `templates/capcut/channel_default/**`
- `midform/schemas/midform_script_schema.json`
- `midform/schemas/midform_slot_fills_schema.json`
- `midform/schemas/midform_story_outline_schema.json`
- `midform/schemas/midform_naturalization_validation_schema.json`
- `midform/work/gpt_cli/**` runtime prompts/outputs
- `server/output/tts/**` runtime TTS outputs
- `server/output/drafts/**` runtime draft outputs

External commands/services:

- Codex/GPT CLI through `child_process.spawn` in `gptMidformCliService.js`.
- Edge/ElevenLabs-style TTS through `elevenlabsService.js` for server route TTS; the local Python assembler uses `edge_tts` directly.
- Python through `capcutService.js` → `scripts/capcut_draft.py`.
- `ffprobe` through `server/utils/ffprobe.js`.

### Gemini-midform route graph

Entrypoint: `server/routes/gemini_midform.js`

Direct local dependencies:

- `server/services/geminiMidformService.js`

Indirect local dependencies:

- `server/utils/ffprobe.js`
- `server/utils/toolPaths.js`
- `midform/prompts/gemini_analysis_midform.md`
- `midform/schemas/gemini_response_schema.json`
- `midform/analysis/**` runtime uploads/results

External commands/services:

- Google Vertex ADC / Gemini API through `google-auth-library`.
- `ffmpeg` chunk extraction through `child_process.execFile`.
- `ffprobe` metadata extraction.

### Claude-midform route graph

Entrypoint: `server/routes/claude_midform.js`

Direct local dependencies:

- `server/services/claudeMidformService.js`

Indirect local dependencies:

- `server/services/errorService.js`
- `server/services/midformSceneCondensationService.js`
- `midform/prompts/claude_script_midform.md`
- `midform/scripts_generated/**` runtime outputs

External dependency:

- `@anthropic-ai/sdk`, loaded dynamically inside `claudeMidformService.js`.

Status: **USED-OPTIONAL**. This route exists and is wired, but the recent successful run used GPT/Codex slot fill rather than this Claude route.

### CapCut draft graph

Entrypoints:

- `server/services/capcutService.js`
- `server/routes/capcut.js`
- direct CLI calls to `scripts/capcut_draft.py`

Direct dependencies:

- `server/utils/toolPaths.js`
- `server/services/errorService.js`
- `scripts/capcut_draft.py`
- `templates/capcut/channel_default/**` for midform template clone mode
- `templates/capcut/process_default/**` for Ottugi process mode

Modes in `scripts/capcut_draft.py`:

- Midform path: source clips, fixed midform overlays, `TEMPLATE_PRETITLE`, `TEMPLATE_TITLE`, `TEMPLATE_SUBTITLE`, `TEMPLATE_MOVIE_TITLE`.
- Ottugi/process path: `editMode: ultra_efficiency_process`, process captions, full/highlight variants, OCR masks, process template markers.

Classification: **SHARED**. This file is a core example of “Ottugi code that midform also uses.” It should not be removed; it should be split or ownership-renamed only after tests cover both desired midform behavior and removed Ottugi behavior.

## Phase 1-A: Python and script trace

### `midform/scripts/*.py` and `*.js`

| File | Classification | Dependencies / invoked tools | Notes |
|---|---|---|---|
| `midform/scripts/preflight_material_gate.py` | USED | stdlib only | Pre-Gemini source suitability gate. |
| `midform/scripts/build_slot_map.py` | USED | stdlib + `ffprobe` subprocess | Builds slot map; used for dialogue-heavy signature quotes. |
| `midform/scripts/assemble_slot_draft_input.py` | USED | stdlib + `edge_tts` + `ffprobe` subprocess | Builds TTS and CapCut input from slot-filled script. |
| `midform/scripts/validate_slot_draft.py` | USED | stdlib only | Intended verify-chain candidate for slot-map draft validation. |
| `midform/scripts/report_caption_balance.py` | USED | stdlib only | Reporting/verification helper. |
| `midform/scripts/report_ending_distribution.py` | USED | stdlib only | Used in final run_013 reporting. |
| `midform/scripts/report_slot_chunk_quality.py` | USED-SUPPORT | stdlib only | Quality report helper for slot outputs. |
| `midform/scripts/report_slot_style_repair.py` | USED-SUPPORT | stdlib only | Style-repair report helper. |
| `midform/scripts/repair_story_anchor_retry.py` | USED-SUPPORT | stdlib + `edge_tts` + `ffprobe` subprocess | Repair/regeneration helper; not in final run_013 path but part of current midform toolbox. |
| `midform/scripts/condense_scene_beats.js` | USED-SUPPORT | Node stdlib / midform JSON | Scene condensation helper. |
| `midform/scripts/validate_phase_d.js` | LEGACY-MIDFORM | Node validation helper | From older Phase D workflow; not used by run_013. |
| `midform/scripts/run_schema_probe.js` | LEGACY-MIDFORM | Node/Gemini probe helper | Test/probe artifact, not production path. |

### Root `scripts/*.py`

| File | Classification | Reason |
|---|---|---|
| `scripts/capcut_draft.py` | SHARED | Midform draft generation and Ottugi process generation both call this. |
| `scripts/transcribe_source.py` | USED | STT helper for midform sealed runs. |
| `scripts/youtube_download_pytubefix.py` | SHARED | Used by `youtubeDownloadService.js`, mostly source-discovery/process queue. Could remain if midform keeps YouTube-source downloads. |
| `scripts/detect_text_regions.py` | Ottugi/process SHARED until re-scope | OCR/mask helper for process draft features; not needed by current midform path. |

## Phase 1-B: runtime artifact trace

Final successful run:

- Run folder: `midform/test_runs/run_013_tVxYCeRXzGo_e2e`
- Final script: `script_signature_quotes.json`
- TTS/draft input: `draft_input_signature_quotes.json`
- Draft: `server/output/drafts/pipeline_1784045533`
- SRT: `server/output/drafts/pipeline_1784045533/subtitles/subtitles.srt`

Runtime artifact evidence:

- `edit_manifest.json` recorded:
  - `audio_path_mode: absolute`
  - `video_placement_mode: source_clips`
  - `capcut_template_used: true`
  - template path under `templates/capcut/channel_default/...`
  - midform markers: `TEMPLATE_MOVIE_TITLE`, `TEMPLATE_PRETITLE`, `TEMPLATE_SUBTITLE`, `TEMPLATE_TITLE`
- `draft_input_signature_quotes.json` recorded:
  - `gemini_analysis_path`
  - `script_path`
  - `script_input_path`
  - `source_video_path`
  - `source_transcript_path`
  - caption units and TTS file paths

Notably, `edit_manifest.json` does **not** currently store the original `script_input_path`; that provenance is present in the pre-CapCut draft input instead.

## USED files/folders for midform-only pipeline

These are required by the active or intended midform-only path.

### Server and service code

- `server/index.js` — currently the only Express entrypoint; must be edited before legacy routes can be removed.
- `server/routes/gpt_midform.js`
- `server/routes/gemini_midform.js`
- `server/routes/claude_midform.js` — optional but still a declared midform entrypoint.
- `server/routes/capcut.js` — direct CapCut utility route.
- `server/routes/settings.js` — needs pruning, but settings infrastructure is still needed.
- `server/services/gptMidformCliService.js`
- `server/services/geminiMidformService.js`
- `server/services/claudeMidformService.js`
- `server/services/movieResearchService.js`
- `server/services/midformSceneCondensationService.js`
- `server/services/capcutService.js`
- `server/services/elevenlabsService.js` — route-level GPT-midform TTS currently imports it.
- `server/services/srtGenerator.js`
- `server/services/pipelinePaths.js`
- `server/services/errorService.js`
- `server/services/envService.js`
- `server/middleware/auth.js`
- `server/utils/captionUnits.js`
- `server/utils/ffprobe.js`
- `server/utils/toolPaths.js`

### Midform domain assets

- `midform/prompts/gemini_analysis_midform.md`
- `midform/prompts/claude_script_midform.md`
- `midform/prompts/movie_midform_recap_review.md` if review route remains.
- `midform/prompts/README.md`
- `midform/schemas/gemini_response_schema.json`
- `midform/schemas/midform_script_schema.json`
- `midform/schemas/midform_slot_fills_schema.json`
- `midform/schemas/midform_story_outline_schema.json`
- `midform/schemas/midform_naturalization_validation_schema.json`
- `midform/scripts/preflight_material_gate.py`
- `midform/scripts/build_slot_map.py`
- `midform/scripts/assemble_slot_draft_input.py`
- `midform/scripts/validate_slot_draft.py`
- `midform/scripts/report_caption_balance.py`
- `midform/scripts/report_ending_distribution.py`
- `midform/scripts/report_slot_chunk_quality.py`
- `midform/scripts/report_slot_style_repair.py`
- `midform/scripts/repair_story_anchor_retry.py`
- `midform/scripts/condense_scene_beats.js`

### Draft/runtime assets

- `scripts/capcut_draft.py`
- `scripts/transcribe_source.py`
- `templates/capcut/channel_default/**`
- `server/output/drafts/**` runtime output; not source, but required for local inspection/download while active.
- `server/output/tts/**` runtime output; can be cleaned as data, not code.
- `midform/work/gpt_cli/**` runtime GPT prompt/output logs; useful audit artifacts, cleanable by age.
- `midform/test_runs/run_013_tVxYCeRXzGo_e2e/**` current reference run; keep until Phase 3 migration is verified.

## SHARED files/folders — Ottugi code also used by midform

These are deletion blockers. They answer “how far midform still uses the copied Ottugi pipeline.”

| File/folder | Midform use point | Ottugi/process use point | Recommendation |
|---|---|---|---|
| `scripts/capcut_draft.py` | `capcutService.generateDraft()` and direct sealed-run CLI calls. | `generateProcessDraft()` / `editMode: ultra_efficiency_process`. | Split into `midform_capcut_draft.py` and process draft module, or keep as shared engine. |
| `server/services/capcutService.js` | GPT-midform draft generation. | Process queue draft generation. | Keep; split exported process methods later if removing Ottugi. |
| `templates/capcut/channel_default/**` | Midform template clone markers. | Also historically used by legacy/midform routes. | Keep for midform. |
| `server/services/elevenlabsService.js` | Imported by `gpt_midform.js` for `/tts`. | Old ElevenLabs route and Phase 4 page. | If Python `edge_tts` becomes sole path, this can be removed later; not yet. |
| `server/utils/ffprobe.js` | Gemini-midform metadata and TTS audio durations. | Process/shortform metadata. | Keep as shared utility. |
| `server/utils/toolPaths.js` | Python/ffmpeg/ffprobe lookup. | Process render/download paths. | Keep as shared utility. |
| `server/services/pipelinePaths.js` | Project root/path helpers. | Process queue and legacy routes. | Keep; prune path constants later. |
| `server/routes/settings.js` + `server/services/envService.js` | API keys/tool settings still needed. | Includes Virlo/YouTube/Ottugi-specific tests/settings. | Keep but prune UI/API keys in Phase 3. |
| `scripts/youtube_download_pytubefix.py` + `server/services/youtubeDownloadService.js` | Potential source-download dependency if midform downloads YouTube locally. | Process queue source import/download. | Keep only if midform retains YouTube download support. |

## UNUSED / removal candidates for midform-only

These are candidates only. Do not delete until `server/index.js`, `client`, and verify chain are re-scoped.

### Strong midform-only removal candidates

| File/folder | Classification | Evidence | Removal impact |
|---|---|---|---|
| `server/routes/virlo.js` | UNUSED for midform-only | No midform route depends on Virlo; client `OttogiSourceDiscovery.jsx` uses it. | Breaks old Virlo discovery page only. |
| `server/services/virloService.js` | UNUSED for midform-only | Required by Virlo route/settings test only. | Remove after settings prune. |
| `server/services/virloDataService.js` | UNUSED for midform-only | Required by Virlo route and old client service. | Breaks Virlo data pages. |
| `chrome-extension/youtube-source-scout/**` | UNUSED for midform-only | Separate scout extension, not imported by server/client app. | Removes external scout helper. |
| `scripts/check-shortform-highlight-contract.js` | UNUSED/verify blocker | Root `npm run verify` still calls `check:shortform-highlight`. | Must replace verify chain before removal. |
| `server/routes/highlightPatterns.js` | UNUSED for midform-only | Client `HighlightPatternAnalysis.jsx` only. | Remove after route unregister and client page removal. |
| `server/services/highlightPatternService.js` | UNUSED for midform-only | Startup recovery currently loads it. | Must remove startup recovery first. |
| `server/services/highlightPatternDbService.js` | UNUSED for midform-only | Highlight service/AB only. | Remove with highlight routes. |
| `server/services/highlightSlicerService.js` | UNUSED for midform-only | Highlight pattern slicing only. | Remove with highlight routes. |
| `server/services/abExperimentService.js` | UNUSED for midform-only | Highlight AB endpoints only. | Remove with highlight routes. |
| `server/utils/abStats.js` | UNUSED for midform-only | AB service only. | Remove with AB/highlight features. |
| `server/config/cutSelectionProfile.json` | UNUSED for midform-only | Highlight slicer/process selection. | Remove after process/highlight removal. |

### Ottugi/process queue candidates

These are not part of the midform-only sealed run, but they are the current 3분 오뚝이영상 app path and are actively loaded by `server/index.js` today.

| File/folder | Classification | Evidence | Removal impact |
|---|---|---|---|
| `server/routes/processQueue.js` | UNUSED for midform-only / current Ottugi app | Client `Phase5Draft.jsx` calls `/process-queue/jobs/start`. | Removes batch draft creation UI. |
| `server/services/processQueueService.js` | UNUSED for midform-only / current Ottugi app | Process queue route and worker. | Breaks batch jobs. |
| `server/services/processJobService.js` | UNUSED for midform-only / current Ottugi app | Startup recovery runs it. | Must remove recovery and workers first. |
| `server/services/processJobDbService.js` | UNUSED for midform-only / current Ottugi app | Job DB persistence. | Breaks pending/completed job state. |
| `server/services/processEditService.js` | UNUSED for midform-only / current Ottugi app | Calls `generateProcessDraft`. | Breaks process draft building. |
| `server/services/processMetadataService.js` | UNUSED for midform-only / current Ottugi app | Metadata/Gemini process path, settings tests. | Remove only after settings prune. |
| `server/services/processRenderService.js` | UNUSED for midform-only / current Ottugi app | Final MP4 render helper. | Breaks render/export. |
| `server/services/capcutExportService.js` | UNUSED for midform-only / current Ottugi app | Process queue export request. | Breaks CapCut export automation. |
| `server/workers/processJobWorker.js` | UNUSED for midform-only / current Ottugi app | Worker for process jobs. | Remove with process queue. |
| `config/process_edit_config.json` | UNUSED for midform-only / current Ottugi app | Process config. | Remove with process queue. |
| `templates/capcut/process_default/**` | UNUSED for midform-only / current Ottugi app | Process-specific template markers. | Remove only after process mode removal from `capcut_draft.py`. |
| `assets/bgm/process/**` | UNUSED for midform-only / current Ottugi app | Process BGM assets. | Remove with process drafts. |
| `queue/process/**` | Data residue / current Ottugi app state | Large source_clean.mp4 files and job outputs. | Move to backup first; huge size win. |

### Old generic recap route candidates

| File/folder | Classification | Evidence | Removal impact |
|---|---|---|---|
| `server/routes/gemini.js` | LEGACY-MIDFORM | Client `Phase2Analysis.jsx` calls `/gemini/analyze`; active route is `/midform/gemini`. | Breaks old phase UI. |
| `server/routes/claude.js` | LEGACY-MIDFORM | Client `Phase3Script.jsx` calls `/claude/generate-script`; active run used `/midform/gpt`. | Breaks old Claude flow. |
| `server/routes/elevenlabs.js` | LEGACY-MIDFORM route | Client `Phase4TTS.jsx` calls `/elevenlabs/*`; GPT route can call service directly. | Breaks old TTS UI. |
| `server/services/geminiService.js` | LEGACY/PROCESS | Generic Gemini + process metadata helpers. | Remove only after process route removal. |
| `server/services/claudeService.js` | LEGACY-MIDFORM | Old Claude JSON generation. | Remove after `/api/claude` route removal. |
| `server/services/claudeCliService.js` | LEGACY-MIDFORM | Old Claude CLI path. | Remove after old Claude route/script removal. |
| `server/services/claudeTemplateService.js` | LEGACY-MIDFORM | Old Claude templates route. | Remove after old Claude route removal. |
| `prompts/claude_templates/**` | LEGACY-MIDFORM | Old Claude route/template flow. | Remove with old Claude route. |
| `scripts/generate-claude-midform.js` | LEGACY-MIDFORM | Root package script `generate:claude`. | Remove script and package entry together. |

### Client classification

Current `npm run build` builds all of `client/`, so the client is not removable until verify/build is redefined.

Client API evidence:

- `Settings.jsx` uses `/settings` and `/youtube-upload/oauth-url`.
- `OttogiSourceDiscovery.jsx` uses `/youtube/*` and `/process-queue/import-source-urls`.
- `Phase5Draft.jsx` uses `/process-queue/jobs/*` and midform draft controls.
- `OttogiUpload.jsx` uses upload/matching concepts.
- `HighlightPatternAnalysis.jsx` uses `/highlight-patterns`.
- `Phase2Analysis.jsx`, `Phase3Script.jsx`, `Phase4TTS.jsx` use old `/gemini`, `/claude`, `/elevenlabs`, and `/midform/gpt` routes.

Recommendation:

- If the repository becomes **headless sealed-run midform**, `client/` can move to UNUSED after replacing `npm run build` in `verify`.
- If the repository keeps a **local UI for midform**, keep `client/` but remove/rewrite old Ottugi/legacy pages and route links.

### Data/artifact cleanup candidates

These should be moved to `removed_ottugi_20260715/` during Phase 3, not deleted immediately.

| Folder/file pattern | Classification | Notes |
|---|---|---|
| `queue/process/**` | Ottugi data residue | Dominates repo size; multiple large `source_clean.mp4` files. |
| `server/data/process_jobs.db` | Ottugi job DB | Large DB; only needed for process queue recovery. |
| `work/virlo_*` | Virlo residue | Debug/probe outputs. |
| `work/process_*` | Ottugi process residue | Queue/draft experiments. |
| `input/*_source.mp4`, `input/source_clean.mp4` | Mixed data residue | Keep only if referenced by active tests. |
| `analysis/gemini_analysis*.json`, `analysis/gemini_review*.json` | Old generic recap residue | Not current run_013 path. |
| `dist/**` | Build/package residue | Can usually be regenerated. |
| `.tools/google-cloud-sdk/**` | Local tool install | Keep only if this repo intentionally vendors gcloud. |
| `*.md` report files named `PROCESS_*`, `PHASE1_*`, `OTTOGI_*`, `YOUTUBE_UPLOAD_*`, etc. | Documentation residue | Move to archive/backup unless needed as project history. |
| `midform/test_runs/run_001` through older run folders | Midform test residue | Keep `run_013` until migration is stable; archive older runs by policy. |

Repo size snapshot excluding `.git`, `node_modules`, `dist`, `.tools`, `.octo-tmp`:

- Files scanned: `7230`
- Size: `11409.38 MB`
- Largest cleanup wins include `queue/process/item_025/source_clean.mp4` at about `1258 MB`, `queue/process/item_026/source_clean.mp4` at about `648 MB`, and `server/data/process_jobs.db` at about `165 MB`.

## Phase 2 checks

### package.json script blockers

Root scripts currently include:

- `build`: `cd client && npm run build`
- `generate:claude`: `node scripts/generate-claude-midform.js`
- `check:encoding`: `node scripts/check-encoding.js`
- `check:shortform-highlight`: `node scripts/check-shortform-highlight-contract.js`
- `verify`: `npm run check:encoding && npm run check:shortform-highlight && npm run build`

Blockers:

1. `check:shortform-highlight` is Ottugi/shortform-specific and must be removed or replaced before `scripts/check-shortform-highlight-contract.js` can move.
2. `build` forces `client/` to remain buildable.
3. `generate:claude` references old Claude-midform script flow.

Recommended new verify chain for midform-only Phase 3:

```text
npm run check:encoding
node --check server/services/gptMidformCliService.js
node --check server/routes/gpt_midform.js
node --check server/routes/gemini_midform.js
node --check server/services/geminiMidformService.js
python -m py_compile midform/scripts/preflight_material_gate.py
python -m py_compile midform/scripts/build_slot_map.py
python -m py_compile midform/scripts/assemble_slot_draft_input.py
python -m py_compile midform/scripts/validate_slot_draft.py
python -m py_compile scripts/capcut_draft.py
python midform/scripts/validate_slot_draft.py --manifest <known-manifest> --slot-map <known-slot-map> --transcript <known-transcript>
python midform/scripts/report_caption_balance.py ...
python midform/scripts/report_ending_distribution.py ...
```

Use concrete fixture paths from `run_013` or a trimmed fixture folder. Avoid API calls in verify.

### config/environment blockers

- `.env` and `.env.example` exist. They are not copied here because they may contain secrets.
- Settings code still references Virlo, Claude, Vertex, YouTube OAuth, and upload-related keys.
- Before removing legacy routes, settings UI/API must be pruned so it only exposes midform-required keys.

### Client blocker

The client is currently a mixture of:

- old generic movie-recap phases (`Phase2Analysis`, `Phase3Script`, `Phase4TTS`),
- Ottugi/source-discovery/upload/process pages (`OttogiSourceDiscovery`, `Phase5Draft`, `OttogiUpload`),
- midform-specific controls embedded inside `Phase5Draft` and `Phase4TTS`.

Do not delete `client/` while root `npm run build` remains part of verify.

### Runtime-output blocker

`server/output/drafts/pipeline_1784045533` is the latest successful proof artifact. Keep it until the Phase 3 re-scope can regenerate or reassemble the draft from existing run_013 inputs.

## Phase 3 removal plan — not executed

Required approval before executing:

1. Create backup/move root: `removed_ottugi_20260715/`.
2. Move, do not delete, UNUSED/Ottugi-only files and folders.
3. Edit `server/index.js` so only midform-needed routes are registered.
4. Remove startup recovery for process/highlight jobs.
5. Redefine `npm run verify` to midform-only checks.
6. Decide client strategy:
   - remove client from verify and archive it, or
   - rewrite client to midform-only before removing legacy routes.
7. Re-run validation:
   - server start + `/api/health`
   - run_013 draft reassembly from existing artifacts, no external API calls
   - new verify chain

## Open decisions for user confirmation before Phase 3

1. Is this repo now intended to be **midform-only**, even though `AGENTS.md` still describes the 3분 오뚝이영상 three-phase product contract?
2. Should `client/` be archived entirely, or rewritten into a small midform-only UI?
3. Should `scripts/capcut_draft.py` be split so midform stops carrying process/shortform template code?
4. Which run folders are fixtures to keep? Minimum recommendation: keep `run_013_tVxYCeRXzGo_e2e` and archive older runs.
