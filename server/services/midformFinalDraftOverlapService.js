const fs = require('fs');

// The locales are allowed to share footage. What separates them is the language layer
// (their own script, voice track and subtitles) plus differing cut points, frame starts
// and ordering — so these gates only need to catch a wholesale identical edit, not any
// reuse of the same shots.
const THRESHOLDS = {
  pairwise_overlap_score: 0.88,
  opening_similarity_score: 0.75,
  chain_similarity_score: 0.85,
  top_highlight_cluster_ordering_similarity_score: 0.9,
  shared_contiguous_block_max_sec: 20.0
};

// Two clips count as the same cut only when their in/out points essentially coincide; a
// shifted frame start is a real difference, not a duplicate.
const IDENTICAL_CUT_TOLERANCE_SEC = 0.5;

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

// KEEP_DIALOGUE (and scene-hook) footage is pinned to the same true source windows in
// every locale, so KO/JA sharing it is by design, not a duplicate-output signal. Overlaps
// that fall inside an excluded window (with cut-in padding tolerance) end the block
// instead of counting toward it.
function overlapWithinExcludedWindow(left, right, excludedWindows) {
  if (!Array.isArray(excludedWindows) || !excludedWindows.length) return false;
  const start = Math.max(Number(left.source_range?.[0] || 0), Number(right.source_range?.[0] || 0));
  const end = Math.min(Number(left.source_range?.[1] || 0), Number(right.source_range?.[1] || 0));
  if (end <= start) return false;
  return excludedWindows.some(([windowStart, windowEnd]) => start >= Number(windowStart) - 1.0 && end <= Number(windowEnd) + 1.0);
}

function sharedContiguousBlocks(leftChain, rightChain, excludedWindows = []) {
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
        if (overlapWithinExcludedWindow(left, right, excludedWindows)) break;
        duration += overlap;
        const identicalCut = Math.abs(Number(left.source_range?.[0] || 0) - Number(right.source_range?.[0] || 0)) <= IDENTICAL_CUT_TOLERANCE_SEC
          && Math.abs(Number(left.source_range?.[1] || 0) - Number(right.source_range?.[1] || 0)) <= IDENTICAL_CUT_TOLERANCE_SEC;
        clips.push({ ko_clip_id: left.clip_id, ja_clip_id: right.clip_id, overlap_sec: round3(overlap), identical_cut: identicalCut });
        k += 1;
      }
      if (clips.length) blocks.push({ ko_start_index: i, ja_start_index: j, length: clips.length, duration_sec: round3(duration), clips });
    }
  }
  return blocks.sort((left, right) => right.duration_sec - left.duration_sec || right.length - left.length);
}

function compareFinalDraftClipChains(koChain, jaChain, thresholds = THRESHOLDS, excludedWindows = []) {
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
      thresholds,
      final_status: 'fail'
    };
  }
  // A clip pinned to a fixed window (the scene hook, a preserved dialogue line) plays in
  // every locale by design, so it must not count as opening duplication.
  const isFixedWindowClip = (clip) => (Array.isArray(excludedWindows) ? excludedWindows : []).some(([start, end]) => (
    Number(clip.source_range?.[0] || 0) >= Number(start) - 1.0 && Number(clip.source_range?.[1] || 0) <= Number(end) + 1.0
  ));
  const openingClips = (chain) => chain.filter((clip) => Number(clip.timeline_range?.[0] || 0) < 15 && !isFixedWindowClip(clip));
  const koOpening = openingClips(koChain);
  const jaOpening = openingClips(jaChain);
  // Chain similarity must only look at clips the locales were free to choose. Pinned
  // dialogue/hook windows play in both locales in chronological order by design, so on a
  // dialogue-heavy single-scene source they alone push LCS ~0.9 with no copying involved.
  const freeClips = (chain) => chain.filter((clip) => !isFixedWindowClip(clip));
  const koFree = freeClips(koChain);
  const jaFree = freeClips(jaChain);
  const chainSimilarity = koFree.length && jaFree.length
    ? lcsSimilarity(koFree.map(signatureForClip), jaFree.map(signatureForClip))
    : 0;
  const openingSimilarity = lcsSimilarity(koOpening.map(signatureForClip), jaOpening.map(signatureForClip));
  const overlapRatio = sourceRangeOverlapRatio(koChain, jaChain);
  // Same principle as chain similarity: pinned dialogue/hook windows play in both locales
  // in story order BY DESIGN - on a dialogue-heavy source they ARE the top highlights and
  // pushed ordering similarity to 1.0 with no copying involved. Order only the free picks.
  const koTopHighlightOrder = topHighlightClusterOrdering(koFree);
  const jaTopHighlightOrder = topHighlightClusterOrdering(jaFree);
  const topHighlightSimilarity = lcsSimilarity(koTopHighlightOrder.map((clip) => clip.signature), jaTopHighlightOrder.map((clip) => clip.signature));
  const blocks = sharedContiguousBlocks(koChain, jaChain, excludedWindows);
  const maxBlockSec = round3(blocks[0]?.duration_sec || 0);
  // Only a run of genuinely identical cuts signals a copied edit; the same shots entered
  // at different frames are a legitimately different cut.
  const threeShot = blocks.some((block) => (block.clips || []).filter((clip) => clip.identical_cut).length >= 3);
  const pairwiseScore = round3((overlapRatio * 0.35) + (chainSimilarity * 0.25) + (openingSimilarity * 0.25) + (topHighlightSimilarity * 0.15));
  const failed = [];
  if (pairwiseScore > thresholds.pairwise_overlap_score) failed.push('pairwise_overlap_threshold');
  if (openingSimilarity > thresholds.opening_similarity_score) failed.push('opening_similarity_threshold');
  if (chainSimilarity > thresholds.chain_similarity_score) failed.push('chain_similarity_threshold');
  if (topHighlightSimilarity > thresholds.top_highlight_cluster_ordering_similarity_score) failed.push('top_highlight_cluster_ordering_threshold');
  if (maxBlockSec > thresholds.shared_contiguous_block_max_sec) failed.push('shared_contiguous_block_threshold');
  if (threeShot) failed.push('three_shot_identical_chain');
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
    thresholds,
    final_status: failed.length ? 'fail' : 'pass'
  };
}

function compareFinalDraftFiles(koDraftContentPath, jaDraftContentPath, thresholds = THRESHOLDS, excludedWindows = []) {
  const koChain = extractVideoClipChain(koDraftContentPath);
  const jaChain = extractVideoClipChain(jaDraftContentPath);
  return {
    ...compareFinalDraftClipChains(koChain, jaChain, thresholds, excludedWindows),
    excluded_fixed_windows: excludedWindows,
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
    sharedContiguousBlocks,
    sourceRangeOverlapRatio,
    topHighlightClusterOrdering
  }
};
