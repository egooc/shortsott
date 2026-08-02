# Project Guardrails for Codex Agents

This repository is the local production app for **3분 오뚝이영상**. The product is no longer a generic experimental content pipeline. Keep the app focused on the three-phase workflow below, and treat Korean/Japanese text integrity as a release blocker.

## Mandatory Encoding Rules

1. Save all source files as UTF-8.
2. Do not overwrite Korean/Japanese source files with PowerShell `Set-Content`, `Out-File`, or shell redirection.
3. For files containing Korean/Japanese text, edit with one of these only:
   - `apply_patch`
   - Node.js `fs.writeFileSync(file, text, 'utf8')`
   - Python `Path.write_text(text, encoding='utf-8')`
4. JSON writes must use `JSON.stringify(data, null, 2)` and `fs.writeFileSync(path, json + '\n', 'utf8')`.
5. If mojibake, replacement characters, or mass question-mark replacement appears in source, the task is incomplete.
6. Never hide broken UI text. Fix the source string or the encoding path.

## Required Verification Before Completion

After any code change, run:

```bash
npm run verify
```

`npm run verify` must include:

1. `npm run check:encoding`
2. `npm run build`

If either command fails, keep fixing before reporting completion.

## Product Phase Contract

### Settings

Purpose:
- Store only configuration needed by the 3분 오뚝이영상 workflow.
- Manage YouTube Data API Key, Gemini/Vertex ADC, YouTube OAuth channel profiles, CapCut Draft Folder, default/highlight BGM, default/highlight logo assets, and language/channel settings.

Do not expose unrelated legacy settings in the main UI:
- Virlo
- Claude movie recap
- ElevenLabs TTS
- old archive experiments
- unused render/TTS/ZIP options

### Phase 1: 소재 발굴

Purpose:
- Search YouTube sources using the YouTube API.
- Filter candidates by hashtag, keyword, duration, upload age, and view count.
- Mark already selected, already produced, and excluded videos.
- Let the user collect multiple URLs before sending them to Phase 2.

Output to Phase 2:
- `youtube_url`
- `title`
- `thumbnail`
- `duration`
- `views`
- `publishedAt`
- source discovery metadata

Do not:
- Generate CapCut drafts.
- Run Gemini analysis.
- Upload to YouTube.
- Auto-jump to Phase 2 after a single URL selection.

### Phase 2: 배치 드래프트 생성

Purpose:
- Manage batch items from Phase 1 URLs or manually added videos.
- Download YouTube sources when needed.
- Prepare source videos.
- Run Gemini/Vertex analysis.
- Generate scene timestamps and cut plans.
- Create CapCut draft folders directly under the configured CapCut Draft Folder.
- Generate metadata TXT packages.
- Track server-side jobs, progress, retry state, and failures.

Core rule: Phase 2 generates **Highlight drafts only, in two locales** — `JP Highlight` (`ja-JP`) and
`KR Highlight` (`ko-KR`). Full Draft and Midform generation are policy-disabled in the active workflow.

Active source shape: shortform sources only (`source_type: shortform`, `source_workflow_mode: shortform_direct`).
Longform-to-shorts code paths still exist but are not part of the active workflow.

Locale rule:
- Each queue item carries exactly one `target_locale`: `ja-JP` or `ko-KR`. There is no other allowed value.
- `ja-JP` items route to `createHighlightDraftForItem`; `ko-KR` items route to `createKoreanHighlightDraftForItem`.
- A KR Highlight is a first-class production output, not review material. Its Korean script, captions,
  title, description, and hashtags are the real upload metadata for the Korean channel.
- A JP Highlight must not contain Korean production text, and a KR Highlight must not contain Japanese
  production text. Language bleed between the two locales is a defect.
- Batch mode `locale_6_6` runs 12 distinct sources per batch: exactly 6 `ja-JP` + 6 `ko-KR`, no duplicate
  source video. Validation is against the original 12-item batch; if some items fail metadata, only the
  metadata-ready subset is sent to draft generation and the rest are recorded as skipped.

Highlight count:
- The selector picks the strongest hook window(s) it can actually find. Requested count is a **target,
  not a contract** — producing fewer windows than requested is normal and must not fail the item.
- Do not add deterministic/evenly-sliced "coverage" windows to hit a number, and do not throw when the
  count falls short. A highlight window must come from hook scoring or Gemini candidates, never from
  mechanically dividing the source.

Variant output expectation:
- One source analysis can share scene understanding, process steps, scene-transition candidates, OCR/mask candidates, and source metadata.
- Each Highlight output must have its own source window, locale-correct script/caption block, title, description, hashtags, metadata TXT, BGM/logo selection, and upload target.
- When one source yields more than one Highlight, the outputs must not be simple copies with only filename changed.
- Full-related Gemini prompt/helper functions may remain as legacy code, but active Phase 2 code paths must not call Full metadata, Full script, story/full outline, or Full repair/regeneration Gemini requests.

Full / Midform draft rules:
- Full Draft and Midform generation are disabled in the active Phase 2 workflow.
- Korean Full drafts, the ElevenLabs TTS path, and the `aux_source_*` B-roll fields are dormant legacy
  code. Do not wire them into the active highlight flow.
- Do not create Full or Midform CapCut drafts from Phase 2 unless the product contract is explicitly changed again.

Highlight draft rules:
- Purpose: under-10-second or short visual hook focused on curiosity, repetition, machinery, pouring, cutting, pressing, transformation, or other satisfying movement.
- Video selection: split by scene transitions/cut scenes, score each cut scene, and choose ranked visual-hook moments, not a compressed summary of the whole process.
- Use scene-level uniqueness when a source yields multiple Highlights. Do not require arbitrary fixed time-distance between highlights when scene segmentation already separates cuts.
- Reject duplicated/overlapping/near-duplicate windows only when segmentation splits the same action cycle into multiple candidates.
- Do not remove one-frame tails from highlight cuts if it breaks the visual rhythm.
- Subtitle style: one 200-character-ish explainer block, not per-cut one-line captions.
- Japanese highlight caption: natural Japanese main text for upload and screen use.
- Korean highlight caption: natural Korean main text for upload and screen use, written as a hook-focused short explainer, not translationese.
- Highlight BGM and highlight logo are configured per locale (`highlight_*` for JP, `korean_highlight_*` for KR).

Metadata rules:
- Highlight metadata must be different per locale, and per hook window when one source yields multiple Highlights.
- Upload TXT can include review-only sections for local inspection, but YouTube upload descriptions must not include review-only text.
- If Gemini output is missing required fields for the item's locale, retry or fail. Do not silently fill with English fallback captions.

Title and hashtag rules:
- Exactly **one** title per variant (`MAX_RECOMMENDED_TITLES`). Phase 3 uploads
  `recommended_titles[0]` and nothing reads the rest, so do not generate or pad a list of five.
- The uploaded title is Gemini's own hook title, verbatim. Deterministic patterns
  (`<subject>ができるまで`, `<subject>이 만들어지는 과정`) are a last resort for when the model
  title is unusable - never a replacement for a usable one. Language repair replaces only the
  titles that fail the check, never the whole list.
- Hashtags are written in the **title's own language** - Japanese hashtags on JP titles, Korean on
  KR titles - and should be specific to what the video shows. Do not force `#worker`/`#process`
  or other generic English tags into the list; the English-only hashtag contract from
  commit 003a985 is retired because reach on JP/KR channels depends on native-language tags.
- Hashtags are stripped before every language-contamination check, so native hashtags never count
  as contamination.

Naming rules:
- Draft folder names must not include hashtags.
- Draft folder naming pattern: `YYYYMMDD-F_or_H_or_M-HHMMSS-title`.
- Do not include the batch item number in draft folder names.
- `upload_title` is metadata only and must not become a CapCut text overlay.

Do not:
- Reintroduce `TEMPLATE_PROCESS_TITLE`.
- Recreate a `process_title` text track.
- Use channel tag text when a logo asset should be used.
- Re-enable active Full Draft, Midform, or Full-related Gemini requests without an explicit product-contract update.
- Force a highlight output count, invent mechanically-sliced highlight windows, or fail an item for
  producing fewer highlights than requested.
- Write a full `item_config` snapshot back from the Phase 2 UI. The UI may only send the fields listed in
  `QUEUE_UI_EDITABLE_FIELDS`; everything else is server-owned and a full write-back wipes Gemini analysis
  results (`ottogi_guide_output`, `highlight_candidate_windows`, `highlight_metadata_ja/ko`, ...).
- Upload to YouTube from Phase 2.

### Phase 3: YouTube 자동 업로드

Purpose:
- Import exported final videos from CapCut.
- Import matching TXT metadata files.
- Match video and TXT as one card.
- Separate full/highlight and channel/language targets.
- Extract upload title, description, and tags from the correct metadata section.
- Show Korean review text only in the UI for checking.
- Schedule uploads by start time and interval.
- Maintain upload cards for pending, completed, failed, and re-uploadable items.

Rules:
- YouTube upload descriptions must contain only the intended public-language metadata.
- Korean review-only text must never be uploaded as part of another language channel description.
- Matched cards must persist after page navigation.
- Pending cards must be restorable.
- Completed cards must remain inspectable and reusable for corrected re-upload.
- Multiple YouTube OAuth channel profiles must be preserved. New OAuth connections must not overwrite existing profiles.

Do not:
- Treat missing TXT as upload-ready unless the user explicitly confirms a fallback.
- Store pending/completed uploads as plain text logs only.
- Delete or overwrite OAuth profiles unexpectedly.

## Main Workflow

```text
Settings
-> Phase 1 source discovery
-> URL basket
-> Phase 2 batch items
-> source download
-> Gemini/Vertex analysis
-> Highlight-only draft generation (JP Highlight for ja-JP items, KR Highlight for ko-KR items)
-> manual CapCut export
-> Phase 3 video + TXT matching
-> channel-specific scheduled upload
-> completed / pending / failed card management
```

## Development Flow

1. Confirm which phase owns the feature before editing.
2. Reject UI buttons that duplicate another phase's responsibility.
3. Keep legacy/experimental features hidden unless they are explicitly part of the current 3분 오뚝이영상 workflow.
4. Run `npm run check:encoding` first.
5. Run `npm run build` or `npm run verify` before completion.
6. Report verification evidence.

## Derived Values Must Never Outrank the Source

The metadata pipeline runs the same normalize / enforce / merge helpers at **every**
stage — scene analysis, hook analysis, metadata, review, repair. Those helpers were
written as if they always receive a finished guide, so they fill and repair
defensively. At an early stage there is nothing to repair yet, so what they produce
is invented; and because merges are truthiness-based (`source.x || fallback.x`), an
invented value is indistinguishable from a real one and wins against the real value
that arrives later.

Four separate defects in 2026-08-02 were the same shape:

| Where | What it invented / overwrote |
|---|---|
| `normalizeTitleList` | padded `recommended_titles` to a fixed count with deterministic templates |
| `mergeReviewedGuide` | dropped `highlight_candidate_titles` by spreading the review object over the drafted one |
| `enforceMetadataSectionLanguage` | treated an **empty** field as "wrong language" and filled it with a template |
| review (3/3) merge | re-emitted `recommended_titles` / `upload_title` and replaced the metadata call's real title |

Symptom in every case: Gemini returned a good hook title, and the stored guide held
`製造工程ができるまで` / `제조 공정이 만들어지는 과정` with default hashtags.

Rules:

- **Absent is not wrong.** Repair only values that exist and fail a check. A field that
  has not been produced yet must stay empty.
- **Do not fabricate in shared helpers.** If a field must be non-empty in the final
  output, guarantee it once, at the output boundary — not in a function that also runs
  on intermediate guides.
- **A validation pass may not rewrite.** Review exists to catch problems; when the
  drafted value passes its checks, keep the drafted value.
- **Field-by-field merges drop unknown fields.** `mergeVariantMetadata` and
  `mergeReviewedGuide` rebuild objects explicitly, so any new metadata field must be
  added to both or it silently disappears before it reaches disk.
- When a value looks wrong in `item_config.json` but right in the draft folder (or the
  reverse), suspect this class first and diff the raw Gemini response
  (`queue/process/<item>/full_draft_stages/*.raw.json`) against the stored guide.
  Offline replays of the response alone will not reproduce it — the placeholder is
  planted by a stage the replay skips.

## Do Not Reintroduce

1. `TEMPLATE_PROCESS_TITLE`
2. `process_title` text track
3. Upload-title-as-screen-text behavior
4. Browser-side duplicate processing buttons when server jobs exist
5. Unused TTS/ZIP/archive controls in the main workflow
6. English fallback captions for Japanese/Korean draft generation
7. Uploading Korean review-only text to YouTube descriptions
8. Padding, filling, or repairing metadata fields in helpers that also run on pre-metadata stages (see "Derived Values Must Never Outrank the Source")

