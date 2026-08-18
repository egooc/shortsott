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

// Arc necessity is the FIRST criterion inside every trim stage (owner principle 2026-08-18), not
// just a veto list: a transition seam shrinks before the narration that states a causal event, and
// the protected peak's lines are never shaved.
test('the narration shrink takes the transition seam before the causal event narration', () => {
  const beats = [
    { beat_id: 'B_EVENT', start_sec: 100, end_sec: 130, dramatic_weight: 5, summary: 'the killing' },
    { beat_id: 'B_SEAM', start_sec: 200, end_sec: 220, dramatic_weight: 2, summary: 'transition' }
  ];
  const plan = {
    timeline: [
      { slot_id: 's1', beat_id: 'B_EVENT', role: 'cold_open', decision: 'KEEP_DIALOGUE', estimated_duration_sec: 4,
        dialogue_focus_lines: ['hook'], dialogue_focus_quotes: ['hook'],
        dialogue_line_windows: [{ matched: true, line: 'hook', start_sec: 100, end_sec: 104 }] },
      { slot_id: 's2', beat_id: 'B_EVENT', role: 'bridge', decision: 'NARRATE', estimated_duration_sec: 8 },
      // The event narration: same length as the seam, but on a causal beat.
      { slot_id: 's3', beat_id: 'B_EVENT', role: 'body', decision: 'NARRATE', estimated_duration_sec: 10 },
      { slot_id: 's4', beat_id: 'B_SEAM', role: 'body', decision: 'NARRATE', estimated_duration_sec: 10 }
    ]
  };
  const trimmed = _test.finalizeEditPlan(plan, beats, [], 26).timeline;
  const eventNarr = trimmed.find((item) => item.slot_id === 's3');
  const seamNarr = trimmed.find((item) => item.slot_id === 's4');
  // The seam must have given up MORE than the event narration.
  assert.ok(Number(seamNarr.estimated_duration_sec) <= Number(eventNarr.estimated_duration_sec),
    `seam ${seamNarr.estimated_duration_sec}s should shrink before event ${eventNarr.estimated_duration_sec}s`);
});

test('the line shave never takes a line out of the protected peak', () => {
  const win = (start, end, line) => ({ matched: true, start_sec: start, end_sec: end, line });
  const beats = [{ beat_id: 'B1', start_sec: 90, end_sec: 130, dramatic_weight: 3, key_dialogue: [], anchor_dialogue: [] }];
  const plan = {
    timeline: [
      { slot_id: 's1', beat_id: 'B1', role: 'cold_open', decision: 'KEEP_DIALOGUE', estimated_duration_sec: 3,
        dialogue_focus_lines: ['hook'], dialogue_focus_quotes: ['hook'],
        dialogue_line_windows: [{ matched: true, line: 'hook', start_sec: 90, end_sec: 93 }] },
      { slot_id: 's2', beat_id: 'B1', role: 'bridge', decision: 'NARRATE', estimated_duration_sec: 4 },
      { slot_id: 's3', beat_id: 'B1', role: 'body', decision: 'KEEP_DIALOGUE', estimated_duration_sec: 12,
        protected_peak: true,
        dialogue_focus_lines: ['a', 'b', 'c'], dialogue_focus_quotes: ['a', 'b', 'c'],
        dialogue_line_windows: [win(100, 104, 'a'), win(104, 108, 'b'), win(108, 112, 'c')] }
    ]
  };
  const trimmed = _test.finalizeEditPlan(plan, beats, [], 10).timeline;
  const peak = trimmed.find((item) => item.slot_id === 's3');
  assert.equal((peak.dialogue_line_windows || []).filter((entry) => entry.matched === true).length, 3,
    'all three peak lines survive the runtime squeeze');
});
