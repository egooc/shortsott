const assert = require('node:assert/strict');
const test = require('node:test');

const {
  compareFinalDraftClipChains,
  extractVideoClipChainFromDraftContent
} = require('../server/services/midformFinalDraftOverlapService');

function videoSegment(id, sourceStartSec, sourceDurationSec, targetStartSec, targetDurationSec = sourceDurationSec) {
  return {
    id,
    material_id: 'source-video-material',
    source_timerange: { start: Math.round(sourceStartSec * 1_000_000), duration: Math.round(sourceDurationSec * 1_000_000) },
    target_timerange: { start: Math.round(targetStartSec * 1_000_000), duration: Math.round(targetDurationSec * 1_000_000) }
  };
}

function draftContent(segments) {
  return { tracks: [{ type: 'video', name: 'source_video', segments }] };
}

test('extractVideoClipChainFromDraftContent reads source and target timeranges from source_video track', () => {
  const chain = extractVideoClipChainFromDraftContent(draftContent([
    videoSegment('clip_a', 10, 3, 0),
    videoSegment('clip_b', 20, 4, 3)
  ]));

  assert.equal(chain.length, 2);
  assert.deepEqual(chain[0].source_range, [10, 13]);
  assert.deepEqual(chain[0].timeline_range, [0, 3]);
  assert.deepEqual(chain[1].source_range, [20, 24]);
});

test('final draft overlap guard fails identical video source chains', () => {
  const ko = extractVideoClipChainFromDraftContent(draftContent([
    videoSegment('ko_a', 10, 3, 0),
    videoSegment('ko_b', 20, 3, 3),
    videoSegment('ko_c', 30, 3, 6)
  ]));
  const ja = extractVideoClipChainFromDraftContent(draftContent([
    videoSegment('ja_a', 10, 3, 0),
    videoSegment('ja_b', 20, 3, 3),
    videoSegment('ja_c', 30, 3, 6)
  ]));

  const report = compareFinalDraftClipChains(ko, ja);

  assert.equal(report.final_status, 'fail');
  assert.equal(report.three_shot_identical_chain_detected, true);
  assert.ok(report.failed_gates.includes('three_shot_identical_chain'));
  assert.ok(report.pairwise_overlap_score > report.thresholds.pairwise_overlap_score);
});

test('final draft overlap guard passes divergent source chains', () => {
  const ko = extractVideoClipChainFromDraftContent(draftContent([
    videoSegment('ko_a', 10, 3, 0),
    videoSegment('ko_b', 20, 3, 3),
    videoSegment('ko_c', 30, 3, 6)
  ]));
  const ja = extractVideoClipChainFromDraftContent(draftContent([
    videoSegment('ja_a', 60, 3, 0),
    videoSegment('ja_b', 80, 3, 3),
    videoSegment('ja_c', 100, 3, 6)
  ]));

  const report = compareFinalDraftClipChains(ko, ja);

  assert.equal(report.final_status, 'pass');
  assert.equal(report.three_shot_identical_chain_detected, false);
  assert.equal(report.source_range_overlap_ratio, 0);
});

test('final draft overlap guard fails missing video clip chains', () => {
  const ja = extractVideoClipChainFromDraftContent(draftContent([
    videoSegment('ja_a', 60, 3, 0)
  ]));

  const report = compareFinalDraftClipChains([], ja);

  assert.equal(report.final_status, 'fail');
  assert.deepEqual(report.failed_gates, ['missing_video_clip_chain']);
});
