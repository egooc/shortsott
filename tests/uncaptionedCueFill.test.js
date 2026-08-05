const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const { fillUncaptionedCuesInsideCuts } = _test;

// A cut spans from its first preserved line to its last, and the source keeps talking in between:
// cues nobody selected are audible with no caption. 13 of 112 seconds played that way.
const cues = [
  { start_sec: 10.0, end_sec: 12.0, text: 'first kept line' },
  { start_sec: 12.5, end_sec: 14.0, text: 'the line nobody selected' },
  { start_sec: 15.0, end_sec: 17.0, text: 'second kept line' },
  { start_sec: 40.0, end_sec: 42.0, text: 'far outside the cut' }
];

const slot = () => ([{
  slot_id: 'slot_001',
  decision: 'KEEP_DIALOGUE',
  dialogue_focus_lines: ['first kept line', 'second kept line'],
  dialogue_focus_quotes: ['first kept line', 'second kept line'],
  dialogue_line_windows: [
    { matched: true, line: 'first kept line', start_sec: 10.0, end_sec: 12.0 },
    { matched: true, line: 'second kept line', start_sec: 15.0, end_sec: 17.0 }
  ]
}]);

test('an audible cue between two kept lines becomes a line of the slot', () => {
  const [item] = fillUncaptionedCuesInsideCuts(slot(), cues);
  const lines = item.dialogue_line_windows.filter((w) => w.matched === true).map((w) => w.line);
  assert.equal(lines.length, 3);
  assert.equal(lines[1], 'the line nobody selected', 'and it lands in speaking order');
  assert.equal(item.dialogue_focus_lines.length, 3, 'captions follow the windows');
  assert.equal(item.adopted_cue_count, 1);
});

test('cues outside the cut are left alone', () => {
  const [item] = fillUncaptionedCuesInsideCuts(slot(), cues);
  const lines = item.dialogue_line_windows.map((w) => w.line);
  assert.ok(!lines.includes('far outside the cut'));
});

test('a cue already covered by a kept line is not duplicated', () => {
  const overlapping = [...cues, { start_sec: 10.2, end_sec: 11.8, text: 'first kept line' }];
  const [item] = fillUncaptionedCuesInsideCuts(slot(), overlapping);
  assert.equal(item.dialogue_line_windows.filter((w) => w.matched === true).length, 3);
});

test('sound effects and blips are not adopted', () => {
  const noisy = [...cues, { start_sec: 13.0, end_sec: 13.2, text: 'um' }, { start_sec: 14.2, end_sec: 14.5, text: '[Music]' }];
  const [item] = fillUncaptionedCuesInsideCuts(slot(), noisy);
  const lines = item.dialogue_line_windows.map((w) => w.line);
  assert.ok(!lines.includes('[Music]'), 'music is not dialogue');
  assert.ok(!lines.includes('um'), 'a blip shorter than the minimum is skipped');
});

test('a single-line slot is untouched', () => {
  const single = [{
    slot_id: 'x', decision: 'KEEP_DIALOGUE',
    dialogue_focus_lines: ['only'], dialogue_focus_quotes: ['only'],
    dialogue_line_windows: [{ matched: true, line: 'only', start_sec: 10.0, end_sec: 12.0 }]
  }];
  const [item] = fillUncaptionedCuesInsideCuts(single, cues);
  assert.equal(item.dialogue_line_windows.length, 1, 'there is no in-between to fill');
});

// Adopting audible cues is worth doing, but not at the cost of failing the run: the plan
// validator rejects a slot with more than 8 focus quotes.
test('adoption never pushes a slot past the validated line cap', () => {
  const many = [];
  for (let i = 0; i < 12; i += 1) many.push({ start_sec: 10 + i, end_sec: 10.8 + i, text: `line ${i}` });
  const item = [{
    slot_id: 'busy',
    decision: 'KEEP_DIALOGUE',
    dialogue_focus_lines: ['first', 'last'],
    dialogue_focus_quotes: ['first', 'last'],
    dialogue_line_windows: [
      { matched: true, line: 'first', start_sec: 10.0, end_sec: 10.4 },
      { matched: true, line: 'last', start_sec: 25.0, end_sec: 25.5 }
    ]
  }];
  const [result] = fillUncaptionedCuesInsideCuts(item, many);
  const lines = result.dialogue_line_windows.filter((w) => w.matched === true);
  assert.ok(lines.length <= 8, `slot grew to ${lines.length} lines`);
  assert.ok(lines.length > 2, 'but it still recovered what it could');
});
