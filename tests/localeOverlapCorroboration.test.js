'use strict';

// The de-duplication gate's own words: it "only needs to catch a wholesale identical edit, not
// any reuse of the same shots". The shared-block rule did not honour that - one long clip failed
// a cut on its own. Measured over the 84 runs with both locale drafts, the cuts failing on that
// rule ALONE are indistinguishable from the cuts that pass (pairwise 0.18-0.45 vs 0.24-0.51),
// while cuts that trip a structural threshold sit at a median of 0.69.

const assert = require('node:assert');
const test = require('node:test');
const { compareFinalDraftClipChains } = require('../server/services/midformFinalDraftOverlapService');

// The shape extractVideoClipChainFromDraftContent produces: seconds, as [start, end] ranges.
const chain = (windows) => {
  let timeline = 0;
  return windows.map(([start, end], index) => {
    const clip = {
      index,
      clip_id: `c${index}`,
      material_id: 'source_video',
      source_range: [start, end],
      timeline_range: [timeline, timeline + (end - start)],
      duration_sec: end - start
    };
    timeline += end - start;
    return clip;
  });
};

test('a long shared block alone does not condemn an otherwise different edit', () => {
  const ko = chain([[0, 6], [100, 132], [300, 306], [400, 406]]);
  const ja = chain([[50, 56], [100, 132], [500, 506], [600, 606]]);
  const verdict = compareFinalDraftClipChains(ko, ja);
  assert.ok(verdict.shared_contiguous_block_max_sec > 20, 'the 32s block must be detected');
  assert.ok(verdict.pairwise_overlap_score < 0.6, 'and the edit must look different');
  assert.ok(!verdict.failed_gates.includes('shared_contiguous_block_threshold'),
    `blocked on the block alone: ${JSON.stringify(verdict.failed_gates)}`);
  assert.strictEqual(verdict.shared_contiguous_block_corroborated, false);
});

test('a long shared block inside a copied edit still fails', () => {
  const same = [[0, 6], [100, 132], [300, 306], [400, 406], [500, 506]];
  const verdict = compareFinalDraftClipChains(chain(same), chain(same));
  assert.ok(verdict.pairwise_overlap_score >= 0.6, 'an identical edit must score high');
  assert.ok(verdict.failed_gates.includes('shared_contiguous_block_threshold'),
    `a copied edit must still be caught: ${JSON.stringify(verdict.failed_gates)}`);
  assert.strictEqual(verdict.shared_contiguous_block_corroborated, true);
});

test('the structural thresholds are untouched by this change', () => {
  // Adjacent clips merge into one contiguous block, so an identical edit trips the block rule
  // too - the point here is that every structural gate still fires on its own evidence.
  const same = [[0, 6], [100, 106], [300, 306], [400, 406], [500, 506]];
  const verdict = compareFinalDraftClipChains(chain(same), chain(same));
  for (const gate of ['pairwise_overlap_threshold', 'opening_similarity_threshold',
    'chain_similarity_threshold', 'top_highlight_cluster_ordering_threshold',
    'three_shot_identical_chain']) {
    assert.ok(verdict.failed_gates.includes(gate), `${gate} must still fire on an identical edit`);
  }
});

test('the corroboration floor is configurable and defaults to permissive when absent', () => {
  const ko = chain([[0, 6], [100, 132], [300, 306]]);
  const ja = chain([[50, 56], [100, 132], [500, 506]]);
  const strict = compareFinalDraftClipChains(ko, ja,
    { pairwise_overlap_score: 0.88, opening_similarity_score: 0.75, chain_similarity_score: 0.85,
      top_highlight_cluster_ordering_similarity_score: 0.9, shared_contiguous_block_max_sec: 20.0 });
  assert.ok(strict.failed_gates.includes('shared_contiguous_block_threshold'),
    'a caller passing the old threshold set keeps the old behaviour');
});
