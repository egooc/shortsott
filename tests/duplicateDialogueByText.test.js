const test = require('node:test');
const assert = require('node:assert');

const { _test } = require('../server/services/midformCompressionService.js');
const { dropDuplicateDialogueSlots } = _test;

const win = (line, start, end) => ({ matched: true, line, start_sec: start, end_sec: end });
const slot = (id, windows, extra = {}) => ({
  slot_id: id,
  decision: 'KEEP_DIALOGUE',
  dialogue_line_windows: windows,
  ...extra
});

test('an utterance split across two abutting slots is caught by its text', () => {
  // The New Moon cut that exposed this: "we have to leave" ran 16.84-19.097 in one slot and
  // 19.097-21.354 in the next. The windows abut, so the overlap check saw nothing, and the
  // viewer read the same two captions twice, three seconds apart.
  const out = dropDuplicateDialogueSlots([
    slot('s2', [win('we have to leave', 16.84, 19.097), win('Forks', 21.354, 23.612)]),
    slot('s3', [win('we have to leave', 19.097, 21.354), win('Forks', 23.612, 25.87)])
  ]);
  assert.equal(out[0].decision, 'KEEP_DIALOGUE');
  assert.equal(out[1].decision, 'DROP');
  assert.equal(out[1].duplicate_dialogue_dropped, true);
  assert.equal(out[1].estimated_duration_sec, 0);
});

test('a declared replay keeps its lines - repeating a beat on purpose is the house style', () => {
  const out = dropDuplicateDialogueSlots([
    slot('s2', [win('we have to leave', 16.84, 19.097)]),
    slot('s9', [win('we have to leave', 16.84, 19.097)], { replay_of_slot_id: 's2' })
  ]);
  assert.equal(out[1].decision, 'KEEP_DIALOGUE');
});

test('a teaser callback is a declared replay too', () => {
  const out = dropDuplicateDialogueSlots([
    slot('s1', [win('we have to leave', 16.84, 19.097)]),
    slot('s8', [win('we have to leave', 16.84, 19.097)], {
      teaser_slot_id: 's1',
      callback_relation: 'payoff'
    })
  ]);
  assert.equal(out[1].decision, 'KEEP_DIALOGUE');
});

test('different lines at the same clock are not duplicates', () => {
  const out = dropDuplicateDialogueSlots([
    slot('s2', [win('we have to leave', 16.84, 19.097)]),
    slot('s5', [win('we I mean my family', 56.44, 63.79)])
  ]);
  assert.equal(out[0].decision, 'KEEP_DIALOGUE');
  assert.equal(out[1].decision, 'KEEP_DIALOGUE');
});

test('the key ignores punctuation and case, which the two sources spell differently', () => {
  const out = dropDuplicateDialogueSlots([
    slot('s2', [win('We have to leave.', 16.84, 19.097)]),
    slot('s3', [win('we have to leave', 19.097, 21.354)])
  ]);
  assert.equal(out[1].decision, 'DROP');
});

test('a slot carrying a superset of lines is its own content, not a repeat', () => {
  const out = dropDuplicateDialogueSlots([
    slot('s2', [win('we have to leave', 16.84, 19.097)]),
    slot('s3', [win('we have to leave', 19.097, 21.354), win('Forks', 23.612, 25.87)])
  ]);
  assert.equal(out[1].decision, 'KEEP_DIALOGUE');
});

test('slots with no matched window are left to the other checks', () => {
  const out = dropDuplicateDialogueSlots([
    slot('s2', [{ matched: false, line: 'we have to leave' }]),
    slot('s3', [{ matched: false, line: 'we have to leave' }])
  ]);
  assert.equal(out[0].decision, 'KEEP_DIALOGUE');
  assert.equal(out[1].decision, 'KEEP_DIALOGUE');
});
