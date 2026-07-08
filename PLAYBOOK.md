# PLAYBOOK.md — Highlight Pattern Lab research protocol

This is the design-of-record for the Highlight Pattern Lab experiments
(`server/services/highlightPattern*.js`, `abExperimentService.js`,
`highlightSlicerService.js`, `abStats.js`). Code comments across those files
cite specific sections here — keep this file and the code in sync when the
design changes.

## 1. Track A — pattern discovery pipeline (context)

Foreign short-form process/manufacturing clips are scored EXPLODED
(`success_multiple >= 3`) / BURIED (`<= 0.5`) / MID / PENDING
(`labelFor()` in `highlightPatternDbService.js`), analyzed by Gemini for
`action_phase`, SSIM-derived `loop_seam`, `readable_in_half_second`, and other
axes, then aggregated by `patternStats()` into per-combo exploded rates. This
is the training signal `highlightSlicerService.js` uses to pick candidate cut
windows for new source videos. Calibration history (prompt v2.0 → v2.1, gate
v2 pilot, Vertex 429/DSQ quota incident) lives in `.scratch/*-report.html`.

## 2. Track A — confirmatory hypothesis testing (context)

Before the full ~561-video batch finished, exactly 3 confirmatory hypotheses
were pre-registered against a 286-sample snapshot (`.scratch/prereg-full-batch.json`)
to avoid post-hoc cherry-picking: H1 (PROCESS×Q2 exploded_rate > baseline),
H2 (`readable_in_half_second=true` > `false`), H3 (SSIM non-monotonicity,
both legs required). Method: Wilson 95% CI, confirm only on full non-overlap
(`A.ci.lo > B.ci.hi`). On the completed 510-row stable batch, all three
narrowly missed (`.scratch/final-batch-report.html`). A follow-up exploratory
check (channel stratification, outlier removal, action_phase/SSIM
cross-tabs — `.scratch/duration-confound-report.html`) found the strongest
signal in the data was actually **clip duration**: 3–5s cuts hit 74.0%
exploded vs 35.7% for 6–10s cuts (+38.3pp), and the gap survived all three
robustness checks. That finding motivated Track B below.

## 3. Track B — duration A/B experiment (confirmatory, live production data)

Track A's duration finding is exploratory (found by scanning the full data,
not pre-registered) and comes from *other creators'* videos, not this
channel's own output. Track B tests it directly, in production, as a proper
pre-registered confirmatory experiment.

**Claim under test:** cutting the highlight variant to 3–5s outperforms
6–10s, on this channel's own `success_multiple_at_7d`.

### 3.1 Pair design (randomization unit)

The app has no publish-slot queue to do classic odd/even slot randomization
against, so the pair — not the slot — is the randomization unit:

- From the same source pool, produce **2 edits as one pair**: one cut to the
  3–5s window (**T**, treatment), one cut to the 6–10s window (**C**,
  control) from the *same source video*. This cancels source-material and
  channel confounding within the pair, not just time-of-day.
- Within a pair, which member gets the earlier of the two publish slots is
  decided by a **deterministic, reproducible coin flip on `pair_id`**
  (`sha256(pair_id)`, first byte parity — `slotOrderForPair()` in
  `abExperimentService.js`). Same `pair_id` always yields the same order, so
  "always publish the short one first" can't become a hidden second
  confound.
- Window selection prefers a cut that completes one whole visible loop cycle
  (RESET-to-RESET bracketing the impact) over a plain impact-anchored cut,
  for the SHORT/T arm specifically (`findCycleAlignedWindow()` in
  `highlightSlicerService.js`).

### 3.2 Publishing (adjacent slots)

- The two members of a pair are scheduled onto **adjacent slots, 2 hours
  apart** (`SLOT_INTERVAL_MS` in `abExperimentService.js`), continuing after
  the latest slot planned so far across all pairs (`computeNextSlotPair()`).
  This cancels time-of-day/day-of-week confounding within the pair.
- The slot is a **plan**, recorded at pair-creation time
  (`scheduled_publish_at`). The **actual** publish time is recorded
  separately when the video really goes live (`markPublished`), and the
  drift between plan and reality is computed and stored
  (`publish_drift_sec`). A pair whose actual publish times drifted more than
  1 hour from plan is surfaced in the decision report
  (`scheduleDriftWarnings`) — flagged, not blocked, since the actual publish
  step is a manual human workflow step this app doesn't control.

### 3.3 Ledger

One SQLite table, `ab_assignments` (`highlightPatternDbService.js`), one row
per produced edit (two rows per pair, joined by `pair_id`):

```
pair_id, group_label (T/C), assigned_at, source_video_id,
job_id, youtube_video_id, status, published_at, scheduled_publish_at,
publish_drift_sec, dropped_reason, view_count_at_7d, channel_median_at_7d,
success_multiple_at_7d, avg_view_duration_pct
```

Status lifecycle: `assigned` (pair created) → `produced` (CapCut draft
exported into a process job) → `published` (live on YouTube, real
`youtube_video_id`/`published_at` recorded) → metrics recorded via
`recordMetrics()` once 7-day view data is available. Or: `dropped` at any
point before publish.

### 3.4 Drop-out tracking (pair-level completeness)

CapCut export goes through **manual review** before upload — a step that can
silently introduce selection bias (e.g. "3–5s drafts look awkward and get
re-cut/dropped more often than 6–10s ones"). To defend against that:

- Every drop must record a `reason` (`markDropped()` rejects a missing one).
- Per-arm drop-out rate (`dropoutByGroup: { T, C }`) is a **required** field
  in every decision report, not an optional diagnostic.
- **If either member of a pair drops, the whole pair is excluded** from the
  confirmatory Wilcoxon analysis (`getEligibleAbPairs()`) — never just
  substitute in a different video for the dropped slot. The surviving member,
  if it did publish with recorded metrics, still feeds the Mann-Whitney
  backup sample (3.5) instead of being discarded entirely.

### 3.5 Verdict

- **Primary test: Wilcoxon signed-rank** on the per-pair `(T − C)` difference
  in `success_multiple_at_7d` (`wilcoxonSignedRank()` in `abStats.js`,
  normal approximation, valid for n ≳ 10). Paired because pairs share a
  source video, so material/channel confounding cancels out within the pair
  and the test has more power than an unpaired comparison at the same n.
- **Secondary/backup: Mann-Whitney U** over the unpaired leftover sample
  (survivors of broken pairs — `unpairedByGroup`). Informational only, never
  a decision input, since it isn't the pre-registered primary test and the
  sample isn't randomized the same way.
- **Decision rule:** `CONFIRMED` only if all of: `eligiblePairCount >= 30`
  AND `wilcoxon.p < 0.05` AND `median(T)/median(C) >= 1.5`. Any one
  condition failing → `NOT_CONFIRMED`. No early verdicts before n=30 pairs,
  even if the interim data looks decisive.
- **Secondary mechanism check:** if the hypothesis holds, more loop repeats
  within the same watch session should push measured average-view-duration
  (as % of video length) above 100% specifically for the SHORT/T arm
  (`avgViewDurationMedianT` vs `avgViewDurationMedianC`).

### 3.6 Sample size

Target: **30 pairs (60 published edits)**. At one pair per adjacent 2-hour
slot pair, this is roughly 5 days of publishing volume at the channel's
current cadence.

### 3.7 API surface

`server/routes/highlightPatterns.js`, mounted under `/api/highlight-patterns/ab/*`:

- `POST /ab/pairs` `{ sourceVideoId }` → creates and schedules a pair
- `GET /ab/assignments`, `GET /ab/pairs/:pairId` → ledger reads
- `POST /ab/assignments/:id/produced|published|dropped` → status transitions
- `POST /ab/assignments/:id/metrics` → record 7-day metrics
- `GET /ab/report` → `computeDecisionReport()` output
