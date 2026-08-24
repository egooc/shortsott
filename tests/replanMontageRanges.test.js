const test = require('node:test');
const assert = require('node:assert');

const { _test, replanJaDraftSpecForFinalOverlap } = require('../server/services/midformLocaleDraftService.js');

const spec = (placement) => ({ clip_placement: [placement], shot_duration: [] });
const report = { shared_contiguous_blocks: [], failed_gates: ['final_overlap_threshold'] };

test('a montage placement shifts its PLAYED ranges, not just the scalar', () => {
  // Bb4qURNGHqk: the ja bridge played source_ranges identical to ko while the replan shifted
  // only source_range - two attempts, zero on-screen change, opening similarity pinned at 1.0.
  const out = replanJaDraftSpecForFinalOverlap(
    spec({
      clip_id: 'ja_slot_002',
      visual_role: 'bridge',
      source_range: [13.84, 17.44],
      source_ranges: [[13.84, 17.44], [19.18, 21.94]]
    }),
    report,
    1,
    {}
  );
  const p = out.clip_placement[0];
  assert.ok(Array.isArray(p.source_ranges), 'montage survives');
  assert.notDeepEqual(p.source_ranges[0], [13.84, 17.44], 'part 1 moved');
  assert.notDeepEqual(p.source_ranges[1], [19.18, 21.94], 'part 2 moved');
  assert.deepEqual(p.source_range, p.source_ranges[0], 'scalar mirrors the played first part');
  assert.deepEqual(p.semantic_origin_ranges, [[13.84, 17.44], [19.18, 21.94]], 'origins recorded');
});

test('a second attempt anchors to the ORIGINAL ranges, not the shifted ones', () => {
  const first = replanJaDraftSpecForFinalOverlap(
    spec({ clip_id: 'ja_slot_002', visual_role: 'bridge', source_range: [13.84, 17.44], source_ranges: [[13.84, 17.44]] }),
    report, 1, {}
  );
  const second = replanJaDraftSpecForFinalOverlap(first, report, 2, {});
  const p = second.clip_placement[0];
  assert.deepEqual(p.semantic_origin_ranges, [[13.84, 17.44]], 'origin sticks across attempts');
});

test('a plain single-range placement still shifts as before', () => {
  const out = replanJaDraftSpecForFinalOverlap(
    spec({ clip_id: 'ja_slot_009', visual_role: 'body', source_range: [100, 104] }),
    report, 1, {}
  );
  const p = out.clip_placement[0];
  assert.notDeepEqual(p.source_range, [100, 104]);
  assert.deepEqual(p.semantic_origin_range, [100, 104]);
});
