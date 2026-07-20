# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local (Electron-packageable) app for **3분 오뚝이영상**: it turns foreign short-form process/manufacturing videos into Korean/Japanese CapCut drafts and automates the YouTube upload. Not a generic content pipeline — see "Product scope" below before adding features.

Stack: React + Vite + Tailwind (client) / Express (server) / zustand (client state) / better-sqlite3 (job persistence) / ffmpeg-ffprobe + Python (`scripts/capcut_draft.py`, pyCapCut) for CapCut draft generation.

## Commands

```bash
npm run dev              # clears ports 3001, 5173-5176, then runs server+client concurrently
npm run build             # client production build only (cd client && vite build)
npm run start             # runs server/index.js directly (serves client/dist as static)
npm run electron          # build + launch Electron shell
npm run dist:win          # build + electron-builder portable exe

npm run check:encoding              # scans for mojibake/broken KR/JP text (see Encoding rules)
npm run check:shortform-highlight   # string-contract test guarding highlight-draft behavior
npm run verify                      # check:encoding && check:shortform-highlight && build — REQUIRED after any change
```

There is no unit test framework (no jest/mocha). "Tests" are plain Node scripts under `scripts/` that assert specific strings exist/don't exist in specific files (see `scripts/check-shortform-highlight-contract.js`) — a regression guard against previously-fixed bugs recurring. When changing behavior those scripts assert on, update the assertions, don't just make them pass superficially.

`client/` and `server/` have their own `package.json`s and `node_modules`; root `npm install` does not install them (see README Quick Start — install in all three).

## Mandatory encoding rules (from AGENTS.md)

The product is Korean/Japanese-text-heavy; mojibake is treated as a release blocker.

1. All source files UTF-8.
2. Never overwrite KR/JP-containing files with PowerShell `Set-Content`/`Out-File`/shell redirection.
3. Edit KR/JP text files only with: `apply_patch`, Node `fs.writeFileSync(file, text, 'utf8')`, or Python `Path.write_text(text, encoding='utf-8')`.
4. JSON writes: `JSON.stringify(data, null, 2)` then `fs.writeFileSync(path, json + '\n', 'utf8')` (see `server/services/pipelinePaths.js: writeJsonWithBackup`, the shared helper for this).
5. Any mojibake/replacement-char/mass-question-mark output means the task is incomplete — fix the source or encoding path, never hide it in the UI.
6. Run `npm run check:encoding` first when touching anything text-related; run `npm run verify` before reporting completion.

## Product scope — two generations of workflow coexist

This repo currently contains **two overlapping pipeline generations**. Know which one you're touching before editing (check `git log`/recent diffs — the newer one is under active migration).

**Newer workflow (authoritative — see AGENTS.md in full for per-phase rules):**
- Settings → **Phase 1 소재 발굴** (`OttogiSourceDiscovery.jsx`, YouTube search/filter) → URL basket → **Phase 2 배치 드래프트 생성** (`processQueue*`, `youtube*` routes/services: download, Gemini/Vertex analysis, CapCut draft folder generation, metadata TXT) → manual CapCut export → **Phase 3 YouTube 자동 업로드** (`OttogiUpload.jsx`, `youtubeUpload*`).
- Core rule: **one source video must produce 4 channel variants**: `JP Full`, `JP Highlight`, `KR Full`, `KR Highlight` — each with its own script/subtitles/title/description/hashtags/BGM/logo, not copies with only language swapped.
  - Full: process-explanation video, one short caption per cut, subtitle timing matches cut timeline.
  - Highlight: <10s strongest visual-hook moment, single ~200-char explainer block (not per-cut captions).
- Draft variant modes are `full` / `highlight` / `midform` (see `normalizeDraftVariantMode` in `processJobService.js`); `full_highlight_only` auto-promotes when `highlight_only` is requested on a **longform** source (`isLongformQueueItemConfig`) — shortform highlight must stay `highlight_only` (enforced by `check:shortform-highlight`).
- Draft folder naming: `YYYYMMDD-F_or_H_or_M-HHMMSS-title`, no hashtags, no batch item number. `upload_title` is metadata only, never a CapCut text overlay.
- Do-not-reintroduce list (regressions fixed before): `TEMPLATE_PROCESS_TITLE` / `process_title` text track, upload-title-as-screen-text, English fallback captions for JP/KR, uploading Korean review-only text to YouTube descriptions, duplicate browser-side processing buttons when a server job already exists.

**Older/legacy workflow (README.md; still present in `Phase1Search.jsx`..`Phase5Draft.jsx`, `virlo`/`gemini`/`claude`/`elevenlabs`/`capcut` routes):** Virlo source discovery → Gemini analysis (`analysis/gemini_analysis.json`) → **Phase 2.5 Gemini Review Gate** (`analysis/gemini_review.json`; Phase 3 is blocked with 400 `GEMINI_ANALYSIS_NOT_APPROVED` until `status === "approved"` and all `checks` pass) → Claude script generation (`script/claude_midform_story.json`) → TTS/SRT via ElevenLabs, split into **caption units** (1 caption unit = 1 TTS mp3 = 1 subtitle segment, e.g. `seg_001_cap_001.mp3`) → CapCut draft ZIP (absolute-path mode `recommendedZip` is the only reliable one; relative-path ZIP can lose audio media in CapCut).
- CapCut template markers (`templates/capcut/channel_default/`): `TEMPLATE_PRETITLE`, `TEMPLATE_TITLE`, `TEMPLATE_SUBTITLE`, `TEMPLATE_MOVIE_TITLE` — must exist as real text objects in the template draft for clone-mode style/effect inheritance to work.

When adding UI, confirm which phase owns a feature and don't duplicate another phase's responsibility (e.g., no CapCut generation from Phase 1, no YouTube upload from Phase 2).

## Production highlight path — do not modify without explicit approval

`server/services/processQueueService.js`'s highlight window selection
(`pickHighlightWindow`, `collectHighlightCandidateWindows`,
`selectBestHighlightWindow`, `getDefaultLongformHighlightWindows`, and the
`SHORTFORM_HIGHLIGHT_MAX_DURATION_SEC` / `LONGFORM_HIGHLIGHT_MAX_DURATION_SEC`
constants) plus `scripts/capcut_draft.py`'s draft assembly are a verified,
revenue-producing system. **Do not add new selection strategies, "improve"
the scoring, or change these duration constants without the user's explicit
sign-off in the conversation.** A prior session built new selectors
(`pickProductionHighlightWindow`, loop-complete/result-reveal completion
windows) directly on top of this path in an uncommitted working tree; it
silently changed output behavior for weeks before anyone noticed, and had
to be reverted line-by-line back to a known-good commit (see
`docs/highlight-window-selector-revert-2026-07-21.md`). If a change to this
path seems warranted, propose it and wait for confirmation before editing.

## Isolate experimental code from production paths

New research/experimental logic (e.g. the Highlight Pattern study in
`highlightSlicerService.js`, `highlightPatternDbService.js`,
`abExperimentService.js`, the `/api/highlight-patterns` route, and the
`trackb-*` scripts — see `docs/trackb_preregistration_restored_control_2026-07-20.md`
and the pre-registered H1/H2/H3 hypotheses) must live in its own
service/route/script files and must not be wired into the production
highlight or full-draft paths (`processQueueService.js`,
`processMetadataService.js`, `capcutService.js`). It's fine for
experimental code to reuse a production helper (e.g. `extractActionTimeline`)
read-only; it must never become a dependency the production path calls.

## Completion reports must quote source, not summarize

When reporting a batch/draft generation task as complete, quote the actual
values read back from the generated `edit_manifest.json` / `draft_content.json`
— segment counts per track, the selected window's `start_sec`/`end_sec`,
`selection_strategy`/`reason`, `selected_scene_ids`. A summary without a
quoted value from the real output file is not a valid completion report;
re-open the file and quote it before reporting done.

## Commit each unit of work — don't let it pile up uncommitted

Land each logical change as its own commit as soon as it's verified working,
instead of leaving it in an uncommitted working tree while more work stacks
on top. The 2026-07-21 highlight regression above happened specifically
because a known-good state only existed as an uncommitted working tree,
so later changes silently piled on top of it with no point to diff against
or revert to. Group commits by logical unit (e.g. "highlight selection
restore" separate from "full-draft repair pipeline" separate from
"auth/infra" separate from "isolated experimental code") rather than one
mixed commit — this keeps future `git diff <good-commit>` audits meaningful.

## Architecture

**Server** (`server/index.js`): Express app mounting one router per domain under `/api/*` — `settings`, `virlo`, `gemini`, `claude`, `elevenlabs`, `capcut`, `process-edit`, `process-queue`, `youtube`, `youtube-upload`. Serves `client/dist` as static and falls through to `index.html` for non-`/api` routes (SPA). A single global error-handling middleware formats `{ error, message, code, details }`.

**Batch job execution**: Long-running batch work (Phase 2 draft generation) runs in a **detached worker process** (`server/workers/processJobWorker.js`, spawned via `child_process.spawn` from `processJobService.js`), not inline in the request handler — jobs survive server restarts. Job state persists in SQLite (`server/data/process_jobs.db` via `processJobDbService.js`); `recoverProcessJobsOnStartup()` runs once at server boot to reattach/recover in-flight jobs. Legacy JSON job files under `server/data/process_jobs/` are migrated into the DB automatically (`migrateJsonJobsToDb`).

**Persistence**: mostly flat JSON files under `server/data/` (`source_discovery_basket.json`, `youtube_upload_cards.json`, `youtube_upload_profiles.json`, etc.) plus the SQLite DB for jobs — there is no external database. Use `pipelinePaths.js`'s `writeJsonWithBackup`/`readJsonIfExists` for project-root data (`analysis/`, `script/`, `input/`, `output/`, `work/`, `config/`, `assets/`) — it auto-creates a timestamped `.backup.<ts>.json` before overwriting.

**CapCut draft generation** crosses the Node/Python boundary: Node services (`capcutService.js`, `capcutExportService.js`) prepare the manifest/timeline, then `scripts/capcut_draft.py` (pyCapCut/pycapcut) builds the actual CapCut draft folder structure. `scripts/detect_text_regions.py` and `scripts/youtube_download_pytubefix.py` are other Python helpers invoked from Node via child process.

**Client**: single zustand store (`client/src/store/pipelineStore.js`) shared across pages; pages map roughly 1:1 to phases (`client/src/pages/*.jsx`); `client/src/services/` holds the axios API clients per backend domain.

**Auth**: `server/middleware/auth.js` is a minimal `requireApiKey(envVarName)` guard that throws a 400 `API_KEY_MISSING` — not a user-auth system. Actual YouTube OAuth channel profiles are managed as persisted JSON (`youtube_upload_profiles.json`); never overwrite existing profiles when a new OAuth connection is added.

## Config/env

Required `.env` keys (see `.env.example`): `GEMINI_API_KEY` (or Vertex ADC via `GEMINI_AUTH_MODE=api_key` / `GOOGLE_CLOUD_PROJECT`), `CLAUDE_CODE_OAUTH_TOKEN` or `CLAUDE_OAUTH_TOKEN`, `ELEVENLABS_API_KEY`, `VIRLO_API_KEY` (legacy Phase 1 only). CapCut draft folder location and BGM/logo defaults are stored via Settings, not env vars.
