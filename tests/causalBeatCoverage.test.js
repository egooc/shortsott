const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');

// The Housemaid ending: beat_03 is the killing itself - dramatic_weight 5, no dialogue at all - and
// the plan DROPped it while keeping the alibi, the police interview and the funeral. The viewer never
// learned anyone had died, so the whole recap read as unrelated fragments.
const BEATS = [
  { beat_id: 'beat_02', start_sec: 61, end_sec: 99, dramatic_weight: 5, dialogue_quality: 'high', summary: 'Nina retaliates' },
  { beat_id: 'beat_03', start_sec: 98.5, end_sec: 134.6, dramatic_weight: 5, dialogue_quality: 'low', summary: 'Andrew is pushed down the staircase' },
  { beat_id: 'beat_04', start_sec: 144, end_sec: 165, dramatic_weight: 4, dialogue_quality: 'high', summary: 'Nina invents the lightbulb alibi' },
  { beat_id: 'beat_06', start_sec: 228, end_sec: 264, dramatic_weight: 3, dialogue_quality: 'mid', summary: 'police interview' }
];

const slot = (id, beatId, decision, extra = {}) => ({
  slot_id: id, beat_id: beatId, decision, dialogue_focus_quotes: decision === 'KEEP_DIALOGUE' ? ['a line'] : [], ...extra
});

test('a heavy beat left out of the cut is rejected with its summary', () => {
  const plan = {
    timeline: [
      slot('slot_01', 'beat_02', 'KEEP_DIALOGUE'),
      slot('slot_02', 'beat_03', 'DROP'),
      slot('slot_03', 'beat_04', 'KEEP_DIALOGUE'),
      slot('slot_04', 'beat_06', 'KEEP_DIALOGUE')
    ]
  };
  assert.throws(() => _test.validateEditPlanAgainstBeats(plan, BEATS), /beat_03.*staircase/s);
});

test('a beat with no dialogue counts as covered when a narration slot plays over its footage', () => {
  const plan = {
    timeline: [
      slot('slot_01', 'beat_02', 'KEEP_DIALOGUE'),
      slot('slot_02', 'beat_02', 'NARRATE', { visual_source_start_sec: 100, visual_source_end_sec: 130 }),
      slot('slot_03', 'beat_04', 'KEEP_DIALOGUE'),
      slot('slot_04', 'beat_06', 'KEEP_DIALOGUE')
    ]
  };
  assert.doesNotThrow(() => _test.validateEditPlanAgainstBeats(plan, BEATS));
});

test('keeping the heavy beat as its own slot passes', () => {
  const plan = {
    timeline: [
      slot('slot_01', 'beat_02', 'KEEP_DIALOGUE'),
      slot('slot_02', 'beat_03', 'NARRATE'),
      slot('slot_03', 'beat_04', 'KEEP_DIALOGUE'),
      slot('slot_04', 'beat_06', 'KEEP_DIALOGUE')
    ]
  };
  assert.doesNotThrow(() => _test.validateEditPlanAgainstBeats(plan, BEATS));
});

test('a light beat may still be dropped', () => {
  const plan = {
    timeline: [
      slot('slot_01', 'beat_02', 'KEEP_DIALOGUE'),
      slot('slot_02', 'beat_03', 'NARRATE'),
      slot('slot_03', 'beat_04', 'KEEP_DIALOGUE'),
      slot('slot_04', 'beat_06', 'DROP')
    ]
  };
  assert.doesNotThrow(() => _test.validateEditPlanAgainstBeats(plan, BEATS));
});
