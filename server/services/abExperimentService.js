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

// Channel axis (PLAYBOOK.md section 3 amendment): independent deterministic
// coinflip deciding which registered channel (role A or B) publishes the
// T member of this pair. Uses a different hash input ("<pairId>channel")
// than slotOrderForPair's plain pairId, so the two draws are independent --
// if they shared a hash, publish-order and channel-assignment would be
// perfectly correlated within every pair, which would silently reintroduce
// a channel confound into whichever axis rides along with slot order.
function channelAssignmentForPair(pairId) {
  const hash = crypto.createHash('sha256').update(pairId + 'channel').digest('hex');
  const firstByte = parseInt(hash.slice(0, 2), 16);
  return firstByte % 2 === 0 ? 'CHANNEL_A_GETS_T' : 'CHANNEL_B_GETS_T';
}

// Runtime channel model: either the original two-channel setup (roles A/B) or
// the current single-channel AIR POINT setup. In single-channel mode, both T/C
// members target the same channel and only slot order randomization remains.
function getRegisteredChannelSetup() {
  const channels = db.getExperimentChannels();
  if (channels.length === 1) {
    return {
      mode: 'single',
      primaryChannel: channels[0]
    };
  }
  const channelA = channels.find((c) => c.role === 'A');
  const channelB = channels.find((c) => c.role === 'B');
  if (!channelA || !channelB) {
    throw createHttpError(400, 'EXPERIMENT_CHANNELS_NOT_REGISTERED', 'register one primary experiment channel or both role A and role B channels before creating a pair');
  }
  return {
    mode: 'dual',
    channelA,
    channelB
  };
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
function assertPairIntegrity(sourceVideoId, members, { singleChannelMode = false } = {}) {
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
  // Channel axis amendment: the two members must target two different
  // channels, or the whole point of the channel axis (canceling channel-size
  // confounding within the pair) regresses to the original problem.
  const channelIds = new Set(members.map((m) => m.target_channel_id));
  if (singleChannelMode) {
    if (channelIds.size !== 1) {
      throw createHttpError(500, 'AB_PAIR_INTEGRITY_VIOLATION', 'single-channel pair must target exactly one experiment channel', { channelIds: [...channelIds] });
    }
  } else if (channelIds.size !== 2) {
    throw createHttpError(500, 'AB_PAIR_INTEGRITY_VIOLATION', 'pair must have two members targeting two different channels', { channelIds: [...channelIds] });
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

  const channelSetup = getRegisteredChannelSetup();

  const pairId = crypto.randomUUID();
  const slotOrder = slotOrderForPair(pairId);
  const channelAssignment = channelAssignmentForPair(pairId);
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
    const targetChannelId = channelSetup.mode === 'single'
      ? channelSetup.primaryChannel.channel_id
      : (((channelAssignment === 'CHANNEL_A_GETS_T' && m.groupLabel === 'T')
        || (channelAssignment === 'CHANNEL_B_GETS_T' && m.groupLabel === 'C'))
        ? channelSetup.channelA.channel_id
        : channelSetup.channelB.channel_id);
    db.insertAbAssignment({
      id,
      pairId,
      groupLabel: m.groupLabel,
      targetDurationGroup: m.targetDurationGroup,
      sourceVideoId,
      targetChannelId,
      startSec: m.window.start_sec,
      endSec: m.window.end_sec,
      seamSimilarity: m.window.seam_similarity,
      slotOrder,
      scheduledPublishAt: getsFirstSlot ? slotA : slotB,
      now
    });
    return db.getAbAssignment(id);
  });

  assertPairIntegrity(sourceVideoId, members, { singleChannelMode: channelSetup.mode === 'single' });

  return { pairId, slotOrder, channelAssignment, channelMode: channelSetup.mode, pattern: pair.pattern, members };
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

// Channel baseline snapshot (PLAYBOOK.md section 3 amendment, "라벨링 시점 값
// 고정" / P5 principle): the multiple is always computed against the
// channel's baseline_median frozen at experiment-registration time, never a
// live median. If mid-experiment view growth shifted the real median, using
// a live value here would silently distort later pairs' multiples relative
// to earlier ones -- the caller can no longer pass an arbitrary
// channelMedianAt7d in.
function recordMetrics(id, { viewCountAt7d, avgViewDurationPct } = {}) {
  if (!Number.isFinite(viewCountAt7d)) {
    throw createHttpError(400, 'INVALID_METRICS', 'viewCountAt7d is required');
  }
  const assignment = db.getAbAssignment(id);
  if (!assignment) {
    throw createHttpError(404, 'AB_ASSIGNMENT_NOT_FOUND', 'assignment not found');
  }
  const channel = db.getExperimentChannel(assignment.target_channel_id);
  if (!channel || !Number.isFinite(channel.baseline_median) || channel.baseline_median <= 0) {
    throw createHttpError(400, 'CHANNEL_BASELINE_MISSING', 'this assignment\'s channel has no positive baseline_median registered');
  }
  const channelMedianAt7d = channel.baseline_median;
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

// Registers one experiment channel (role 'A' or 'B'). Insert-only -- see the
// experiment_channels schema comment for why there's no corresponding
// update function.
function registerChannel({ channelId, channelName, role, baselineMedian } = {}) {
  if (!channelId) {
    throw createHttpError(400, 'CHANNEL_ID_REQUIRED', 'channelId is required');
  }
  if (!Number.isFinite(baselineMedian) || baselineMedian <= 0) {
    throw createHttpError(400, 'BASELINE_MEDIAN_REQUIRED', 'a positive baselineMedian is required');
  }
  return db.registerExperimentChannel({ channelId, channelName, role, baselineMedian, now: nowIso() });
}

function listChannels() {
  return db.getExperimentChannels();
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
    .map((m) => {
      const minutes = Math.round(Math.abs(m.publish_drift_sec) / 60);
      const direction = m.publish_drift_sec > 0 ? '늦게' : '일찍';
      const thresholdMinutes = Math.round(DRIFT_WARNING_THRESHOLD_SEC / 60);
      return {
        id: m.id,
        pairId: m.pair_id,
        groupLabel: m.group_label,
        publishDriftSec: m.publish_drift_sec,
        reason: `계획된 발행 슬롯보다 ${minutes}분 ${direction} 발행됨 (허용 임계치 ${thresholdMinutes}분 초과 -- 쌍 내 시간대 상쇄가 무너졌을 수 있음)`
      };
    });

  // Channel bias audit (PLAYBOOK.md section 3 amendment): T/C counts per
  // channel across the whole ledger. Reference only -- if channelAssignment-
  // ForPair()'s hash were biased, one channel would lean disproportionately
  // T or C here, but the primary verdict never depends on this being balanced.
  const channelRows = db.getChannelGroupDistribution();
  const channels = db.getExperimentChannels();
  const channelDistribution = channels.map((ch) => {
    const tRow = channelRows.find((r) => r.target_channel_id === ch.channel_id && r.group_label === 'T');
    const cRow = channelRows.find((r) => r.target_channel_id === ch.channel_id && r.group_label === 'C');
    return {
      channelId: ch.channel_id,
      channelName: ch.channel_name,
      role: ch.role,
      T: tRow?.n || 0,
      C: cRow?.n || 0
    };
  });

  // Channel-stratified median diff (PLAYBOOK.md section 3 amendment): a
  // fixed-effect-lite reference view, computed per channel among eligible
  // pairs' T member's channel. Not a real regression and never a decision
  // input -- the channel axis already balances channel exposure by design
  // (independent hash), so the primary verdict stays Wilcoxon over the
  // whole eligible sample, same as before the channel axis existed.
  const channelStratified = channels.map((ch) => {
    const pairsForChannel = eligible.filter((p) => p.t.target_channel_id === ch.channel_id || p.c.target_channel_id === ch.channel_id);
    const chDiffs = pairsForChannel.map((p) => p.t.success_multiple_at_7d - p.c.success_multiple_at_7d);
    return {
      channelId: ch.channel_id,
      channelName: ch.channel_name,
      role: ch.role,
      n: pairsForChannel.length,
      medianDiffTMinusC: median(chDiffs)
    };
  });

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
    channelDistribution,
    channelStratified: {
      channels: channelStratified,
      note: '참고용 채널 고정효과 스냅샷 -- 주 판정은 여전히 전체 표본 Wilcoxon (PLAYBOOK.md section 3)'
    },
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
  channelAssignmentForPair,
  assertPairIntegrity,
  registerChannel,
  listChannels,
  createPair,
  markProduced,
  markPublished,
  markDropped,
  recordMetrics,
  computeDecisionReport
};
