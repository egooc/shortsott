// Guards the highlight edge-refinement contract (approved 2026-08-08).
//
// Selection stays untouched: refinement runs AFTER pickHighlightWindows and
// assertHighlightCandidateMetadataDistinct, may move each edge at most 0.35s
// onto a silence trough, must preserve window count/order/strategy, must not
// exceed the duration cap or shrink more than 0.7s, and must fail open.
const fs = require('fs');
const path = require('path');
const {
  refineHighlightWindowEdges,
  __test: refineTest
} = require('../server/services/highlightEdgeRefineService');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const queueSource = read('server/services/processQueueService.js');
const serviceSource = read('server/services/highlightEdgeRefineService.js');

// --- wiring: refinement is post-selection, pre-factory ----------------------

assert(
  queueSource.includes("require('./highlightEdgeRefineService')"),
  'processQueueService must import the edge refine service'
);
const assertIdx = queueSource.indexOf('assertHighlightCandidateMetadataDistinct(itemConfig, highlightWindows)');
const refineIdx = queueSource.indexOf('refineHighlightWindowEdges({');
const loopIdx = queueSource.indexOf('edgeRefinement.windows.entries()');
assert(assertIdx > 0 && refineIdx > assertIdx && loopIdx > refineIdx,
  'refinement must run after the distinctness gate and feed the factory loop');
assert(
  serviceSource.includes('HIGHLIGHT_EDGE_REFINE'),
  'the kill switch env var must exist'
);

// --- behavior: bounded movement ---------------------------------------------

const { snapWindowEdges, EDGE_BUDGET_SEC } = refineTest;
assert(EDGE_BUDGET_SEC === 0.35, 'edge budget must stay 0.35s');

// A trough right after the window end: end snaps to trough start + tail.
let r = snapWindowEdges(10, 20, [[20.2, 20.9]], { maxDurationSec: 24 });
assert(Math.abs(r.end - 20.26) < 1e-6 && r.path === 'silence_end',
  `end must snap to trough start + 0.06 tail, got ${r.end} (${r.path})`);

// A trough just before the start: start snaps to trough end - lead.
r = snapWindowEdges(10, 20, [[9.4, 9.9]], { maxDurationSec: 24 });
assert(Math.abs(r.start - 9.86) < 1e-6 && r.path === 'silence_start',
  `start must snap to trough end - 0.04 lead, got ${r.start} (${r.path})`);

// A trough farther than the budget must not move anything.
r = snapWindowEdges(10, 20, [[21.0, 21.5]], { maxDurationSec: 24 });
assert(r.start === 10 && r.end === 20 && r.path === 'none',
  'a trough beyond 0.35s must not move an edge');

// Duration cap: extending past the cap reverts the move.
r = snapWindowEdges(10, 20, [[20.2, 20.9]], { maxDurationSec: 10 });
assert(r.end === 20, 'an end move that would exceed the duration cap must revert');

// Never invert / never over-shrink.
r = snapWindowEdges(10, 13, [[10.2, 10.4], [12.7, 12.9]], { maxDurationSec: 24 });
assert(r.end - r.start >= 3 - 1e-9 || (r.start === 10 && r.end === 13),
  'shrinking below the duration floor must revert to the original window');

// --- behavior: count/order/metadata preservation ----------------------------

(async () => {
  const windows = [
    { start_sec: 30, end_sec: 36, selection_strategy: 'gemini_highlight_candidate_1', selected_scene_ids: ['s3'] },
    { start_sec: 10, end_sec: 16, selection_strategy: 'gemini_single_process_visual_hook_window', selected_scene_ids: ['s1'] }
  ];
  // Nonexistent video: detection fails -> fail-open, original windows back.
  const failOpen = await refineHighlightWindowEdges({
    videoPath: path.join(root, 'nonexistent_source.mp4'),
    windows,
    maxDurationSec: 24
  });
  assert(failOpen.windows.length === 2, 'fail-open must keep the window count');
  assert(failOpen.windows[0].start_sec === 30 && failOpen.windows[1].start_sec === 10,
    'fail-open must keep the original order and values');
  assert(
    failOpen.windows[0].selection_strategy === 'gemini_highlight_candidate_1',
    'selection_strategy must never change'
  );

  process.env.HIGHLIGHT_EDGE_REFINE = '0';
  const killed = await refineHighlightWindowEdges({
    videoPath: path.join(root, 'nonexistent_source.mp4'),
    windows,
    maxDurationSec: 24
  });
  delete process.env.HIGHLIGHT_EDGE_REFINE;
  assert(killed.summary.enabled === false && killed.windows === windows,
    'the kill switch must return the input untouched');

  console.log('check-highlight-edge-refine: OK');
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
