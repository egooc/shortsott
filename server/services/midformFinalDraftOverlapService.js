const fs = require('fs');

const THRESHOLDS = {
  pairwise_overlap_score: 0.65,
  opening_similarity_score: 0.45,
  chain_similarity_score: 0.55,
  top_highlight_cluster_ordering_similarity_score: 0.8,
  shared_contiguous_block_max_sec: 6.0
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

function compareFinalDraftClipChains(koChain, jaChain, thresholds = THRESHOLDS) {
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

function compareFinalDraftFiles(koDraftContentPath, jaDraftContentPath, thresholds = THRESHOLDS) {
  const koChain = extractVideoClipChain(koDraftContentPath);
  const jaChain = extractVideoClipChain(jaDraftContentPath);
  return {
    ...compareFinalDraftClipChains(koChain, jaChain, thresholds),
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
