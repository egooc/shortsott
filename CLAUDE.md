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
- Design intent is 4 channel variants per source (`JP Full`, `JP Highlight`, `KR Full`, `KR Highlight`), each with its own script/subtitles/title/description/hashtags/BGM/logo — never copies with only the language swapped.
  - Full: process-explanation video, one short caption per cut, subtitle timing matches cut timeline.
  - Highlight: strongest visual-hook moment, single ~200-char explainer block (not per-cut captions).
- **What actually generates today: Highlight, plus the KR Full lane (approved 2026-08-11).** Items marked `production_lane: 'kr_full'` (daily harvest routes 4/day, `harvest_config.json` locale_plan `lane` field) produce the Korean TTS-narrated Full draft — the KR channel retarget needs a Korean AUDIO signal that voiceless highlights cannot give. Every other item stays highlight-only: `effectiveDraftVariantModeForItem` returns `'full_only'` only for that lane, `wantsFullDraft` derives from it, `wantsMidformDraft` stays hardcoded false — all asserted by `check:shortform-highlight`. Each queue item produces drafts in its own `target_locale`, not both languages.
  - kr_full lane items skip the manual script-review approval for TTS **when validation passed** (held scripts still stop for review) — the lane runs unattended. Narration mp3s are placed on a real `tts` audio track in the draft (`create_process_draft`, manifest `process_tts`); before 2026-08-11 they only drove caption timing and drafts shipped silent.
  - Upgrade backlog from the midform repo comparison: docs/midform-adoption-plan-2026-08-11.md.
- Upload profile purposes gate at the **channel language level** (ko_* item on ko_* profile passes; cross-language is a hard error) — the KR channel takes ko_full uploads while its stored purpose is still ko_highlight.
- Highlight count per source (`highlightOutputCountForItem`): longform 5, shortform 2 when the source is 24s or longer, otherwise 1. Duration caps: shortform `SHORTFORM_HIGHLIGHT_MAX_DURATION_SEC` 10s, longform `LONGFORM_HIGHLIGHT_MAX_DURATION_SEC` 24s (default 16s).
- Longform highlight rules (`pickHighlightWindows`):
  - Arc completion beats duration (approved 2026-08-10, user sign-off): a longform candidate whose arc runs past the duration cap is **dropped, not end-clipped** (`normalizeHighlightCandidateWindow`) — a hook→process→end window without its ending must never ship. Shortform keeps the clip behavior. Guarded by `check:shortform-highlight`.
  - Ships **only Gemini/Vision-nominated windows** (`selection_strategy` starting `gemini_`). Scene-ranked windows carry no per-window hook evidence, so they can only be captioned by a generic template — they must never pad a longform set.
  - Ships **any count of distinct real windows it actually found** (`LONGFORM_HIGHLIGHT_MIN_OUTPUT_COUNT` = 1, approved 2026-08-10 — one complete arc is worth shipping; was 3), up to 5. With zero valid windows it returns nothing and the item is skipped; it is never topped up with fallback windows. `LONGFORM_MIN_PRODUCTION_HOOK_CANDIDATES` in `processMetadataService.js` must stay in sync or the analysis gate rejects sources before draft generation sees them.
  - `highlight_total` reports the windows actually produced, not the count requested — folder ordinals and per-window metadata read it.
- No usable candidates is a **skip, not a failure**: the item records `highlight_skip_reason` / `skipped_no_highlight_candidates`, the batch continues, and the job reports `completed_with_warnings`. Same for longform and shortform. Before skipping, the metadata stage retries the analysis **once** in-batch (approved 2026-08-10): re-running identical sources flipped 7 of 26 verdicts, so a single fresh retry recovers real sources lost to analysis variance; a second identical verdict is accepted as the skip.
- Per-cut titles and captions come from `highlight_metadata.highlight_candidate_titles` — one entry per candidate window carrying `title`, `hashtags`, `scene_specific_explanation_ja`, `scene_specific_explanation_ko`. Without them every cut of one source falls back to a shared title and a generic template caption. The longform prompt must enumerate the **unnarrowed** candidate list (`allCandidateGuide`), and its header must not tell the model to use one fixed window.
- Template caption blocks (`buildSemanticHighlightBlock`, cue templates) are written without seeing the video and are chosen by keyword. They must never name a material, tool, or process — a bamboo-sawing source was once captioned with red-hot metal and sparks purely on a cue match.
- Draft variant modes are `full` / `highlight` / `midform` (see `normalizeDraftVariantMode` in `processJobService.js`); `full_highlight_only` auto-promotes when `highlight_only` is requested on a **longform** source (`isLongformQueueItemConfig`) — shortform highlight must stay `highlight_only` (enforced by `check:shortform-highlight`).
- Phase 1 → Phase 2 batch size and the JP/KO split are **free**. `validateLocale66Rows` only rejects an empty batch, a locale other than `ja-JP`/`ko-KR`, and the same YouTube source twice. The `locale_6_6` batch-mode string is a legacy wire value persisted in job rows — it no longer implies 12 items at 6/6. The only size bound left is `MAX_YOUTUBE_IMPORT_URLS` (100), matching the Phase 1 basket cap.
- Draft folder naming: `YYYYMMDD-F_or_H_or_M-HHMMSS-title`, no hashtags, no batch item number. `upload_title` is metadata only, never a CapCut text overlay.
- Do-not-reintroduce list (regressions fixed before): `TEMPLATE_PROCESS_TITLE` / `process_title` text track, upload-title-as-screen-text, English fallback captions for JP/KR, uploading Korean review-only text to YouTube descriptions, duplicate browser-side processing buttons when a server job already exists.

**Daily auto-pipeline (approved 2026-08-10, docs/daily-auto-pipeline-plan-2026-08-10.md):**
- `npm run daily:pipeline` (Windows Task Scheduler, 03:00 daily) = scorecard for the last finished job → harvest → batch start → `server/output/daily-reports/YYYYMMDD.md`.
- Harvest (`sourceHarvestService.js`): yt-dlp metadata search over the curated query pool (rotating 5/day), longform 240–1800s only, permanent dedupe ledger `server/data/source_harvest_history.json` (seeded from all past job/queue URLs — never re-imports), ranked by Most-Replayed heatmap peak + views, imports `harvest_config.json`'s `daily_count` (12) with its `locale_plan` (currently JP 12; KR ramps by editing that file, no code change).
- Eligibility gate (`sourceEligibilityService.js`, guarded by `check:source-eligibility-gate`): applies **only to `source_harvested: true` items**, runs the local signal probe before the Gemini analysis, and skips (`skipped_source_ineligible`, never a failure) on speech>0.35 / dominant-face>0.2 / static>0.5. Human-curated queue items are never gated. Fail-open; kill switch `SOURCE_ELIGIBILITY_GATE=0`.

**Older/legacy workflow (README.md; still present in `Phase1Search.jsx`..`Phase5Draft.jsx`, `virlo`/`gemini`/`claude`/`elevenlabs`/`capcut` routes):** Virlo source discovery → Gemini analysis (`analysis/gemini_analysis.json`) → **Phase 2.5 Gemini Review Gate** (`analysis/gemini_review.json`; Phase 3 is blocked with 400 `GEMINI_ANALYSIS_NOT_APPROVED` until `status === "approved"` and all `checks` pass) → Claude script generation (`script/claude_midform_story.json`) → TTS/SRT via ElevenLabs, split into **caption units** (1 caption unit = 1 TTS mp3 = 1 subtitle segment, e.g. `seg_001_cap_001.mp3`) → CapCut draft ZIP (absolute-path mode `recommendedZip` is the only reliable one; relative-path ZIP can lose audio media in CapCut).
- CapCut template markers (`templates/capcut/channel_default/`): `TEMPLATE_PRETITLE`, `TEMPLATE_TITLE`, `TEMPLATE_SUBTITLE`, `TEMPLATE_MOVIE_TITLE` — must exist as real text objects in the template draft for clone-mode style/effect inheritance to work.

When adding UI, confirm which phase owns a feature and don't duplicate another phase's responsibility (e.g., no CapCut generation from Phase 1, no YouTube upload from Phase 2).

## Production highlight path — do not modify without explicit approval

`server/services/processQueueService.js`'s highlight window selection
(`pickHighlightWindow`, `pickHighlightWindows`, `collectHighlightCandidateWindows`,
`selectBestHighlightWindow`, `getDefaultLongformHighlightWindows`, the
`SHORTFORM_HIGHLIGHT_MAX_DURATION_SEC` / `LONGFORM_HIGHLIGHT_MAX_DURATION_SEC`
duration constants, and the `LONGFORM_HIGHLIGHT_MIN_OUTPUT_COUNT` /
`highlightOutputCountForItem` count policy) plus `scripts/capcut_draft.py`'s
draft assembly are a verified, revenue-producing system. **Do not add new
selection strategies, "improve" the scoring, or change these duration or count
constants without the user's explicit sign-off in the conversation.** A prior
session built new selectors
(`pickProductionHighlightWindow`, loop-complete/result-reveal completion
windows) directly on top of this path in an uncommitted working tree; it
silently changed output behavior for weeks before anyone noticed, and had
to be reverted line-by-line back to a known-good commit (see
`docs/highlight-window-selector-revert-2026-07-21.md`). If a change to this
path seems warranted, propose it and wait for confirmation before editing.

Approved addition (2026-08-08, user sign-off; scene-cut upgrade approved
same day; ffmpeg-probe engine swap approved 2026-08-09):
`highlightEdgeRefineService.js` runs AFTER window selection and settles each
chosen window's edges onto a natural boundary — per edge a scene cut wins
when one is in budget, else a silence trough. Scene cuts come from ffmpeg's
scene-score filter probed only around each window's edges; whole-video /
neural detection (TransNetV2) must never return to this path — it took
~18min per source and never fit the production timeout (fail-open; scene
probe failure degrades to silence-only; kill switches
`HIGHLIGHT_EDGE_REFINE=0` and `HIGHLIGHT_EDGE_REFINE_SCENES=0`, guarded by
`check:highlight-edge-refine`). Its hard limits — no change to window
count/order/strategy/scene ids; silence may move an edge at most 0.35s, a
scene cut at most 0.35s (start) / 1.6s (end); duration never over the cap,
shrink at most 0.7s (silence-only) / 2.0s (scene move), never below 4s —
are part of the protected contract; loosening them needs the same explicit
sign-off as the selection path itself.

## Sibling reference repo — movie recap pipeline

`C:\Users\sejun\Documents\Codex\2026-05-26\midform` is a separate,
**midform-only movie-recap pipeline** (own AGENTS.md; longform source
analysis + TTS already complete; `midform-stable-runner` is its runner
build). It is the destination genre for the channel-warmup strategy —
read it for reference when designing recap-related features, but never
import code across repos without explicit direction. The midform drafts
in the CapCut output folder (breaking-dawn/anger/anacondas/hollowman
JA/KO) come from that repo, not this one.

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
