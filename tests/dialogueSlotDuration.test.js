const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');

const { trimTimelineToTargetRuntime } = _test;

// The Senseless shape: slot_02's five preserved lines run 38.9s to 180.8s of source but total
// only 16.4s of speech. Measuring the span booked it as 133.5s, so the plan read as 194s while
// the finished cut ran 53.5s — the top-up saw a full plan and a phantom over-ceiling warning fired.
function scatteredDialogueSlot(role) {
  const windows = [
    { matched: true, line: 'L1', start_sec: 38.894, end_sec: 40.596 },
    { matched: true, line: 'L2', start_sec: 41.5, end_sec: 44.064 },
    { matched: true, line: 'L3', start_sec: 47.27, end_sec: 50.466 },
    { matched: true, line: 'L4', start_sec: 51.38, end_sec: 54.58 },
    { matched: true, line: 'L5', start_sec: 177.56, end_sec: 180.782 }
  ];
  return {
    slot_id: 'slot_02',
    role,
    decision: 'KEEP_DIALOGUE',
    start_sec: 38.894,
    end_sec: 180.782,
    estimated_duration_sec: 141.888,
    dialogue_focus_lines: windows.map((w) => w.line),
    dialogue_focus_quotes: windows.map((w) => w.line),
    dialogue_line_windows: windows
  };
}

const spokenSec = 16.4;

test('a dialogue slot is measured by the lines it cuts, not the span between them', () => {
  // Nothing is over a 180s ceiling once the dead air stops counting, so nothing is trimmed.
  const timeline = [scatteredDialogueSlot('body_peak')];
  const trimmed = trimTimelineToTargetRuntime(timeline, 180);
  const kept = trimmed[0].dialogue_line_windows.filter((w) => w.matched === true);
  assert.equal(kept.length, 5, 'no line should be dropped for a slot that only speaks for ~16s');
  assert.equal(trimmed[0].decision, 'KEEP_DIALOGUE');
});

test('the span is still not what a tight ceiling measures', () => {
  // A 60s ceiling is far below the 141.9s span but well above the 16.4s of speech.
  const timeline = [scatteredDialogueSlot('body_peak')];
  const trimmed = trimTimelineToTargetRuntime(timeline, 60);
  assert.equal(trimmed[0].dialogue_line_windows.filter((w) => w.matched === true).length, 5);
});

test('a genuinely over-long set of lines is still trimmed', () => {
  const windows = Array.from({ length: 8 }, (_, i) => ({
    matched: true, line: `L${i}`, start_sec: 100 + i * 20, end_sec: 100 + i * 20 + 15
  }));
  const timeline = [{
    slot_id: 'slot_x',
    role: 'body_peak',
    decision: 'KEEP_DIALOGUE',
    start_sec: 100,
    end_sec: 255,
    estimated_duration_sec: 155,
    dialogue_focus_lines: windows.map((w) => w.line),
    dialogue_focus_quotes: windows.map((w) => w.line),
    dialogue_line_windows: windows
  }];
  const trimmed = trimTimelineToTargetRuntime(timeline, 60);
  const kept = trimmed[0].dialogue_line_windows.filter((w) => w.matched === true);
  assert.ok(kept.length < 8, '120s of actual speech must still come down');
  assert.ok(kept.length >= 1);
});

test('unmatched lines do not count toward the runtime', () => {
  const timeline = [{
    slot_id: 'slot_y',
    role: 'body_peak',
    decision: 'KEEP_DIALOGUE',
    start_sec: 10,
    end_sec: 200,
    estimated_duration_sec: 190,
    dialogue_focus_lines: ['a', 'b'],
    dialogue_focus_quotes: ['a', 'b'],
    dialogue_line_windows: [
      { matched: true, line: 'a', start_sec: 10, end_sec: 12 },
      { matched: false, line: 'b', start_sec: 190, end_sec: 200 }
    ]
  }];
  const trimmed = trimTimelineToTargetRuntime(timeline, 30);
  assert.equal(trimmed[0].dialogue_line_windows.filter((w) => w.matched === true).length, 1);
  assert.ok(spokenSec > 0);
});
