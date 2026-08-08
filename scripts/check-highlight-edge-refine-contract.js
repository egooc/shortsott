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

const {
  snapWindowEdges, EDGE_BUDGET_SEC, SCENE_START_BUDGET_SEC, SCENE_END_BUDGET_SEC
} = refineTest;
assert(EDGE_BUDGET_SEC === 0.35, 'silence edge budget must stay 0.35s');
assert(SCENE_START_BUDGET_SEC === 0.35, 'scene start budget must stay 0.35s');
assert(SCENE_END_BUDGET_SEC === 1.6, 'scene end budget must stay 1.6s');

// A trough right after the window end: end snaps to trough start + tail.
let r = snapWindowEdges(10, 20, [[20.2, 20.9]], [], { maxDurationSec: 24 });
assert(Math.abs(r.end - 20.26) < 1e-6 && r.path === 'silence_end',
  `end must snap to trough start + 0.06 tail, got ${r.end} (${r.path})`);

// A trough just before the start: start snaps to trough end - lead.
r = snapWindowEdges(10, 20, [[9.4, 9.9]], [], { maxDurationSec: 24 });
assert(Math.abs(r.start - 9.86) < 1e-6 && r.path === 'silence_start',
  `start must snap to trough end - 0.04 lead, got ${r.start} (${r.path})`);

// A trough farther than the budget must not move anything.
r = snapWindowEdges(10, 20, [[21.0, 21.5]], [], { maxDurationSec: 24 });
assert(r.start === 10 && r.end === 20 && r.path === 'none',
  'a trough beyond 0.35s must not move an edge');

// Duration cap: extending past the cap reverts the move.
r = snapWindowEdges(10, 20, [[20.2, 20.9]], [], { maxDurationSec: 10 });
assert(r.end === 20, 'an end move that would exceed the duration cap must revert');

// Never invert / never over-shrink.
r = snapWindowEdges(10, 13, [[10.2, 10.4], [12.7, 12.9]], [], { maxDurationSec: 24 });
assert(r.end - r.start >= 3 - 1e-9 || (r.start === 10 && r.end === 13),
  'shrinking below the duration floor must revert to the original window');

// --- behavior: scene-cut snapping -------------------------------------------

// The P4-measured case: the end sits 1.3s before a scene cut -> settle on it.
r = snapWindowEdges(46, 50, [], [46.03, 51.3], { maxDurationSec: 24 });
assert(Math.abs(r.end - 51.3) < 1e-6, `end must extend onto a cut within 1.6s, got ${r.end}`);
assert(Math.abs(r.start - 46.03) < 1e-6, `start must settle on a cut within 0.35s, got ${r.start}`);
assert(r.path === 'scene_start+scene_end', `expected scene snap on both edges, got ${r.path}`);

// The end may also retreat onto a cut (shot ends before the window did).
r = snapWindowEdges(100, 116, [], [114.8], { maxDurationSec: 24 });
assert(Math.abs(r.end - 114.8) < 1e-6 && r.path === 'scene_end',
  `end must retreat onto a cut within 1.6s, got ${r.end} (${r.path})`);

// A cut beyond the end budget must not move the end.
r = snapWindowEdges(100, 116, [], [117.8], { maxDurationSec: 24 });
assert(r.end === 116 && r.path === 'none', 'a cut beyond 1.6s must not move the end');

// A cut beyond the start budget must not move the start.
r = snapWindowEdges(100, 116, [], [99.5, 116.2], { maxDurationSec: 24 });
assert(r.start === 100, 'a cut beyond 0.35s must not move the start');

// Scene cut wins over a silence trough on the same edge.
r = snapWindowEdges(10, 20, [[20.1, 20.4]], [20.9], { maxDurationSec: 24 });
assert(Math.abs(r.end - 20.9) < 1e-6 && r.path === 'scene_end',
  'the visual boundary must win over the audio trough');

// Duration cap still binds scene extension (13.5s window, cap 14, cut at +1.4).
r = snapWindowEdges(10, 23.5, [], [24.9], { maxDurationSec: 14 });
assert(r.end === 23.5, 'a scene extension past the duration cap must revert');

// Scene shrink is bounded: a 5s window may not lose 1.6s (floor 4s wins).
r = snapWindowEdges(10, 15, [], [13.5], { maxDurationSec: 24 });
assert(r.start === 10 && r.end === 15,
  'a scene retreat that lands under the 4s duration floor must revert');

// --- behavior: count/order/metadata preservation ----------------------------

(async () => {
  const windows = [
    { start_sec: 30, end_sec: 36, selection_strategy: 'gemini_highlight_candidate_1', selected_scene_ids: ['s3'] },
    { start_sec: 10, end_sec: 16, selection_strategy: 'gemini_single_process_visual_hook_window', selected_scene_ids: ['s1'] }
  ];
  // Nonexistent video: detection fails -> fail-open, original windows back.
  // Scene stage disabled here so verify stays fast (no python cold start);
  // its own failure path degrades to cuts: [] inside detectSceneCuts.
  process.env.HIGHLIGHT_EDGE_REFINE_SCENES = '0';
  const failOpen = await refineHighlightWindowEdges({
    videoPath: path.join(root, 'nonexistent_source.mp4'),
    windows,
    maxDurationSec: 24
  });
  delete process.env.HIGHLIGHT_EDGE_REFINE_SCENES;
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
