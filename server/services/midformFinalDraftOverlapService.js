const fs = require('fs');

const THRESHOLDS = {
  pairwise_overlap_score: 0.65,
  opening_similarity_score: 0.45,
  chain_similarity_score: 0.55,
  top_highlight_cluster_ordering_similarity_score: 0.8,
  shared_contiguous_block_max_sec: 6.0,
  clone_tolerance_sec: 0.05
};

function round3(value) {
  return Number(Number(value || 0).toFixed(3));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function usToSec(value) {
  return round3(Number(value || 0) / 1_000_000);
}

function rangeDuration(range) {
  return Math.max(0, Number(range?.[1] || 0) - Number(range?.[0] || 0));
}

function rangeOverlap(a, b) {
  return Math.max(0, Math.min(Number(a?.[1] || 0), Number(b?.[1] || 0)) - Math.max(Number(a?.[0] || 0), Number(b?.[0] || 0)));
}

function materialId(segment) {
  return String(segment?.material_id || segment?.materialId || '').trim();
}

function extractVideoClipChainFromDraftContent(draftContent) {
  const tracks = Array.isArray(draftContent?.tracks) ? draftContent.tracks : [];
  const videoTrack = tracks.find((track) => track && track.type === 'video' && (track.name === 'source_video' || Array.isArray(track.segments)));
  const segments = Array.isArray(videoTrack?.segments) ? videoTrack.segments : [];
  return segments
    .map((segment, index) => {
      const source = segment.source_timerange || {};
      const target = segment.target_timerange || {};
      const sourceStart = usToSec(source.start);
      const sourceDuration = usToSec(source.duration);
      const targetStart = usToSec(target.start);
      const targetDuration = usToSec(target.duration);
      return {
        index,
        clip_id: String(segment.id || `video_${index + 1}`),
        material_id: materialId(segment),
        source_range: [sourceStart, round3(sourceStart + sourceDuration)],
        timeline_range: [targetStart, round3(targetStart + targetDuration)],
        duration_sec: targetDuration
      };
    })
    .filter((clip) => rangeDuration(clip.source_range) > 0 && rangeDuration(clip.timeline_range) > 0)
    .sort((left, right) => left.timeline_range[0] - right.timeline_range[0] || left.index - right.index);
}

function extractVideoClipChain(filePath) {
  return extractVideoClipChainFromDraftContent(readJson(filePath));
}

function signatureForClip(clip) {
  const range = clip.source_range || [0, 0];
  return `${Math.round(Number(range[0] || 0))}:${Math.round(Number(range[1] || 0))}`;
}

function topHighlightClusterOrdering(chain) {
  return chain
    .slice()
    .sort((left, right) => Number(right.duration_sec || 0) - Number(left.duration_sec || 0) || Number(left.timeline_range?.[0] || 0) - Number(right.timeline_range?.[0] || 0))
    .slice(0, 3)
    .sort((left, right) => Number(left.timeline_range?.[0] || 0) - Number(right.timeline_range?.[0] || 0))
    .map((clip) => ({
      clip_id: clip.clip_id,
      source_range: clip.source_range,
      timeline_range: clip.timeline_range,
      signature: signatureForClip(clip)
    }));
}

function lcsSimilarity(left, right) {
  if (!left.length || !right.length) return 0;
  const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      dp[i][j] = left[i - 1] === right[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return round3(dp[left.length][right.length] / Math.max(left.length, right.length));
}

function sourceRangeOverlapRatio(leftChain, rightChain) {
  const leftDuration = leftChain.reduce((sum, clip) => sum + rangeDuration(clip.source_range), 0);
  const rightDuration = rightChain.reduce((sum, clip) => sum + rangeDuration(clip.source_range), 0);
  let overlap = 0;
  for (const left of leftChain) {
    for (const right of rightChain) overlap += rangeOverlap(left.source_range, right.source_range);
  }
  const union = Math.max(0.001, leftDuration + rightDuration - overlap);
  return round3(overlap / union);
}

function sharedContiguousBlocks(leftChain, rightChain) {
  const blocks = [];
  for (let i = 0; i < leftChain.length; i += 1) {
    for (let j = 0; j < rightChain.length; j += 1) {
      let k = 0;
      let duration = 0;
      const clips = [];
      while (leftChain[i + k] && rightChain[j + k]) {
        const left = leftChain[i + k];
        const right = rightChain[j + k];
        const overlap = rangeOverlap(left.source_range, right.source_range);
        if (overlap < 0.25) break;
        duration += overlap;
        clips.push({ ko_clip_id: left.clip_id, ja_clip_id: right.clip_id, overlap_sec: round3(overlap) });
        k += 1;
      }
      if (clips.length) blocks.push({ ko_start_index: i, ja_start_index: j, length: clips.length, duration_sec: round3(duration), clips });
    }
  }
  return blocks.sort((left, right) => right.duration_sec - left.duration_sec || right.length - left.length);
}

function rangesNearlyEqual(leftRange, rightRange, toleranceSec = THRESHOLDS.clone_tolerance_sec) {
  return Math.abs(Number(leftRange?.[0] || 0) - Number(rightRange?.[0] || 0)) <= toleranceSec
    && Math.abs(Number(leftRange?.[1] || 0) - Number(rightRange?.[1] || 0)) <= toleranceSec;
}

function physicalTimelineCloneSignals(koChain, jaChain, thresholds = THRESHOLDS) {
  const toleranceSec = Number(thresholds.clone_tolerance_sec || THRESHOLDS.clone_tolerance_sec);
  const sameClipCount = koChain.length > 0 && koChain.length === jaChain.length;
  const paired = sameClipCount ? koChain.map((koClip, index) => ({ koClip, jaClip: jaChain[index] })) : [];
  const identicalSourceChain = sameClipCount && paired.every(({ koClip, jaClip }) => rangesNearlyEqual(koClip.source_range, jaClip.source_range, toleranceSec));
  const identicalTimelineTiming = sameClipCount && paired.every(({ koClip, jaClip }) => rangesNearlyEqual(koClip.timeline_range, jaClip.timeline_range, toleranceSec));
  const identicalDurations = sameClipCount && paired.every(({ koClip, jaClip }) => Math.abs(Number(koClip.duration_sec || 0) - Number(jaClip.duration_sec || 0)) <= toleranceSec);
  const identicalOpeningClip = sameClipCount && rangesNearlyEqual(koChain[0]?.source_range, jaChain[0]?.source_range, toleranceSec) && rangesNearlyEqual(koChain[0]?.timeline_range, jaChain[0]?.timeline_range, toleranceSec);
  const exactPhysicalTimelineClone = Boolean(sameClipCount && identicalSourceChain && identicalTimelineTiming && identicalDurations && identicalOpeningClip);
  return {
    same_clip_count: sameClipCount,
    identical_source_clip_chain: identicalSourceChain,
    identical_clip_ordering: identicalSourceChain,
    identical_clip_in_out_timing: identicalSourceChain && identicalTimelineTiming,
    identical_opening_frame_or_clip: identicalOpeningClip,
    identical_physical_video_timeline: exactPhysicalTimelineClone,
    exact_physical_timeline_clone: exactPhysicalTimelineClone
  };
}

function normalizeComparableValue(value) {
  if (Array.isArray(value)) return value.map(normalizeComparableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeComparableValue(value[key])]));
}

function extractDraftContentSignature(draftContent) {
  const tracks = Array.isArray(draftContent?.tracks) ? draftContent.tracks : [];
  return tracks
    .filter((track) => track && track.type !== 'video')
    .map((track) => ({
      type: String(track.type || ''),
      segments: (Array.isArray(track.segments) ? track.segments : []).map((segment) => normalizeComparableValue({
        text: segment.text || segment.content || segment.caption_text || segment.subtitle_text || segment.narration || segment.narration_text || segment.dialogue || '',
        target_timerange: segment.target_timerange || null,
        source_timerange: segment.source_timerange || null
      }))
    }));
}

function contentCloneSignals(koContent, jaContent) {
  const koSignature = JSON.stringify(normalizeComparableValue(koContent || []));
  const jaSignature = JSON.stringify(normalizeComparableValue(jaContent || []));
  return {
    compared: koContent !== undefined || jaContent !== undefined,
    identical_narration_dialogue_subtitle_content: koSignature === jaSignature
  };
}

function warningSignals({ pairwiseScore, openingSimilarity, chainSimilarity, topHighlightSimilarity, maxBlockSec, threeShot, overlapRatio, thresholds }) {
  const warnings = [];
  if (pairwiseScore > thresholds.pairwise_overlap_score) warnings.push('pairwise_overlap_high');
  if (openingSimilarity > thresholds.opening_similarity_score) warnings.push('opening_similarity_high');
  if (chainSimilarity > thresholds.chain_similarity_score) warnings.push('chain_similarity_high');
  if (topHighlightSimilarity > thresholds.top_highlight_cluster_ordering_similarity_score) warnings.push('top_highlight_order_similar');
  if (maxBlockSec > thresholds.shared_contiguous_block_max_sec) warnings.push('shared_contiguous_block_long');
  if (threeShot) warnings.push('three_shot_source_reuse');
  if (overlapRatio > 0.65) warnings.push('source_reuse_high');
  return [...new Set(warnings)];
}

function compareFinalDraftClipChains(koChain, jaChain, thresholds = THRESHOLDS, contentSignals = null) {
  if (!koChain.length || !jaChain.length) {
    return {
      pair: 'ko_vs_ja',
      comparison_level: 'final_draft_video_track',
      pairwise_overlap_score: 1,
      opening_similarity_score: 1,
      chain_similarity_score: 1,
      source_range_overlap_ratio: 1,
      top_highlight_cluster_ordering_similarity_score: 1,
      top_highlight_cluster_ordering: { ko: [], ja: [], identical: true },
      shared_contiguous_blocks: [],
      shared_contiguous_block_max_sec: 0,
      three_shot_identical_chain_detected: false,
      failed_gates: ['missing_video_clip_chain'],
      warning_gates: [],
      clone_signals: { exact_physical_timeline_clone: false },
      thresholds,
      final_status: 'failed'
    };
  }
  const koOpening = koChain.filter((clip) => Number(clip.timeline_range?.[0] || 0) < 15);
  const jaOpening = jaChain.filter((clip) => Number(clip.timeline_range?.[0] || 0) < 15);
  const chainSimilarity = lcsSimilarity(koChain.map(signatureForClip), jaChain.map(signatureForClip));
  const openingSimilarity = lcsSimilarity(koOpening.map(signatureForClip), jaOpening.map(signatureForClip));
  const overlapRatio = sourceRangeOverlapRatio(koChain, jaChain);
  const koTopHighlightOrder = topHighlightClusterOrdering(koChain);
  const jaTopHighlightOrder = topHighlightClusterOrdering(jaChain);
  const topHighlightSimilarity = lcsSimilarity(koTopHighlightOrder.map((clip) => clip.signature), jaTopHighlightOrder.map((clip) => clip.signature));
  const blocks = sharedContiguousBlocks(koChain, jaChain);
  const maxBlockSec = round3(blocks[0]?.duration_sec || 0);
  const threeShot = blocks.some((block) => block.length >= 3);
  const pairwiseScore = round3((overlapRatio * 0.35) + (chainSimilarity * 0.25) + (openingSimilarity * 0.25) + (topHighlightSimilarity * 0.15));
  const physicalCloneSignals = physicalTimelineCloneSignals(koChain, jaChain, thresholds);
  const content = contentSignals || contentCloneSignals(undefined, undefined);
  const exactClone = physicalCloneSignals.exact_physical_timeline_clone && content.identical_narration_dialogue_subtitle_content;
  const cloneSignals = {
    ...physicalCloneSignals,
    ...content,
    exact_physical_timeline_clone: exactClone,
    exact_output_clone: exactClone
  };
  const failed = exactClone ? ['exact_physical_timeline_clone'] : [];
  const warnings = warningSignals({ pairwiseScore, openingSimilarity, chainSimilarity, topHighlightSimilarity, maxBlockSec, threeShot, overlapRatio, thresholds });
  const finalStatus = failed.length ? 'failed' : (warnings.length ? 'passed_with_warnings' : 'passed');
  return {
    pair: 'ko_vs_ja',
    comparison_level: 'final_draft_video_track',
    pairwise_overlap_score: pairwiseScore,
    opening_similarity_score: openingSimilarity,
    chain_similarity_score: chainSimilarity,
    source_range_overlap_ratio: overlapRatio,
    top_highlight_cluster_ordering_similarity_score: topHighlightSimilarity,
    top_highlight_cluster_ordering: {
      ko: koTopHighlightOrder,
      ja: jaTopHighlightOrder,
      identical: JSON.stringify(koTopHighlightOrder.map((clip) => clip.signature)) === JSON.stringify(jaTopHighlightOrder.map((clip) => clip.signature))
    },
    shared_contiguous_blocks: blocks,
    shared_contiguous_block_max_sec: maxBlockSec,
    three_shot_identical_chain_detected: threeShot,
    failed_gates: failed,
    warning_gates: warnings,
    clone_signals: cloneSignals,
    thresholds,
    final_status: finalStatus
  };
}

function compareFinalDraftFiles(koDraftContentPath, jaDraftContentPath, thresholds = THRESHOLDS) {
  const koDraftContent = readJson(koDraftContentPath);
  const jaDraftContent = readJson(jaDraftContentPath);
  const koChain = extractVideoClipChainFromDraftContent(koDraftContent);
  const jaChain = extractVideoClipChainFromDraftContent(jaDraftContent);
  return {
    ...compareFinalDraftClipChains(koChain, jaChain, thresholds, contentCloneSignals(extractDraftContentSignature(koDraftContent), extractDraftContentSignature(jaDraftContent))),
    ko_clip_count: koChain.length,
    ja_clip_count: jaChain.length
  };
}

module.exports = {
  THRESHOLDS,
  compareFinalDraftClipChains,
  compareFinalDraftFiles,
  extractVideoClipChain,
  extractVideoClipChainFromDraftContent,
  _test: {
    lcsSimilarity,
    contentCloneSignals,
    extractDraftContentSignature,
    physicalTimelineCloneSignals,
    sharedContiguousBlocks,
    sourceRangeOverlapRatio,
    topHighlightClusterOrdering
  }
};
