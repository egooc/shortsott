const { createHttpError } = require('./errorService');
const { extractActionTimeline } = require('./geminiService');
const { findBestSeamWindow } = require('../utils/loopSeam');
const { getVideoMetadata } = require('../utils/ffprobe');
const db = require('./highlightPatternDbService');
const cutSelectionProfile = require('../config/cutSelectionProfile.json');

const TARGET_DURATION_SEC = 3.0;
const TOP_PATTERN_COUNT = 3;
const SEAM_SEARCH_OPTIONS = { slideRange: 0.4, step: 0.1 };

// Audit log (cut-selection profile amendment): why DESTRUCTION is a soft
// bonus and not a hard condition should be visible at a glance without
// having to go dig up the cross-section report that produced this profile.
{
  const bias = cutSelectionProfile.soft_bonus_observed;
  console.log(
    `[cutSelectionProfile] ${cutSelectionProfile.id} v${cutSelectionProfile.version} loaded. `
    + `DESTRUCTION는 soft_bonus만 적용됨 (n=${bias.n} 채널 편중: ${bias.dominant_channel_name} `
    + `${Math.round(bias.dominant_channel_share * 100)}%, rate=${Math.round(bias.dominant_channel_rate * 100)}%). `
    + `재평가 조건: ${bias.reevaluate_condition}`
  );
}

// Track B duration A/B (PLAYBOOK.md section 3): SHORT = treatment (3-5s),
// LONG = control (6-10s). Target is the midpoint of each range; actual
// candidate windows can land anywhere in [min, max] once anchored to events.
const DURATION_GROUPS = {
  SHORT: { min: 3, max: 5, target: 4 },
  LONG: { min: 6, max: 10, target: 8 }
};
// How close a RESET-to-RESET gap must be to the target duration to count as
// "completes one visible cycle" (there's no visible_cycle_count field from
// Gemini -- RESET timestamps already mark loop-restart points, so a pair of
// them bracketing the impact IS the cycle boundary).
const CYCLE_ALIGNMENT_TOLERANCE_SEC = 1.0;

async function extractTimeline(videoId) {
  const video = db.getVideoRow(videoId);
  if (!video) {
    throw createHttpError(404, 'VIDEO_NOT_FOUND', 'video not found');
  }
  if (video.analysis_mode !== 'slice_source') {
    throw createHttpError(400, 'NOT_A_SLICE_SOURCE', 'extract-timeline only applies to analysis_mode=slice_source videos');
  }
  if (!video.video_path) {
    throw createHttpError(400, 'VIDEO_NOT_DOWNLOADED', 'This video has not finished downloading yet');
  }

  const { events } = await extractActionTimeline({
    filePath: video.video_path,
    sourceUrl: video.youtube_url
  });

  db.replaceSegments(videoId, events.map((event) => ({
    start_time: event.time,
    end_time: event.time,
    event_type: event.type,
    description: event.description
  })));

  return { events: db.getSegments(videoId) };
}

function clampWindow(start, end, durationSec) {
  return { start: Math.max(0, start), end: Math.min(durationSec, end) };
}

function effectiveVideoDurationSec(video = {}) {
  const localDuration = video?.video_path ? Number(getVideoMetadata(video.video_path)?.duration_sec || 0) : 0;
  const declaredDuration = Number(video?.duration_seconds || 0);
  if (Number.isFinite(localDuration) && localDuration > 0) return localDuration;
  return Number.isFinite(declaredDuration) && declaredDuration > 0 ? declaredDuration : 0;
}

// Looks for two RESET timestamps spaced close to targetDurationSec apart that
// bracket the anchor (impact) time -- i.e. a window that starts and ends on a
// natural loop-restart point AND contains the decisive moment, so the cut
// completes one visible cycle rather than slicing mid-cycle. Returns null if
// no such pair exists within tolerance.
function findCycleAlignedWindow(resetTimes, anchorTime, targetDurationSec, tolerance = CYCLE_ALIGNMENT_TOLERANCE_SEC) {
  if (resetTimes.length < 2) return null;
  const sorted = [...resetTimes].sort((a, b) => a - b);
  let best = null;
  let bestGapDiff = Infinity;
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const start = sorted[i];
      const end = sorted[j];
      const gap = end - start;
      const gapDiff = Math.abs(gap - targetDurationSec);
      if (gapDiff > tolerance) continue;
      if (anchorTime !== null && (anchorTime < start || anchorTime > end)) continue;
      if (gapDiff < bestGapDiff) {
        bestGapDiff = gapDiff;
        best = { start, end };
      }
    }
  }
  return best;
}

function eventTimes(events, eventType) {
  return events.filter((event) => event.event_type === eventType).map((event) => event.start_time).filter(Number.isFinite);
}

function buildResetCompleteWindow(events, durationSec, anchorTime, targetDurationSec) {
  const resetTimes = eventTimes(events, 'RESET');
  const cycleWindow = findCycleAlignedWindow(resetTimes, anchorTime, targetDurationSec);
  if (!cycleWindow) return null;
  const clamped = clampWindow(cycleWindow.start, cycleWindow.end, durationSec);
  return {
    start: clamped.start,
    end: clamped.end,
    proof: {
      anchor_time_sec: Number(anchorTime.toFixed(2)),
      reset_start_sec: Number(cycleWindow.start.toFixed(2)),
      reset_end_sec: Number(cycleWindow.end.toFixed(2)),
      cycle_gap_sec: Number((cycleWindow.end - cycleWindow.start).toFixed(2)),
      gap_diff_sec: Number(Math.abs((cycleWindow.end - cycleWindow.start) - targetDurationSec).toFixed(2))
    }
  };
}

// Heuristic defaults, not derived from data -- tune once real slicer usage shows
// whether these anchors actually land on good cut points. targetDurationSec
// defaults to the legacy 3.0s single-target behavior (generateSliceCandidates);
// generateDurationPairCandidates passes DURATION_GROUPS.SHORT/LONG.target.
function buildCandidateWindow(pattern, events, durationSec, targetDurationSec = TARGET_DURATION_SEC, options = {}) {
  const impactTimes = events.filter((e) => e.event_type === 'IMPACT').map((e) => e.start_time).filter(Number.isFinite);
  const resetTimes = events.filter((e) => e.event_type === 'RESET').map((e) => e.start_time).filter(Number.isFinite);
  const resultTimes = events.filter((e) => e.event_type === 'RESULT_REVEAL').map((e) => e.start_time).filter(Number.isFinite);
  const chosenImpact = Number.isFinite(options.anchorTime) ? options.anchorTime : impactTimes[0];

  if (pattern.action_phase === 'PRE_IMPACT_CUT' && impactTimes.length) {
    const impact = chosenImpact;
    return clampWindow(impact - targetDurationSec + 0.1, impact - 0.1, durationSec);
  }
  if (pattern.action_phase === 'IMPACT_CENTERED' && impactTimes.length) {
    const impact = chosenImpact;
    return clampWindow(impact - targetDurationSec / 2, impact + targetDurationSec / 2, durationSec);
  }
  // patternStats() reports 'PROCESS' (not 'FULL_ARC'/'MID_PROCESS' individually)
  // -- the two were merged there after repeated calibration showed Gemini can't
  // reliably tell them apart. Apply the impact-anchored/reset-snap heuristic
  // (previously FULL_ARC-only) to the whole merged category rather than
  // silently losing candidate generation for what's now the most common bucket.
  if (pattern.action_phase === 'PROCESS' && impactTimes.length) {
    const impact = chosenImpact;
    // Prefer a window that completes a whole visible cycle (starts and ends
    // on a RESET boundary, contains the impact) over the plain impact-anchored
    // heuristic -- this is specifically what the SHORT (3-5s) treatment arm
    // of the duration A/B needs (PLAYBOOK.md section 3: "가능하면 사이클 완결").
    const cycleWindow = findCycleAlignedWindow(resetTimes, impact, targetDurationSec);
    if (cycleWindow) {
      return clampWindow(cycleWindow.start, cycleWindow.end, durationSec);
    }
    const idealStart = impact - targetDurationSec * 0.6;
    const nearestReset = resetTimes.reduce(
      (best, t) => (best === null || Math.abs(t - idealStart) < Math.abs(best - idealStart) ? t : best),
      null
    );
    const start = nearestReset !== null && Math.abs(nearestReset - idealStart) <= 1 ? nearestReset : idealStart;
    return clampWindow(start, start + targetDurationSec, durationSec);
  }
  if (pattern.action_phase === 'RESULT_ONLY' && resultTimes.length) {
    const result = resultTimes[0];
    return clampWindow(result - 0.5, result - 0.5 + targetDurationSec, durationSec);
  }
  // Anchor-less pattern (e.g. UNKNOWN): no reliable anchor to cut around.
  return null;
}

async function generateSliceCandidates(videoId) {
  const video = db.getVideoRow(videoId);
  if (!video) {
    throw createHttpError(404, 'VIDEO_NOT_FOUND', 'video not found');
  }
  if (!video.video_path) {
    throw createHttpError(400, 'VIDEO_NOT_DOWNLOADED', 'This video has not finished downloading yet');
  }
  const events = db.getSegments(videoId);
  if (!events.length) {
    throw createHttpError(400, 'TIMELINE_NOT_EXTRACTED', 'Run extract-timeline before requesting slice candidates');
  }

  const topPatterns = db.patternStats().slice(0, TOP_PATTERN_COUNT);
  if (!topPatterns.length) {
    return { candidates: [], message: '학습 데이터가 아직 부족해 패턴 통계를 계산할 수 없습니다 (조합당 최소 3건의 EXPLODED/BURIED 학습 클립이 필요합니다).' };
  }

  const durationSec = Number(video.duration_seconds) || 0;
  const candidates = [];

  for (const pattern of topPatterns) {
    const initialWindow = buildCandidateWindow(pattern, events, durationSec);
    if (!initialWindow) continue;
    const windowDuration = initialWindow.end - initialWindow.start;
    if (windowDuration <= 0.5) continue;

    const candidate = {
      pattern: { action_phase: pattern.action_phase, seam_bucket: pattern.seam_bucket, moment_type: pattern.moment_type },
      predicted_exploded_rate: pattern.exploded_rate,
      sample_size: pattern.n
    };

    try {
      const { bestStart, bestScore } = await findBestSeamWindow(video.video_path, initialWindow.start, windowDuration, SEAM_SEARCH_OPTIONS);
      candidate.start_sec = Number(bestStart.toFixed(2));
      candidate.end_sec = Number((bestStart + windowDuration).toFixed(2));
      candidate.seam_similarity = Math.round(bestScore * 100);
    } catch {
      candidate.start_sec = Number(initialWindow.start.toFixed(2));
      candidate.end_sec = Number(initialWindow.end.toFixed(2));
      candidate.seam_similarity = null;
    }

    candidates.push(candidate);
  }

  if (!candidates.length) {
    return { candidates: [], message: '상위 패턴에 맞는 앵커(임팩트/결과 노출/리셋 지점)를 이 영상의 타임라인에서 찾지 못했습니다.' };
  }

  return { candidates };
}

// Track B duration A/B (PLAYBOOK.md section 3): builds ONE SHORT (3-5s) and
// ONE LONG (6-10s) candidate window from the same source video and the same
// top pattern, so the pair differs only in duration -- everything else
// (source material, channel, anchor logic) is held constant within the pair.
async function buildDurationWindow(video, events, pattern, durationGroupKey, options = {}) {
  const group = DURATION_GROUPS[durationGroupKey];
  const durationSec = effectiveVideoDurationSec(video);
  const initialWindow = options.requireResetComplete
    ? buildResetCompleteWindow(events, durationSec, options.anchorTime, group.target)
    : buildCandidateWindow(pattern, events, durationSec, group.target, options);
  if (!initialWindow) return null;
  const windowDuration = initialWindow.end - initialWindow.start;
  if (windowDuration <= 0.5) return null;
  if (windowDuration < group.min || windowDuration > group.max) return null;

  const result = {
    target_duration_group: durationGroupKey,
    ...(Number.isFinite(options.anchorTime) ? {
      anchor_time_sec: Number(options.anchorTime.toFixed(2))
    } : {}),
    ...(!initialWindow.proof && Number.isFinite(options.anchorTime) ? {
      selection_mode: 'impact_anchor_search'
    } : {}),
    ...(initialWindow.proof ? {
      selection_mode: 'reset_complete_anchor_search',
      anchor_time_sec: initialWindow.proof.anchor_time_sec,
      reset_start_sec: initialWindow.proof.reset_start_sec,
      reset_end_sec: initialWindow.proof.reset_end_sec,
      cycle_gap_sec: initialWindow.proof.cycle_gap_sec,
      gap_diff_sec: initialWindow.proof.gap_diff_sec
    } : {})
  };
  try {
    const { bestStart, bestScore } = await findBestSeamWindow(video.video_path, initialWindow.start, windowDuration, SEAM_SEARCH_OPTIONS);
    const candidateDuration = Number((windowDuration).toFixed(2));
    if (candidateDuration < group.min || candidateDuration > group.max) return null;
    result.start_sec = Number(bestStart.toFixed(2));
    result.end_sec = Number((bestStart + windowDuration).toFixed(2));
    result.seam_similarity = Math.round(bestScore * 100);
    if (initialWindow.proof) {
      result.seam_start_drift_sec = Number((result.start_sec - initialWindow.proof.reset_start_sec).toFixed(2));
      result.seam_end_drift_sec = Number((result.end_sec - initialWindow.proof.reset_end_sec).toFixed(2));
    }
  } catch {
    result.start_sec = Number(initialWindow.start.toFixed(2));
    result.end_sec = Number(initialWindow.end.toFixed(2));
    result.seam_similarity = null;
    if (initialWindow.proof) {
      result.seam_start_drift_sec = 0;
      result.seam_end_drift_sec = 0;
    }
  }
  return result;
}

async function generateDurationPairCandidates(videoId) {
  const video = db.getVideoRow(videoId);
  if (!video) {
    throw createHttpError(404, 'VIDEO_NOT_FOUND', 'video not found');
  }
  if (!video.video_path) {
    throw createHttpError(400, 'VIDEO_NOT_DOWNLOADED', 'This video has not finished downloading yet');
  }
  const events = db.getSegments(videoId);
  if (!events.length) {
    throw createHttpError(400, 'TIMELINE_NOT_EXTRACTED', 'Run extract-timeline before requesting slice candidates');
  }

  const topPatterns = db.patternStats().slice(0, TOP_PATTERN_COUNT);
  if (!topPatterns.length) {
    return { pair: null, message: '학습 데이터가 아직 부족해 패턴 통계를 계산할 수 없습니다 (조합당 최소 3건의 EXPLODED/BURIED 학습 클립이 필요합니다).' };
  }

  const impactTimes = eventTimes(events, 'IMPACT');
  if (!impactTimes.length) {
    return { pair: null, message: '타임라인에 IMPACT 이벤트가 없어 SHORT/LONG pair 앵커를 만들 수 없었습니다.' };
  }

  for (const pattern of topPatterns) {
    for (const anchorTime of impactTimes) {
      const [short, long] = await Promise.all([
        buildDurationWindow(video, events, pattern, 'SHORT', { requireResetComplete: true, anchorTime }),
        buildDurationWindow(video, events, pattern, 'LONG', { requireResetComplete: false, anchorTime })
      ]);
      if (!short || !long) continue;

      return {
        pair: {
          source_video_id: videoId,
          pattern: { action_phase: pattern.action_phase, seam_bucket: pattern.seam_bucket, moment_type: pattern.moment_type },
          predicted_exploded_rate: pattern.exploded_rate,
          sample_size: pattern.n,
          selected_anchor_time_sec: Number(anchorTime.toFixed(2)),
          short,
          long
        }
      };
    }
  }

  return { pair: null, message: '상위 패턴에 맞는 앵커를 찾지 못해 SHORT/LONG 두 윈도우를 모두 만들 수 없었습니다.' };
}

// --- Source-selection scoring (cut-selection profile v1) ---
// Deliberately a separate stage from everything above: this decides WHICH
// source video to slice next, never WHERE within a video to cut -- window/
// anchor selection stays exactly buildCandidateWindow()'s action_phase
// logic. Scores against cutSelectionProfile.json's hard_conditions (from
// videos/analyses columns) and soft_bonus_conditions (currently just
// DESTRUCTION, capped at soft-bonus per the channel-bias caveat baked into
// the profile -- see the audit log at module load above).

function evaluateHardConditions(video, analysis) {
  return cutSelectionProfile.hard_conditions.map((c) => {
    let matched = false;
    let actualValue;
    if (c.op === 'range') {
      actualValue = video ? video[c.key] : undefined;
      matched = Number.isFinite(actualValue) && actualValue >= c.min && actualValue <= c.max;
    } else if (c.op === 'eq') {
      actualValue = analysis ? analysis[c.key] : undefined;
      matched = actualValue === c.value;
    }
    return { key: c.key, label: c.label, matched, actualValue: actualValue ?? null };
  });
}

function evaluateSoftBonus(analysis) {
  return cutSelectionProfile.soft_bonus_conditions.map((c) => {
    let actualValue;
    let matched = false;
    if (c.key === 'moment_type_coarse') {
      actualValue = analysis ? db.momentTypeCoarse(analysis.moment_type) : undefined;
      matched = actualValue === c.value;
    }
    return { key: c.key, label: c.label, matched, actualValue: actualValue ?? null, bonus: c.bonus };
  });
}

// One video's cut-selection score. Videos with no analyses row yet (true
// today for most slice_source candidates -- moment-pattern analysis only
// runs for analysis_mode='training', see highlightPatternService.processOne)
// score 0/4 hard matches and sort to the bottom rather than throwing, so a
// mixed queue of analyzed/unanalyzed videos can still be ranked.
function scoreSourceForCutSelection(videoId) {
  const video = db.getVideoRow(videoId);
  if (!video) {
    throw createHttpError(404, 'VIDEO_NOT_FOUND', 'video not found');
  }
  const analysis = db.getLatestAnalysis(videoId);
  const hardResults = evaluateHardConditions(video, analysis);
  const hardMatchCount = hardResults.filter((r) => r.matched).length;
  const softResults = evaluateSoftBonus(analysis);
  const softBonusTotal = softResults.filter((r) => r.matched).reduce((sum, r) => sum + (r.bonus || 0), 0);

  const { hard_condition_weight, soft_bonus_weight, tiers } = cutSelectionProfile.scoring;
  const score = hardMatchCount * hard_condition_weight + softBonusTotal * soft_bonus_weight;
  const tier = [...tiers].sort((a, b) => b.min_hard_matches - a.min_hard_matches)
    .find((t) => hardMatchCount >= t.min_hard_matches).label;

  return {
    videoId,
    title: video.title,
    hasAnalysisData: Boolean(analysis),
    hardMatchCount,
    hardResults,
    softBonusTotal,
    softResults,
    score,
    tier
  };
}

function rankSourcesForCutSelection(videoIds) {
  return videoIds.map(scoreSourceForCutSelection).sort((a, b) => b.score - a.score);
}

module.exports = {
  extractTimeline,
  generateSliceCandidates,
  generateDurationPairCandidates,
  findCycleAlignedWindow,
  DURATION_GROUPS,
  scoreSourceForCutSelection,
  rankSourcesForCutSelection
};
