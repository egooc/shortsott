const { createHttpError } = require('./errorService');
const { requireApiKey } = require('../middleware/auth');
const { extractActionTimeline } = require('./geminiService');
const { isVertexAdcMode } = require('./processMetadataService');
const { findBestSeamWindow } = require('../utils/loopSeam');
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

  const apiKey = isVertexAdcMode() ? '' : requireApiKey('GEMINI_API_KEY');
  const { events } = await extractActionTimeline({
    filePath: video.video_path,
    sourceUrl: video.youtube_url,
    apiKey
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

// Heuristic defaults, not derived from data -- tune once real slicer usage shows
// whether these anchors actually land on good cut points. targetDurationSec
// defaults to the legacy 3.0s single-target behavior (generateSliceCandidates);
// generateDurationPairCandidates passes DURATION_GROUPS.SHORT/LONG.target.
function buildCandidateWindow(pattern, events, durationSec, targetDurationSec = TARGET_DURATION_SEC) {
  const impactTimes = events.filter((e) => e.event_type === 'IMPACT').map((e) => e.start_time).filter(Number.isFinite);
  const resetTimes = events.filter((e) => e.event_type === 'RESET').map((e) => e.start_time).filter(Number.isFinite);
  const resultTimes = events.filter((e) => e.event_type === 'RESULT_REVEAL').map((e) => e.start_time).filter(Number.isFinite);

  if (pattern.action_phase === 'PRE_IMPACT_CUT' && impactTimes.length) {
    const impact = impactTimes[0];
    return clampWindow(impact - targetDurationSec + 0.1, impact - 0.1, durationSec);
  }
  if (pattern.action_phase === 'IMPACT_CENTERED' && impactTimes.length) {
    const impact = impactTimes[0];
    return clampWindow(impact - targetDurationSec / 2, impact + targetDurationSec / 2, durationSec);
  }
  // patternStats() reports 'PROCESS' (not 'FULL_ARC'/'MID_PROCESS' individually)
  // -- the two were merged there after repeated calibration showed Gemini can't
  // reliably tell them apart. Apply the impact-anchored/reset-snap heuristic
  // (previously FULL_ARC-only) to the whole merged category rather than
  // silently losing candidate generation for what's now the most common bucket.
  if (pattern.action_phase === 'PROCESS' && impactTimes.length) {
    const impact = impactTimes[0];
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
async function buildDurationWindow(video, events, pattern, durationGroupKey) {
  const group = DURATION_GROUPS[durationGroupKey];
  const durationSec = Number(video.duration_seconds) || 0;
  const initialWindow = buildCandidateWindow(pattern, events, durationSec, group.target);
  if (!initialWindow) return null;
  const windowDuration = initialWindow.end - initialWindow.start;
  if (windowDuration <= 0.5) return null;

  const result = { target_duration_group: durationGroupKey };
  try {
    const { bestStart, bestScore } = await findBestSeamWindow(video.video_path, initialWindow.start, windowDuration, SEAM_SEARCH_OPTIONS);
    result.start_sec = Number(bestStart.toFixed(2));
    result.end_sec = Number((bestStart + windowDuration).toFixed(2));
    result.seam_similarity = Math.round(bestScore * 100);
  } catch {
    result.start_sec = Number(initialWindow.start.toFixed(2));
    result.end_sec = Number(initialWindow.end.toFixed(2));
    result.seam_similarity = null;
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

  for (const pattern of topPatterns) {
    const [short, long] = await Promise.all([
      buildDurationWindow(video, events, pattern, 'SHORT'),
      buildDurationWindow(video, events, pattern, 'LONG')
    ]);
    if (!short || !long) continue;

    return {
      pair: {
        source_video_id: videoId,
        pattern: { action_phase: pattern.action_phase, seam_bucket: pattern.seam_bucket, moment_type: pattern.moment_type },
        predicted_exploded_rate: pattern.exploded_rate,
        sample_size: pattern.n,
        short,
        long
      }
    };
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
  DURATION_GROUPS,
  scoreSourceForCutSelection,
  rankSourcesForCutSelection
};
