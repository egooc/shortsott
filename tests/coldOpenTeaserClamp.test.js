const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');

const { clampColdOpenToTeaser, validateEditPlan } = _test;

function dialogueColdOpen(windows) {
  const first = windows[0];
  const last = windows[windows.length - 1];
  return {
    slot_id: '1',
    role: 'cold_open',
    decision: 'KEEP_DIALOGUE',
    start_sec: first.start_sec,
    end_sec: last.end_sec,
    estimated_duration_sec: last.end_sec - first.start_sec,
    dialogue_focus_lines: windows.map((w) => w.line),
    dialogue_focus_quotes: windows.map((w) => w.line),
    dialogue_line_windows: windows.map((w) => ({ matched: true, ...w }))
  };
}

// The whole plan used to be rejected over the tail of this one slot, which spent the retries
// and dropped the run onto the fallback planner. Since 9f5eeb0 the clamp trims from the FRONT:
// a teaser's punch is its last line (the reveal the cut is built to pay off), and keeping the
// first N lines threw it away - The Housemaid night opened on setup chatter after "Nina
// Winchester tried to drown her kid in the bathtub." was cut. A teaser may start mid-exchange;
// it may not lose its point.
test('a preserved cold open that overruns the teaser limit keeps the lines that fit', () => {
  const coldOpen = dialogueColdOpen([
    { line: 'you cannot feel that', start_sec: 40.0, end_sec: 43.0 },
    { line: 'feel what', start_sec: 43.5, end_sec: 45.2 },
    { line: 'the whole left side of your body', start_sec: 45.8, end_sec: 52.0 },
    { line: 'and then the rest of it went too', start_sec: 53.0, end_sec: 61.4 }
  ]);
  clampColdOpenToTeaser([coldOpen]);

  assert.ok(coldOpen.estimated_duration_sec <= 16, `got ${coldOpen.estimated_duration_sec}s`);
  assert.equal(coldOpen.dialogue_focus_lines.length, 2, 'the lines that fit are kept');
  assert.equal(coldOpen.dialogue_line_windows.length, 2);
  assert.equal(coldOpen.dialogue_focus_lines.at(-1), 'and then the rest of it went too', 'the reveal survives');
  assert.equal(coldOpen.start_sec, 45.8, 'the slot opens on the earliest line that still fits');
  assert.equal(coldOpen.end_sec, 61.4, 'the slot keeps its last line to the end');
});

test('a cold open already inside the limit is untouched', () => {
  const coldOpen = dialogueColdOpen([
    { line: 'you cannot feel that', start_sec: 40.0, end_sec: 43.0 },
    { line: 'feel what', start_sec: 43.5, end_sec: 45.2 }
  ]);
  clampColdOpenToTeaser([coldOpen]);
  assert.equal(coldOpen.dialogue_focus_lines.length, 2);
  assert.equal(coldOpen.end_sec, 45.2);
  assert.ok(!/teaser limit/.test(coldOpen.reason || ''));
});

test('a single over-long line is clamped rather than emptied', () => {
  // Dropping the only line would leave the cold open with no hook at all.
  const coldOpen = dialogueColdOpen([{ line: 'one very long take', start_sec: 10.0, end_sec: 34.0 }]);
  clampColdOpenToTeaser([coldOpen]);
  assert.equal(coldOpen.dialogue_focus_lines.length, 1);
  assert.equal(coldOpen.estimated_duration_sec, 16);
  assert.equal(coldOpen.end_sec, 26.0);
});

test('a narrated cold open is held to the shorter teaser limit', () => {
  const coldOpen = {
    slot_id: '1',
    role: 'cold_open',
    decision: 'NARRATE',
    start_sec: 12.0,
    end_sec: 26.0,
    estimated_duration_sec: 14
  };
  clampColdOpenToTeaser([coldOpen]);
  assert.equal(coldOpen.estimated_duration_sec, 6.5);
  assert.equal(coldOpen.end_sec, 18.5);
});

test('the clamped plan is one validateEditPlan accepts', () => {
  const coldOpen = dialogueColdOpen([
    { line: 'you cannot feel that', start_sec: 40.0, end_sec: 43.0 },
    { line: 'feel what', start_sec: 43.5, end_sec: 45.2 },
    { line: 'and then the rest of it went too', start_sec: 46.0, end_sec: 61.4 }
  ]);
  const timeline = [
    coldOpen,
    { slot_id: '2', role: 'bridge', decision: 'NARRATE', estimated_duration_sec: 12 },
    { slot_id: '3', role: 'body', decision: 'NARRATE', estimated_duration_sec: 40 }
  ];
  clampColdOpenToTeaser(timeline);
  assert.ok(validateEditPlan({ timeline }));
});

// Real coordinates from the 2026-08-21 batch (The Housemaid ballet): the front-trim clamp moved
// the teaser's lines to [540.955,545.48] but the visual window kept the pre-trim start, so the
// teaser [533.95,544.17] swallowed slot_15's reserved line at [532.12,534.2] and the whole plan
// died at cold_open_no_reserved_overlap - on every candidate, all night.
test('the teaser visual window follows the kept lines after a re-selection', () => {
  const { syncColdOpenVisualToKeptLines } = _test;
  const timeline = syncColdOpenVisualToKeptLines([{
    slot_id: 'slot_01',
    role: 'cold_open',
    decision: 'KEEP_DIALOGUE',
    start_sec: 540.955,
    end_sec: 545.48,
    visual_source_start_sec: 533.95,
    visual_source_end_sec: 544.17,
    dialogue_line_windows: [
      { matched: true, line: 'Nina made it out, her parents did not.', start_sec: 540.955, end_sec: 545.48 }
    ]
  }]);
  const cold = timeline[0];
  assert.equal(cold.visual_source_start_sec, 540.955, 'visual starts where the kept lines start');
  assert.equal(cold.visual_source_end_sec, 545.48, 'visual ends where the kept lines end');
  assert.equal(cold.start_sec, 540.955);
  assert.equal(cold.end_sec, 545.48);
});

test('a narrated or window-less cold open keeps its visual window untouched', () => {
  const { syncColdOpenVisualToKeptLines } = _test;
  const narrate = { slot_id: '1', role: 'cold_open', decision: 'NARRATE', visual_source_start_sec: 10, visual_source_end_sec: 16 };
  const windowless = { slot_id: '1', role: 'cold_open', decision: 'KEEP_DIALOGUE', visual_source_start_sec: 10, visual_source_end_sec: 16, dialogue_line_windows: [] };
  assert.deepEqual(syncColdOpenVisualToKeptLines([narrate])[0], narrate);
  assert.deepEqual(syncColdOpenVisualToKeptLines([windowless])[0], windowless);
});
