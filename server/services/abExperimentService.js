const crypto = require('crypto');
const { createHttpError } = require('./errorService');
const { generateDurationPairCandidates } = require('./highlightSlicerService');
const { wilcoxonSignedRank, mannWhitneyU } = require('../utils/abStats');
const db = require('./highlightPatternDbService');

const TARGET_PAIR_COUNT = 30;
// PLAYBOOK.md section 3 item 2: T/C of a pair publish on adjacent slots
// 2 hours apart -- this cancels time-of-day/day-of-week confounding within
// the pair without needing an actual publish-slot queue (this app has none).
const SLOT_INTERVAL_MS = 2 * 60 * 60 * 1000;
// A pair whose actual publish times end up further apart than this is no
// longer "adjacent" in any meaningful sense -- flagged, not blocked, since
// the manual publish workflow can't be hard-gated on it.
const DRIFT_WARNING_THRESHOLD_SEC = 3600;

function nowIso() {
  return new Date().toISOString();
}

// Deterministic, reproducible "coinflip" from pair_id -- decides which member
// of the pair (T or C) gets the earlier of two adjacent publish slots, so
// "always publish the short one first" can't become a hidden second
// confound. Same pair_id always yields the same order (PLAYBOOK.md section 3).
function slotOrderForPair(pairId) {
  const hash = crypto.createHash('sha256').update(pairId).digest('hex');
  const firstByte = parseInt(hash.slice(0, 2), 16);
  return firstByte % 2 === 0 ? 'T_FIRST' : 'C_FIRST';
}

// Next two adjacent 2-hour slots for a new pair, continuing after the latest
// slot planned so far (or from the next 2-hour boundary from now, if this is
// the first pair) so slot plans never overlap across pairs.
function computeNextSlotPair() {
  const latest = db.getLatestScheduledPublishAt();
  const base = latest
    ? new Date(latest).getTime() + SLOT_INTERVAL_MS
    : Math.ceil(Date.now() / SLOT_INTERVAL_MS) * SLOT_INTERVAL_MS;
  return {
    slotA: new Date(base).toISOString(),
    slotB: new Date(base + SLOT_INTERVAL_MS).toISOString()
  };
}

// Runtime guard (PLAYBOOK.md section 3): the pair-source-integrity check
// found no code path that could actually violate this today -- createPair
// builds both members from one sourceVideoId variable and a hardcoded
// SHORT/LONG pair literal -- but that's a structural accident of the current
// implementation, not an enforced invariant. This makes it enforced, so a
// future refactor (e.g. generateDurationPairCandidates sourcing SHORT/LONG
// from different videos) fails loudly instead of silently corrupting the
// ledger. Exported so it can be unit-tested directly with crafted bad input.
function assertPairIntegrity(sourceVideoId, members) {
  if (members.length !== 2) {
    throw createHttpError(500, 'AB_PAIR_INTEGRITY_VIOLATION', `pair must have exactly 2 members, got ${members.length}`);
  }
  const sourceIds = new Set(members.map((m) => m.source_video_id));
  if (sourceIds.size !== 1 || !sourceIds.has(sourceVideoId)) {
    throw createHttpError(500, 'AB_PAIR_INTEGRITY_VIOLATION', 'pair members must share the same source_video_id', { sourceIds: [...sourceIds] });
  }
  const groups = new Set(members.map((m) => m.target_duration_group));
  if (groups.size !== 2 || !groups.has('SHORT') || !groups.has('LONG')) {
    throw createHttpError(500, 'AB_PAIR_INTEGRITY_VIOLATION', 'pair must have exactly one SHORT and one LONG member', { groups: [...groups] });
  }
}

// Creates one matched pair (one SHORT/T + one LONG/C window) from the same
// source video and records both in the ab_assignments ledger with status
// 'assigned'. Does not touch CapCut/YouTube -- production/publishing status
// is advanced later via markProduced/markPublished/markDropped as the
// existing manual workflow (draft export, review, upload) proceeds.
async function createPair(sourceVideoId) {
  const { pair, message } = await generateDurationPairCandidates(sourceVideoId);
  if (!pair) {
    throw createHttpError(400, 'PAIR_GENERATION_FAILED', message || 'Could not generate a SHORT/LONG pair for this video');
  }
  if (!pair.short || !pair.long) {
    throw createHttpError(500, 'AB_PAIR_INTEGRITY_VIOLATION', 'pair must include both a SHORT and a LONG window');
  }

  const pairId = crypto.randomUUID();
  const slotOrder = slotOrderForPair(pairId);
  const { slotA, slotB } = computeNextSlotPair();
  const now = nowIso();

  const members = [
    { groupLabel: 'T', targetDurationGroup: 'SHORT', window: pair.short },
    { groupLabel: 'C', targetDurationGroup: 'LONG', window: pair.long }
  ].map((m) => {
    const id = crypto.randomUUID();
    // slotOrder decides who gets the earlier slot -- T_FIRST means T=slotA,
    // C=slotB, and vice-versa -- so "always publish the short one first"
    // never becomes a hidden second confound (see slotOrderForPair above).
    const getsFirstSlot = (slotOrder === 'T_FIRST' && m.groupLabel === 'T')
      || (slotOrder === 'C_FIRST' && m.groupLabel === 'C');
    db.insertAbAssignment({
      id,
      pairId,
      groupLabel: m.groupLabel,
      targetDurationGroup: m.targetDurationGroup,
      sourceVideoId,
      startSec: m.window.start_sec,
      endSec: m.window.end_sec,
      seamSimilarity: m.window.seam_similarity,
      slotOrder,
      scheduledPublishAt: getsFirstSlot ? slotA : slotB,
      now
    });
    return db.getAbAssignment(id);
  });

  assertPairIntegrity(sourceVideoId, members);

  return { pairId, slotOrder, pattern: pair.pattern, members };
}

function markProduced(id, { jobId } = {}) {
  const updated = db.updateAbAssignmentStatus(id, { status: 'produced', jobId, now: nowIso() });
  if (!updated) throw createHttpError(404, 'AB_ASSIGNMENT_NOT_FOUND', 'assignment not found');
  return updated;
}

function markPublished(id, { youtubeVideoId, publishedAt } = {}) {
  if (!youtubeVideoId) {
    throw createHttpError(400, 'YOUTUBE_VIDEO_ID_REQUIRED', 'youtubeVideoId is required to mark an assignment published');
  }
  const updated = db.updateAbAssignmentStatus(id, {
    status: 'published',
    youtubeVideoId,
    publishedAt: publishedAt || nowIso(),
    now: nowIso()
  });
  if (!updated) throw createHttpError(404, 'AB_ASSIGNMENT_NOT_FOUND', 'assignment not found');
  return updated;
}

// PLAYBOOK.md section 3, item 4: a dropped member voids its whole pair for
// the confirmatory analysis (checked in db.getEligibleAbPairs), but the
// ledger keeps the row so per-arm dropout rate stays reportable.
function markDropped(id, { reason } = {}) {
  if (!reason) {
    throw createHttpError(400, 'DROP_REASON_REQUIRED', 'reason is required when dropping an assignment');
  }
  const updated = db.updateAbAssignmentStatus(id, { status: 'dropped', droppedReason: reason, now: nowIso() });
  if (!updated) throw createHttpError(404, 'AB_ASSIGNMENT_NOT_FOUND', 'assignment not found');
  return updated;
}

function recordMetrics(id, { viewCountAt7d, channelMedianAt7d, avgViewDurationPct } = {}) {
  if (!Number.isFinite(viewCountAt7d) || !Number.isFinite(channelMedianAt7d) || channelMedianAt7d <= 0) {
    throw createHttpError(400, 'INVALID_METRICS', 'viewCountAt7d and a positive channelMedianAt7d are required');
  }
  const successMultipleAt7d = viewCountAt7d / channelMedianAt7d;
  db.recordAbMetrics(id, {
    viewCountAt7d,
    channelMedianAt7d,
    successMultipleAt7d,
    avgViewDurationPct: avgViewDurationPct ?? null,
    now: nowIso()
  });
  return db.getAbAssignment(id);
}

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Primary test: Wilcoxon signed-rank on per-pair (T - C) differences --
// pairing cancels out source-material/channel confounding, per the
// duration-confound-check findings that motivated this design.
// Decision rule (PLAYBOOK.md section 3): p < 0.05 AND median(T)/median(C) >= 1.5.
function computeDecisionReport() {
  const { eligible, dropoutByGroup, unpairedByGroup } = db.getEligibleAbPairs();
  const diffs = eligible.map((p) => p.t.success_multiple_at_7d - p.c.success_multiple_at_7d);
  const wilcoxon = wilcoxonSignedRank(diffs);

  const medianT = median(eligible.map((p) => p.t.success_multiple_at_7d));
  const medianC = median(eligible.map((p) => p.c.success_multiple_at_7d));
  const ratio = medianT !== null && medianC !== null && medianC !== 0 ? medianT / medianC : null;

  const meetsSampleSize = eligible.length >= TARGET_PAIR_COUNT;
  const decision = meetsSampleSize && wilcoxon.p !== null && wilcoxon.p < 0.05 && ratio !== null && ratio >= 1.5
    ? 'CONFIRMED'
    : 'NOT_CONFIRMED';

  // Secondary mechanism check: if the hypothesis is right, more loop
  // repeats within the same watch session should push measured retention
  // (view-duration as % of video length) above 100% for the SHORT/T arm.
  const avgViewDurationT = median(eligible.map((p) => p.t.avg_view_duration_pct).filter((v) => v !== null && v !== undefined));
  const avgViewDurationC = median(eligible.map((p) => p.c.avg_view_duration_pct).filter((v) => v !== null && v !== undefined));

  // Backup test over leftover unpaired samples (PLAYBOOK.md section 3 item
  // 5): when one member of a pair drops, its surviving sibling can't feed
  // the paired Wilcoxon test but still carries signal. Never a decision
  // input -- reported for context only, alongside the primary verdict.
  const mannWhitneyBackup = {
    ...mannWhitneyU(unpairedByGroup.T, unpairedByGroup.C),
    note: '쌍이 깨진(한쪽 드랍) 잔여 표본 보조 검정 -- 주 판정(Wilcoxon, 쌍 데이터)에는 영향 없음, 참고용 (PLAYBOOK.md section 3)'
  };

  // Schedule-integrity check (PLAYBOOK.md section 3 item 3): flag any
  // published member whose actual publishAt drifted far from its planned
  // adjacent slot, since a big drift undermines the within-pair time-of-day
  // cancellation the pairing design relies on.
  const scheduleDriftWarnings = eligible
    .flatMap((p) => [p.t, p.c])
    .filter((m) => Number.isFinite(m.publish_drift_sec) && Math.abs(m.publish_drift_sec) > DRIFT_WARNING_THRESHOLD_SEC)
    .map((m) => ({ id: m.id, pairId: m.pair_id, groupLabel: m.group_label, publishDriftSec: m.publish_drift_sec }));

  return {
    targetPairCount: TARGET_PAIR_COUNT,
    eligiblePairCount: eligible.length,
    meetsSampleSize,
    dropoutByGroup,
    medianT,
    medianC,
    ratio,
    wilcoxon,
    mannWhitneyBackup,
    scheduleDriftWarnings,
    avgViewDurationMedianT: avgViewDurationT,
    avgViewDurationMedianC: avgViewDurationC,
    decision,
    note: meetsSampleSize
      ? null
      : `아직 ${eligible.length}/${TARGET_PAIR_COUNT} 쌍 -- 최소 표본 도달 전 조기 판정 금지 (PLAYBOOK.md section 3)`
  };
}

module.exports = {
  TARGET_PAIR_COUNT,
  slotOrderForPair,
  assertPairIntegrity,
  createPair,
  markProduced,
  markPublished,
  markDropped,
  recordMetrics,
  computeDecisionReport
};
