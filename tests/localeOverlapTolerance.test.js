const assert = require('node:assert/strict');
const test = require('node:test');

const { compareFinalDraftClipChains, THRESHOLDS } = require('../server/services/midformFinalDraftOverlapService');

function clip(id, start, end, timelineStart) {
  const duration = end - start;
  return {
    clip_id: id,
    source_range: [start, end],
    timeline_range: [timelineStart, timelineStart + duration],
    duration_sec: duration
  };
}

// KO and JA may draw on the same footage. What must differ is the language layer plus the
// cut points, so shifted in/out points count as a real difference.
test('the same shots entered at different frames are not a duplicate edit', () => {
  const ko = [clip('ko_1', 10, 20, 0), clip('ko_2', 40, 50, 10), clip('ko_3', 80, 90, 20)];
  const ja = [clip('ja_1', 13, 23, 0), clip('ja_2', 44, 54, 10), clip('ja_3', 85, 95, 20)];

  const report = compareFinalDraftClipChains(ko, ja);
  assert.equal(report.three_shot_identical_chain_detected, false);
  assert.equal(report.final_status, 'pass', `unexpected gates: ${report.failed_gates.join(', ')}`);
});

test('a byte-identical edit is still rejected', () => {
  const ko = [clip('ko_1', 10, 20, 0), clip('ko_2', 40, 50, 10), clip('ko_3', 80, 90, 20)];
  const ja = [clip('ja_1', 10, 20, 0), clip('ja_2', 40, 50, 10), clip('ja_3', 80, 90, 20)];

  const report = compareFinalDraftClipChains(ko, ja);
  assert.equal(report.three_shot_identical_chain_detected, true);
  assert.equal(report.final_status, 'fail');
  assert.ok(report.failed_gates.includes('three_shot_identical_chain'));
});

test('a shared shot of moderate length no longer fails the gate on its own', () => {
  // A ~9s shared block used to fail against a 6s ceiling; sharing footage is acceptable.
  const ko = [clip('ko_1', 10, 20, 0), clip('ko_2', 100, 110, 10), clip('ko_3', 200, 210, 20)];
  const ja = [clip('ja_1', 60, 70, 0), clip('ja_2', 100.4, 110.4, 10), clip('ja_3', 300, 310, 20)];

  const report = compareFinalDraftClipChains(ko, ja);
  assert.ok(report.shared_contiguous_block_max_sec > 6, 'test should exercise a block over the old ceiling');
  assert.ok(!report.failed_gates.includes('shared_contiguous_block_threshold'));
});

test('footage pinned to a fixed window is excluded from opening similarity', () => {
  // The heatmap scene hook plays in both locales by design.
  const hook = [476.385, 482.385];
  const ko = [clip('ko_hook', hook[0], hook[1], 0), clip('ko_2', 10, 20, 6)];
  const ja = [clip('ja_hook', hook[0], hook[1], 0), clip('ja_2', 200, 210, 6)];

  const withoutExclusion = compareFinalDraftClipChains(ko, ja);
  const withExclusion = compareFinalDraftClipChains(ko, ja, THRESHOLDS, [hook]);
  assert.ok(withExclusion.opening_similarity_score < withoutExclusion.opening_similarity_score);
  assert.equal(withExclusion.final_status, 'pass', `unexpected gates: ${withExclusion.failed_gates.join(', ')}`);
});

test('an empty clip chain still fails loudly', () => {
  const report = compareFinalDraftClipChains([], [clip('ja_1', 10, 20, 0)]);
  assert.equal(report.final_status, 'fail');
  assert.ok(report.failed_gates.includes('missing_video_clip_chain'));
});
