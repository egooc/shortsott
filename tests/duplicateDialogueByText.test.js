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

test('the string "null" is not a replay declaration', () => {
  // The generator writes replay_of_slot_id: "null" (the string). Boolean("null") is true,
  // which exempted every slot from the duplicate check on a real New Moon plan.
  const out = dropDuplicateDialogueSlots([
    slot('s2', [win('we have to leave', 16.84, 19.097)], { replay_of_slot_id: 'null' }),
    slot('s3', [win('we have to leave', 19.097, 21.354)], { replay_of_slot_id: 'null' })
  ]);
  assert.equal(out[1].decision, 'DROP');
});

test('a replay must name a slot that exists', () => {
  const out = dropDuplicateDialogueSlots([
    slot('s2', [win('we have to leave', 16.84, 19.097)]),
    slot('s3', [win('we have to leave', 19.097, 21.354)], { replay_of_slot_id: 's99' })
  ]);
  assert.equal(out[1].decision, 'DROP');
});

test('a rolling-caption repeat - the same line again in an ADJACENT window - drops', () => {
  const out = dropDuplicateDialogueSlots([
    slot('s7', [win("I'm coming", 102.1, 107.2), win("Bella I don't want you to come", 107.24, 111.11)]),
    slot('s8', [win("Bella I don't want you to come", 111.11, 115.2)])
  ]);
  assert.equal(out[0].decision, 'KEEP_DIALOGUE');
  assert.equal(out[1].decision, 'DROP');
});

test('a dramatic repeat seconds later carries its own beat and survives', () => {
  // New Moon beat_06 (weight 5): Edward repeats "I don't want you to come" colder, six seconds
  // after the first delivery. Dropping it orphaned the beat and killed the refresh at coverage.
  const out = dropDuplicateDialogueSlots([
    slot('s7', [win("I'm coming", 102.1, 107.2), win("Bella I don't want you to come", 107.24, 111.11)]),
    slot('s8', [win("Bella I don't want you to come", 117.079, 122.205)])
  ]);
  assert.equal(out[1].decision, 'KEEP_DIALOGUE');
});

test('short interjections repeat legitimately and are never counted', () => {
  const out = dropDuplicateDialogueSlots([
    slot('s2', [win('no', 10, 11), win('we have to leave', 16.84, 19.097)]),
    slot('s5', [win('no', 50, 51), win('we I mean my family', 56.44, 63.79)])
  ]);
  assert.equal(out[1].decision, 'KEEP_DIALOGUE');
});

test('a slot with a fresh substantial line among claimed ones survives', () => {
  const out = dropDuplicateDialogueSlots([
    slot('s2', [win('we have to leave', 16.84, 19.097)]),
    slot('s3', [win('we have to leave', 19.097, 21.354), win('you promised me an answer', 30, 33)])
  ]);
  assert.equal(out[1].decision, 'KEEP_DIALOGUE');
});
