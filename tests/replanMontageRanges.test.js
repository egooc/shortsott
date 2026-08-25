const test = require('node:test');
const assert = require('node:assert');

const { _test, replanJaDraftSpecForFinalOverlap } = require('../server/services/midformLocaleDraftService.js');

const spec = (placement) => ({ clip_placement: [placement], shot_duration: [] });
const report = { shared_contiguous_blocks: [], failed_gates: ['final_overlap_threshold'] };

test('a montage placement drops its parts and delegates repacking to the packer', () => {
  // Bb4qURNGHqk twice over: shifting only the scalar left the played array identical to ko
  // (opening similarity pinned at 1.0), and hand-shifting the parts skipped the packer's
  // reserved-window validation and landed them on dialogue clips. The replan expresses intent
  // (a shifted start); the packer, which knows every reservation, rebuilds the parts.
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
  assert.equal(p.source_ranges, undefined, 'montage parts dropped for the packer to rebuild');
  assert.notDeepEqual(p.source_range, [13.84, 17.44], 'scalar intent shifted');
  assert.deepEqual(p.semantic_origin_range, [13.84, 17.44], 'origin recorded');
});

test('a second attempt anchors to the ORIGINAL range, not the shifted one', () => {
  const first = replanJaDraftSpecForFinalOverlap(
    spec({ clip_id: 'ja_slot_002', visual_role: 'bridge', source_range: [13.84, 17.44], source_ranges: [[13.84, 17.44]] }),
    report, 1, {}
  );
  const second = replanJaDraftSpecForFinalOverlap(first, report, 2, {});
  const p = second.clip_placement[0];
  assert.deepEqual(p.semantic_origin_range, [13.84, 17.44], 'origin sticks across attempts');
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
