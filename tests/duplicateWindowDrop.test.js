const assert = require('node:assert/strict');
const test = require('node:test');

const { dropWindowsSwallowedByTheirNeighbour: drop } = require('../server/services/midformCompressionService');

test('two lines resolved onto the same moment leave one window', (t) => {
  if (!drop) { t.skip('not exported'); return; }
  // Housemaid: the rolling caption said nearly the same thing twice, both restored lines matched
  // the same cue, and the plan carried two windows starting at 277.89. That is a reserved-range
  // violation AND a cross-segment overlap, so preflight rejected the plan and the run silently fell
  // back to an older compression - with none of the day's fixes in it.
  const timeline = [{
    slot_id: 'slot_08',
    decision: 'KEEP_DIALOGUE',
    dialogue_focus_lines: ['I actually knew your husband.', 'I knew your husband a little.'],
    dialogue_focus_quotes: ['I actually knew your husband.'],
    dialogue_line_windows: [
      { line: 'I actually knew your husband.', matched: true, start_sec: 277.89, end_sec: 279.76 },
      { line: 'I knew your husband a little.', matched: true, start_sec: 277.89, end_sec: 279.01 },
    ],
  }];
  const out = drop(timeline);
  assert.equal(out[0].dialogue_line_windows.length, 1);
  assert.equal(out[0].dialogue_line_windows[0].end_sec, 279.76, 'the longer window survives');
  assert.equal(out[0].dialogue_focus_lines.length, 1, 'its focus line goes with it');
});

test('two lines that merely touch are both kept', (t) => {
  if (!drop) { t.skip('not exported'); return; }
  const timeline = [{
    slot_id: 'slot_09',
    decision: 'KEEP_DIALOGUE',
    dialogue_focus_lines: ['Say it again.', 'I said what I said.'],
    dialogue_focus_quotes: ['Say it again.', 'I said what I said.'],
    dialogue_line_windows: [
      { line: 'Say it again.', matched: true, start_sec: 10.0, end_sec: 11.5 },
      { line: 'I said what I said.', matched: true, start_sec: 11.4, end_sec: 13.2 },
    ],
  }];
  assert.equal(drop(timeline)[0].dialogue_line_windows.length, 2);
});
