# Full promotion of highlight sources (prepared 2026-08-14, OFF by default)

## Why

A qualified source is the scarce resource, not the analysis. The eligibility
gate pass rate swings 0/4 to 4/4 per batch, the channel ledger keeps blocking
narration-led channels, and the harvest is throttled while that plays out.
Raising output per source relieves exactly that constraint; harvesting harder
does not.

The arc is already free. `process_arc_steps` comes back from the SAME Vision
candidate scan that produces `hook_candidates`, so every longform highlight
source carries a complete process arc that is currently discarded. The marginal
cost of also shipping a Full is one script call, TTS, a draft build and a CapCut
export — the expensive scan (200s+, rate-limited) is already paid for.

## What is implemented

`processQueueService`:

- `fullPromotionAssessment(itemConfig)` — the gate. Returns
  `{ eligible, reasons, windows, concat_sec }`. Requires, in order:
  `FULL_FROM_HIGHLIGHT_SOURCE=1`, the item is not already a `kr_full`/`ja_full`
  lane item, the source is longform, the arc yields usable windows, the last
  window is a real `arc_result`, and the concat reaches
  `FULL_PROMOTION_MIN_CONCAT_SEC` (38s).

  The two result-step and length failures it screens for are the ones that
  actually shipped bad Fulls during the 2026-08-13 work: an arc whose result
  step fell outside the source, so the Full ended mid-process; and an arc too
  short to clear the format floor.

- `dedupeArcWindowsAgainstHighlights(arcWindows, highlightWindows)` — the hook
  window a highlight ships and arc step 1 routinely land on the same moment, so
  a promoted Full would replay footage the channel already posted. Overlapping
  arc windows are dropped, never the result step, and never below
  `FULL_PROMOTION_MIN_KEPT_WINDOWS` (5) — a Full without its ending is worse
  than one that repeats a few seconds. Measured on item_020: 11 windows against
  two shipped highlight windows keeps 9 and preserves `arc_result`.

## What is NOT wired

Promotion does not touch `effectiveDraftVariantModeForItem` or `wantsFullDraft`.
Those are the guards that keep Full generation from ever being unconditionally
on, and `check:shortform-highlight` pins both strings. Routing promotion through
them would mean loosening exactly the guard that exists to stop this.

The intended wiring is a **second queue item**: after a highlight item's
analysis succeeds and the gate passes, enqueue another item for the same source
on the channel's full lane, reusing the downloaded `source_clean.mp4` and the
stored `ottogi_guide_output` so no second Vision scan runs. The lane check then
works untouched, because the promoted item genuinely is a full-lane item.

Remaining to build: the post-analysis hook that creates that item, and passing
the shipped highlight windows into `dedupeArcWindowsAgainstHighlights` at
assembly time.

## Before turning it on

- Full has only just stabilised. As of 2026-08-14 it is verified on two ja_full
  sources (44.2 / 46.4 / 50.5s timelines, arc-aligned scripts) and kr_full has
  not yet produced a passing draft. Doubling Full volume before the format is
  proven across more sources amplifies whatever is still unstable.
- Channel mix is a product decision, not a technical one: Full carries the
  channel's audio-language signal while highlights carry volume and non-verbal
  reach. Promoting every eligible source flips that ratio.
- Export throughput is serial (~10 min of machine time per draft), so promoted
  Fulls compete with the daily plan for the same window.
