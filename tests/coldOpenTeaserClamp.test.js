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
// and dropped the run onto the fallback planner.
test('a preserved cold open that overruns the teaser limit keeps the lines that fit', () => {
  const coldOpen = dialogueColdOpen([
    { line: 'you cannot feel that', start_sec: 40.0, end_sec: 43.0 },
    { line: 'feel what', start_sec: 43.5, end_sec: 45.2 },
    { line: 'the whole left side of your body', start_sec: 45.8, end_sec: 52.0 },
    { line: 'and then the rest of it went too', start_sec: 53.0, end_sec: 61.4 }
  ]);
  clampColdOpenToTeaser([coldOpen]);

  assert.ok(coldOpen.estimated_duration_sec <= 16, `got ${coldOpen.estimated_duration_sec}s`);
  assert.equal(coldOpen.dialogue_focus_lines.length, 3, 'the lines that fit are kept');
  assert.equal(coldOpen.dialogue_line_windows.length, 3);
  assert.equal(coldOpen.dialogue_focus_lines[0], 'you cannot feel that', 'the hook line survives');
  assert.equal(coldOpen.end_sec, 52.0, 'the slot ends where its last kept line ends');
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
